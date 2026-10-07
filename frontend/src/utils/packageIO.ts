/**
 * 离线包组装 / 解析 / 对回与合并计划（纯函数，不直接写库）。
 * - 按道岔、日期和部件对回病害（id → 道岔+日期+部件+类型）
 * - 确认前提校验：病害归属与作业单引用同时成立才允许写入正式台账
 * - 等级 / 销号 / 作业编排不一致时生成冲突项，保留两份逐项核准
 * - 旧备份（缺少包标识）生成迁移清单，核对后再迁入接收区
 */
import type { Inspection } from '../types/inspection';
import type { Fault } from '../types/fault';
import { FAULT_PART_LABEL, FAULT_SEVERITY_LABEL, FAULT_TYPE_LABEL } from '../types/fault';
import type { WorkOrder } from '../types/workOrder';
import { WORK_ORDER_STATE_LABEL } from '../types/workOrder';
import type { Switch } from '../types/switch';
import {
  PACKAGE_FORMAT,
  type ConflictItem,
  type MigrationItem,
  type MigrationManifest,
  type OfflinePackageFile,
  type OfflinePackagePayload,
  type PackageSwitchRef,
  type SyncPackageRow,
} from '../types/syncPackage';
import { ROW_REVISION } from '../types/persistence';
import { isOverlap } from './window';
import { nowIso, uuid } from './format';

/** 台账数据（合并计划与校验的只读输入） */
export interface LedgerData {
  switches: Switch[];
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
}

/** 旧版整库备份（缺少包标识）的最小结构 */
export interface LegacySnapshot {
  exportedAt?: string;
  yards?: Array<{ id: string; name: string }>;
  switches?: Array<{ id: string; yardId: string; code: string }>;
  inspections?: Inspection[];
  faults?: Fault[];
  workOrders?: WorkOrder[];
}

/** 生成包标识 */
export function buildPackageId(crew: string): string {
  const stamp = nowIso().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `pkg-${crew}-${stamp}-${uuid().slice(-4)}`;
}

/** 导出离线包：把当前台账数据打包给班组离线携带 */
export function buildPackageFile(
  crew: string,
  data: LedgerData & { yards: Array<{ id: string; name: string }> },
): OfflinePackageFile {
  return {
    format: PACKAGE_FORMAT,
    packageId: buildPackageId(crew),
    crew,
    exportedAt: nowIso(),
    inspections: data.inspections,
    faults: data.faults,
    workOrders: data.workOrders,
    switches: data.switches.map((item) => ({
      id: item.id,
      code: item.code,
      yardId: item.yardId,
      yardName: data.yards.find((yard) => yard.id === item.yardId)?.name ?? '',
    })),
  };
}

export type IncomingParse =
  | { kind: 'package'; file: OfflinePackageFile }
  | { kind: 'legacy'; snapshot: LegacySnapshot }
  | { kind: 'invalid'; reason: string };

/** 解析接收到的 JSON：离线包 / 旧备份 / 无法识别 */
export function parseIncoming(text: string): IncomingParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: '文件不是有效的 JSON' };
  }
  if (!raw || typeof raw !== 'object') return { kind: 'invalid', reason: '文件内容不是对象' };
  const candidate = raw as Record<string, unknown>;
  if (candidate.format === PACKAGE_FORMAT) {
    if (typeof candidate.packageId !== 'string' || !candidate.packageId) {
      return { kind: 'invalid', reason: '离线包缺少包标识 packageId' };
    }
    const file = candidate as unknown as OfflinePackageFile;
    return {
      kind: 'package',
      file: {
        ...file,
        crew: typeof file.crew === 'string' && file.crew ? file.crew : '未标注班组',
        inspections: Array.isArray(file.inspections) ? file.inspections : [],
        faults: Array.isArray(file.faults) ? file.faults : [],
        workOrders: Array.isArray(file.workOrders) ? file.workOrders : [],
        switches: Array.isArray(file.switches) ? file.switches : [],
      },
    };
  }
  // 旧备份：有站场 / 道岔数组但没有包标识
  if (
    Array.isArray(candidate.yards) &&
    Array.isArray(candidate.switches) &&
    typeof candidate.packageId !== 'string'
  ) {
    return { kind: 'legacy', snapshot: candidate as unknown as LegacySnapshot };
  }
  return { kind: 'invalid', reason: '无法识别的文件：既不是离线包也不是整库备份' };
}

/** 离线包文件 → 接收区行（初始状态：待核准） */
export function packageRowFromFile(file: OfflinePackageFile, tabId: string): SyncPackageRow {
  const stamp = nowIso();
  return {
    id: file.packageId,
    crew: file.crew,
    source: 'crew',
    status: 'received',
    payload: {
      inspections: file.inspections,
      faults: file.faults,
      workOrders: file.workOrders,
      switches: file.switches,
    },
    exportedAt: file.exportedAt,
    receivedAt: stamp,
    receivedByTab: tabId,
    appliedInspectionIds: [],
    appliedFaultIds: [],
    appliedOrderIds: [],
    conflicts: [],
    stopReason: '',
    applyOwner: null,
    applyLeaseUntil: 0,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
}

/** 旧备份 → 离线包载荷（只取巡检 / 病害 / 作业单，站场道岔以台账为准） */
export function legacyToPayload(snapshot: LegacySnapshot): OfflinePackagePayload {
  const yards = snapshot.yards ?? [];
  return {
    inspections: snapshot.inspections ?? [],
    faults: snapshot.faults ?? [],
    workOrders: snapshot.workOrders ?? [],
    switches: (snapshot.switches ?? []).map((item) => ({
      id: item.id,
      code: item.code,
      yardId: item.yardId,
      yardName: yards.find((yard) => yard.id === item.yardId)?.name ?? '',
    })),
  };
}

/** 迁移清单核对通过后生成接收区行（source=legacy，走同一核准合并流程） */
export function legacyPackageRow(
  manifest: MigrationManifest,
  payload: OfflinePackagePayload,
  tabId: string,
): SyncPackageRow {
  const stamp = nowIso();
  return {
    id: manifest.packageId,
    crew: '旧备份迁移',
    source: 'legacy',
    status: 'received',
    payload,
    exportedAt: manifest.exportedAt,
    receivedAt: stamp,
    receivedByTab: tabId,
    appliedInspectionIds: [],
    appliedFaultIds: [],
    appliedOrderIds: [],
    conflicts: [],
    stopReason: '',
    applyOwner: null,
    applyLeaseUntil: 0,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
}

/** 道岔对回：先按 id，再按包内目录的 站场+编号，最后按全台账唯一编号 */
export function resolveLedgerSwitch(
  switchId: string,
  directory: PackageSwitchRef[],
  ledgerSwitches: Switch[],
): Switch | undefined {
  const byId = ledgerSwitches.find((item) => item.id === switchId);
  if (byId) return byId;
  const ref = directory.find((item) => item.id === switchId);
  if (!ref) return undefined;
  const byYardCode = ledgerSwitches.find((item) => item.yardId === ref.yardId && item.code === ref.code);
  if (byYardCode) return byYardCode;
  const byCode = ledgerSwitches.filter((item) => item.code === ref.code);
  return byCode.length === 1 ? byCode[0] : undefined;
}

export interface OwnershipIssue {
  faultId: string;
  reason: string;
}

export interface ReferenceIssue {
  orderId: string;
  orderCode: string;
  reason: string;
}

export interface PackageValidation {
  ok: boolean;
  ownership: OwnershipIssue[];
  references: ReferenceIssue[];
}

/**
 * 确认前提：病害归属与作业单引用同时成立才允许写入正式台账。
 * - 病害归属：每条病害的巡检随包提供或台账已存在，且巡检道岔能在台账对回
 * - 作业单引用：每张作业单引用的病害在台账或包内存在
 */
export function validatePackage(payload: OfflinePackagePayload, ledger: LedgerData): PackageValidation {
  const ownership: OwnershipIssue[] = [];
  const references: ReferenceIssue[] = [];
  const pkgInspectionById = new Map(payload.inspections.map((item) => [item.id, item]));
  const ledgerInspectionIds = new Set(ledger.inspections.map((item) => item.id));
  const ledgerFaultIds = new Set(ledger.faults.map((item) => item.id));
  const pkgFaultIds = new Set(payload.faults.map((item) => item.id));

  for (const fault of payload.faults) {
    const pkgInspection = pkgInspectionById.get(fault.inspectionId);
    if (pkgInspection) {
      const target = resolveLedgerSwitch(pkgInspection.switchId, payload.switches, ledger.switches);
      if (!target) {
        const ref = payload.switches.find((item) => item.id === pkgInspection.switchId);
        ownership.push({
          faultId: fault.id,
          reason: `病害 ${fault.id} 归属道岔 ${ref?.code ?? pkgInspection.switchId} 不在台账`,
        });
      }
      continue;
    }
    if (!ledgerInspectionIds.has(fault.inspectionId)) {
      ownership.push({
        faultId: fault.id,
        reason: `病害 ${fault.id} 所属巡检 ${fault.inspectionId} 未随包提供且台账不存在`,
      });
    }
  }

  for (const order of payload.workOrders) {
    for (const faultId of order.faultIds) {
      if (!ledgerFaultIds.has(faultId) && !pkgFaultIds.has(faultId)) {
        references.push({
          orderId: order.id,
          orderCode: order.code,
          reason: `作业单 ${order.code} 引用未知病害 ${faultId}`,
        });
      }
    }
  }

  return { ok: ownership.length === 0 && references.length === 0, ownership, references };
}

/** 合并计划：confirmPackage 据此逐条落库 */
export interface MergePlan {
  /** 待插入巡检（switchId 已按对回结果重映射） */
  inspections: Inspection[];
  /** 待插入病害（inspectionId 已重映射） */
  faults: Fault[];
  /** 待插入作业单（faultIds 已重映射，且无编排冲突） */
  orders: WorkOrder[];
  /** 新发现的冲突（与接收区已有冲突按 id 合并，保留已核准结果） */
  conflicts: ConflictItem[];
  /** 对回一致、无需写入的记录 id（直接推进游标） */
  reconciledInspectionIds: string[];
  reconciledFaultIds: string[];
  reconciledOrderIds: string[];
}

/** 已应用游标（断点恢复时跳过这些记录） */
export interface AppliedCursor {
  inspectionIds: string[];
  faultIds: string[];
  orderIds: string[];
}

function faultLabelOf(switchCode: string, date: string, fault: Fault): string {
  return `${switchCode} · ${date} · ${FAULT_PART_LABEL[fault.part]}·${FAULT_TYPE_LABEL[fault.type]}`;
}

function solvedText(state: Fault['state'], solvedAt: string | null): string {
  return state === 'solved' ? `已销号 ${solvedAt ?? ''}`.trim() : '待修';
}

function orderSummaryText(order: WorkOrder): string {
  return `${order.code} ${order.windowStart}~${order.windowEnd.slice(-5)} · 负责人 ${order.leader} · ${
    WORK_ORDER_STATE_LABEL[order.state]
  } · 病害 ${order.faultIds.length} 处`;
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/** 对回命中的作业单内容是否不一致（时间窗 / 负责人 / 人员 / 机具 / 病害 / 状态） */
function orderDiffers(ledgerOrder: WorkOrder, pkgOrder: WorkOrder, remappedFaultIds: string[]): boolean {
  if (ledgerOrder.windowStart !== pkgOrder.windowStart) return true;
  if (ledgerOrder.windowEnd !== pkgOrder.windowEnd) return true;
  if (ledgerOrder.leader !== pkgOrder.leader) return true;
  if (ledgerOrder.state !== pkgOrder.state) return true;
  if (!sameStringSet(ledgerOrder.members, pkgOrder.members)) return true;
  if (!sameStringSet(ledgerOrder.machines, pkgOrder.machines)) return true;
  if (!sameStringSet(ledgerOrder.faultIds, remappedFaultIds)) return true;
  return false;
}

/** 等级 / 销号不一致 → 生成冲突项；返回是否产生冲突 */
function diffFaultForConflicts(
  ledgerFault: Fault,
  pkgFault: Fault,
  label: string,
  conflicts: ConflictItem[],
): boolean {
  let had = false;
  if (ledgerFault.severity !== pkgFault.severity) {
    conflicts.push({
      id: `sev:${pkgFault.id}`,
      kind: 'severity',
      targetId: ledgerFault.id,
      packageRecordId: pkgFault.id,
      label,
      ledgerValue: FAULT_SEVERITY_LABEL[ledgerFault.severity],
      packageValue: FAULT_SEVERITY_LABEL[pkgFault.severity],
      resolution: 'pending',
    });
    had = true;
  }
  if (ledgerFault.state !== pkgFault.state) {
    conflicts.push({
      id: `sol:${pkgFault.id}`,
      kind: 'solved',
      targetId: ledgerFault.id,
      packageRecordId: pkgFault.id,
      label,
      ledgerValue: solvedText(ledgerFault.state, ledgerFault.solvedAt),
      packageValue: solvedText(pkgFault.state, pkgFault.solvedAt),
      resolution: 'pending',
    });
    had = true;
  }
  return had;
}

/**
 * 合并计划：按道岔、日期和部件对回病害。
 * 对回命中的记录只比较不覆盖；等级 / 销号 / 作业编排不一致时生成冲突项，
 * 保留台账与包内两份逐项核准，绝不拿后导入的整条记录直接盖掉台账。
 */
export function planMerge(payload: OfflinePackagePayload, ledger: LedgerData, applied: AppliedCursor): MergePlan {
  const switchIdMap = new Map<string, string>();
  const inspectionIdMap = new Map<string, string>();
  const faultIdMap = new Map<string, string>();
  const inspections: Inspection[] = [];
  const faults: Fault[] = [];
  const orders: WorkOrder[] = [];
  const conflicts: ConflictItem[] = [];
  const reconciledInspectionIds: string[] = [];
  const reconciledFaultIds: string[] = [];
  const reconciledOrderIds: string[] = [];

  /* ---- 巡检对回：id → 道岔+日期；新巡检的道岔 id 先重映射到台账 ----
     注意：无论是否已应用都要重建映射（断点恢复时下游病害 / 作业单引用依赖它），
     游标只控制「是否再插入 / 再计入 reconcile」。 */
  for (const pkgInspection of payload.inspections) {
    const targetSwitch = resolveLedgerSwitch(pkgInspection.switchId, payload.switches, ledger.switches);
    if (targetSwitch && targetSwitch.id !== pkgInspection.switchId) {
      switchIdMap.set(pkgInspection.switchId, targetSwitch.id);
    }
    const mappedSwitchId = switchIdMap.get(pkgInspection.switchId) ?? pkgInspection.switchId;
    const alreadyApplied = applied.inspectionIds.includes(pkgInspection.id);
    const byId = ledger.inspections.find((item) => item.id === pkgInspection.id);
    if (byId) {
      inspectionIdMap.set(pkgInspection.id, byId.id);
      if (!alreadyApplied) reconciledInspectionIds.push(pkgInspection.id);
      continue;
    }
    const byKey = ledger.inspections.find(
      (item) => item.switchId === mappedSwitchId && item.date === pkgInspection.date,
    );
    if (byKey) {
      inspectionIdMap.set(pkgInspection.id, byKey.id);
      if (!alreadyApplied) reconciledInspectionIds.push(pkgInspection.id);
      continue;
    }
    inspectionIdMap.set(pkgInspection.id, pkgInspection.id);
    if (!alreadyApplied) {
      inspections.push({ ...pkgInspection, switchId: mappedSwitchId });
    }
  }

  /* ---- 病害对回：id → 巡检（道岔+日期）内按 部件+类型 唯一匹配 ---- */
  const ledgerFaultById = new Map(ledger.faults.map((item) => [item.id, item]));
  const ledgerFaultsByInspection = new Map<string, Fault[]>();
  for (const item of ledger.faults) {
    const list = ledgerFaultsByInspection.get(item.inspectionId) ?? [];
    list.push(item);
    ledgerFaultsByInspection.set(item.inspectionId, list);
  }
  const consumed = new Set<string>();
  const inspectionById = new Map(ledger.inspections.map((item) => [item.id, item]));
  const switchById = new Map(ledger.switches.map((item) => [item.id, item]));

  const describeMatched = (ledgerFault: Fault, pkgFault: Fault): string => {
    const inspection = inspectionById.get(ledgerFault.inspectionId);
    const target = inspection ? switchById.get(inspection.switchId) : undefined;
    return faultLabelOf(target?.code ?? '未知道岔', inspection?.date ?? '-', pkgFault);
  };

  for (const pkgFault of payload.faults) {
    const mappedInspectionId = inspectionIdMap.get(pkgFault.inspectionId) ?? pkgFault.inspectionId;
    const alreadyApplied = applied.faultIds.includes(pkgFault.id);

    const byId = ledgerFaultById.get(pkgFault.id);
    if (byId) {
      faultIdMap.set(pkgFault.id, byId.id);
      if (!alreadyApplied) {
        const hadConflict = diffFaultForConflicts(byId, pkgFault, describeMatched(byId, pkgFault), conflicts);
        if (!hadConflict) reconciledFaultIds.push(pkgFault.id);
      }
      continue;
    }
    const candidates = (ledgerFaultsByInspection.get(mappedInspectionId) ?? []).filter(
      (item) => item.part === pkgFault.part && item.type === pkgFault.type && !consumed.has(item.id),
    );
    const matched = candidates[0];
    if (matched) {
      consumed.add(matched.id);
      faultIdMap.set(pkgFault.id, matched.id);
      if (!alreadyApplied) {
        const hadConflict = diffFaultForConflicts(matched, pkgFault, describeMatched(matched, pkgFault), conflicts);
        if (!hadConflict) reconciledFaultIds.push(pkgFault.id);
      }
      continue;
    }
    // 新病害：随包插入（inspectionId 已重映射）
    faultIdMap.set(pkgFault.id, pkgFault.id);
    if (!alreadyApplied) {
      faults.push({ ...pkgFault, inspectionId: mappedInspectionId });
    }
  }

  /* ---- 作业单对回：id → 编号；新单做时间窗+人员+机具占用检测 ---- */
  const remapFaultIds = (ids: string[]): string[] => [...new Set(ids.map((id) => faultIdMap.get(id) ?? id))];
  const ledgerOrderById = new Map(ledger.workOrders.map((item) => [item.id, item]));
  const ledgerOrderByCode = new Map(ledger.workOrders.map((item) => [item.code, item]));

  for (const pkgOrder of payload.workOrders) {
    if (applied.orderIds.includes(pkgOrder.id)) continue;
    const remapped = remapFaultIds(pkgOrder.faultIds);
    const matched = ledgerOrderById.get(pkgOrder.id) ?? ledgerOrderByCode.get(pkgOrder.code);
    if (matched) {
      if (orderDiffers(matched, pkgOrder, remapped)) {
        conflicts.push({
          id: `ord:${pkgOrder.id}`,
          kind: 'schedule',
          targetId: matched.id,
          packageRecordId: pkgOrder.id,
          label: `作业单 ${matched.code}`,
          ledgerValue: orderSummaryText(matched),
          packageValue: orderSummaryText({ ...pkgOrder, faultIds: remapped }),
          resolution: 'pending',
          scheduleAction: 'update',
          remappedFaultIds: remapped,
        });
      } else {
        reconciledOrderIds.push(pkgOrder.id);
      }
      continue;
    }
    const occupancy = ledger.workOrders.filter(
      (item) =>
        isOverlap(item, pkgOrder) &&
        (item.members.some((member) => pkgOrder.members.includes(member)) ||
          item.machines.some((machine) => pkgOrder.machines.includes(machine))),
    );
    if (occupancy.length > 0) {
      conflicts.push({
        id: `ord:${pkgOrder.id}`,
        kind: 'schedule',
        targetId: occupancy[0].id,
        packageRecordId: pkgOrder.id,
        label: `新作业单 ${pkgOrder.code}`,
        ledgerValue: `台账占用：${occupancy.map((item) => item.code).join('、')}`,
        packageValue: orderSummaryText({ ...pkgOrder, faultIds: remapped }),
        resolution: 'pending',
        scheduleAction: 'insert',
        remappedFaultIds: remapped,
      });
      continue;
    }
    orders.push({ ...pkgOrder, faultIds: remapped });
  }

  return { inspections, faults, orders, conflicts, reconciledInspectionIds, reconciledFaultIds, reconciledOrderIds };
}

/** 旧备份迁移清单：缺少包标识的备份先列清单核对再应用 */
export function buildMigrationManifest(
  snapshot: LegacySnapshot,
  packageId: string,
  ledger: LedgerData,
): { manifest: MigrationManifest; payload: OfflinePackagePayload } {
  const payload = legacyToPayload(snapshot);
  const validation = validatePackage(payload, ledger);
  const ownershipByFault = new Map(validation.ownership.map((item) => [item.faultId, item.reason]));
  const referenceByOrder = new Map<string, string[]>();
  for (const item of validation.references) {
    const list = referenceByOrder.get(item.orderId) ?? [];
    list.push(item.reason);
    referenceByOrder.set(item.orderId, list);
  }

  const switchCodeOf = (switchId: string): string => {
    const target = resolveLedgerSwitch(switchId, payload.switches, ledger.switches);
    if (target) return target.code;
    return payload.switches.find((item) => item.id === switchId)?.code ?? switchId;
  };
  const inspectionById = new Map(payload.inspections.map((item) => [item.id, item]));

  const items: MigrationItem[] = [
    ...payload.inspections.map((item) => ({
      kind: 'inspection' as const,
      id: item.id,
      label: `${switchCodeOf(item.switchId)} · ${item.date} · ${item.inspector}`,
      issue: resolveLedgerSwitch(item.switchId, payload.switches, ledger.switches) ? null : '归属道岔不在台账',
    })),
    ...payload.faults.map((item) => {
      const inspection = inspectionById.get(item.inspectionId);
      const place = inspection ? `${switchCodeOf(inspection.switchId)} · ${inspection.date}` : item.inspectionId;
      return {
        kind: 'fault' as const,
        id: item.id,
        label: `${place} · ${FAULT_PART_LABEL[item.part]}·${FAULT_TYPE_LABEL[item.type]}`,
        issue: ownershipByFault.get(item.id) ?? null,
      };
    }),
    ...payload.workOrders.map((item) => ({
      kind: 'workOrder' as const,
      id: item.id,
      label: orderSummaryText(item),
      issue: referenceByOrder.get(item.id)?.join('；') ?? null,
    })),
  ];

  return {
    manifest: {
      packageId,
      exportedAt: typeof snapshot.exportedAt === 'string' ? snapshot.exportedAt : '',
      inspections: payload.inspections.length,
      faults: payload.faults.length,
      workOrders: payload.workOrders.length,
      issueCount: items.filter((item) => item.issue).length,
      items,
    },
    payload,
  };
}
