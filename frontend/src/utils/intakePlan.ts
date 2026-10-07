/**
 * 离线包合并计划引擎（纯函数，不碰 IndexedDB，便于单测与失败后重算）
 *
 * 职责：
 * 1. 解析离线包 / 归一化旧备份；
 * 2. 按「道岔（站场名+道岔号）+ 巡检日期 + 部件」把交回病害对回台账；
 * 3. 找出等级 / 销号 / 作业编排冲突，两份内容并排保留，默认一律不决定（禁止后导入整条覆盖）；
 * 4. 核算两道闸门：病害归属（能落到道岔）、作业单引用（引用病害都能解析）；
 * 5. 给出确定性的新行 id / 并存作业单改挂编号，写入中断后重算计划保持稳定。
 */
import type { Fault, FaultPart, FaultSeverity, FaultState } from '../types/fault';
import { FAULT_PART_LABEL, FAULT_SEVERITY_LABEL, FAULT_STATE_LABEL, FAULT_TYPE_LABEL } from '../types/fault';
import type { Inspection } from '../types/inspection';
import type { Switch } from '../types/switch';
import type { Yard } from '../types/yard';
import type { WorkOrder } from '../types/workOrder';
import { WORK_ORDER_STATE_LABEL } from '../types/workOrder';
import { ROW_REVISION } from '../types/persistence';
import { isOverlap } from './window';
import {
  INTAKE_PACKAGE_KIND,
  INTAKE_PACKAGE_VERSION,
  type IntakeBatch,
  type IntakeConflict,
  type IntakeDecision,
  type IntakeGate,
  type IntakeItem,
  type IntakeItemKind,
  type IntakePayload,
  type LedgerSnapshot,
  type MigrationCheckItem,
  type OfflinePack,
} from '../types/intake';

/* ------------------------------- 哈希 / 标识 ------------------------------- */

/** 稳定 JSON：键排序，保证同样内容任何设备算出同一哈希（多标签 / 多机去重） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** 64 位 FNV-1a 风格哈希，返回 13 位 base36 字符串，足够离线包去重 */
export function contentHash(value: unknown): string {
  const text = stableStringify(value);
  let hi = 0x811c9dc5;
  let lo = 0x19660d47;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hi ^= code;
    lo ^= code;
    hi = Math.imul(hi, 0x01000193) >>> 0;
    lo = (Math.imul(lo, 0x01000193) ^ (hi >>> 7)) >>> 0;
  }
  return (hi.toString(36) + lo.toString(36)).padStart(13, '0').slice(0, 13);
}

/** 条目在计划里的稳定 id */
function itemId(batchKind: string, kind: IntakeItemKind, localId: string): string {
  return `${batchKind}:${seqBase(kind)}:${kind}:${localId}`;
}

function seqBase(kind: IntakeItemKind): number {
  switch (kind) {
    case 'yard':
      return 100000;
    case 'switch':
      return 200000;
    case 'inspection':
      return 300000;
    case 'fault':
      return 400000;
    case 'workOrder':
      return 500000;
  }
}

/** 新行确定性 id：同包同条目重算结果一致（断点续传不会换 id） */
function assignedId(batchHash: string, prefix: string, localId: string): string {
  return `${prefix}-off-${batchHash.slice(0, 6)}${contentHash(localId).slice(-6)}`;
}

/* -------------------------------- 摘要文案 -------------------------------- */

function faultSummaryText(
  ctx: string,
  fault: Pick<Fault, 'part' | 'type' | 'severity' | 'state'>,
): string {
  return `${ctx} ${FAULT_PART_LABEL[fault.part]}·${FAULT_TYPE_LABEL[fault.type]} 等级${
    FAULT_SEVERITY_LABEL[fault.severity]
  }·${FAULT_STATE_LABEL[fault.state]}`;
}

function orderSummaryText(order: Pick<WorkOrder, 'code' | 'windowStart' | 'windowEnd' | 'leader' | 'members' | 'machines' | 'state'>): string {
  return `${order.code} ${order.windowStart}~${order.windowEnd.slice(-5)} 负责 ${order.leader}｜人员 ${
    order.members.join('、') || '—'
  }｜机具 ${order.machines.join('、') || '—'}｜${WORK_ORDER_STATE_LABEL[order.state]}`;
}

/* -------------------------------- 计划入参 -------------------------------- */

export interface PlanInput {
  packageId: string;
  contentHash: string;
  shift: string;
  yards: Yard[];
  switches: Switch[];
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
}

interface PriorChoices {
  decisions: Record<string, IntakeDecision>;
  overrides: Record<string, string>;
}

/**
 * 对回键：站场名 + 道岔号 + 巡检日期 + 部件。
 * 道岔编号在同一站场内唯一，站场名做命名空间，避免两个所的 3# 道岔错对。
 */
function faultKey(yardName: string, switchCode: string, date: string, part: FaultPart): string {
  return `${yardName}｜${switchCode}｜${date}｜${part}`;
}

interface ResolvedContext {
  yardName: string;
  switchCode: string;
  date: string;
}

function shiftSuffix(shift: string): string {
  const marker = shift.includes('乙') ? '乙' : '甲';
  return marker;
}

/** 归一化旧备份行：旧字段名 faultType/faultPart、字符串 faultIds、缺 revision 等 */
export function normalizeLegacySnapshot(raw: unknown): {
  yards: Yard[];
  switches: Switch[];
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
} {
  const snap = (raw ?? {}) as Record<string, unknown[]>;
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const stamp = new Date(0).toISOString();

  const yards = asArray(snap.yards).map((row) => {
    const r = row as Yard;
    return { ...r, revision: ROW_REVISION, createdAt: r.createdAt ?? stamp };
  });
  const switches = asArray(snap.switches).map((row) => {
    const r = row as Switch;
    return { ...r, revision: ROW_REVISION, createdAt: r.createdAt ?? stamp };
  });
  const inspections = asArray(snap.inspections).map((row) => {
    const r = row as Inspection;
    return { ...r, revision: ROW_REVISION, createdAt: r.createdAt ?? stamp };
  });
  const faults = asArray(snap.faults).map((row) => {
    const r = row as Record<string, unknown> & Fault;
    const type = (typeof r.type === 'string' ? r.type : r.faultType) as Fault['type'];
    const part = (typeof r.part === 'string' ? r.part : r.faultPart) as Fault['part'];
    return {
      ...r,
      type,
      part,
      sizeMm: typeof r.sizeMm === 'number' ? r.sizeMm : null,
      solvedAt: typeof r.solvedAt === 'string' ? r.solvedAt : null,
      revision: ROW_REVISION,
      createdAt: r.createdAt ?? stamp,
    };
  });
  const workOrders = asArray(snap.workOrders).map((row) => {
    const r = row as Record<string, unknown> & WorkOrder;
    const faultIds = Array.isArray(r.faultIds)
      ? r.faultIds
      : typeof r.faultIds === 'string'
        ? String(r.faultIds).split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    return {
      ...r,
      faultIds,
      members: Array.isArray(r.members) ? r.members : [],
      machines: Array.isArray(r.machines) ? r.machines : [],
      revision: ROW_REVISION,
      createdAt: r.createdAt ?? stamp,
      updatedAt: r.updatedAt ?? r.createdAt ?? stamp,
    };
  });
  return { yards, switches, inspections, faults, workOrders };
}

/** 旧备份迁移核对清单：先列清单核对，勾完才允许生成合并计划 */
export function buildMigrationChecks(raw: unknown): MigrationCheckItem[] {
  const snap = (raw ?? {}) as Record<string, unknown>;
  const arr = (key: string): unknown[] => (Array.isArray(snap[key]) ? (snap[key] as unknown[]) : []);
  const checks: MigrationCheckItem[] = [];
  const hasPackId = typeof snap.packageId === 'string' && snap.packageId.length > 0;
  checks.push({
    key: 'no-pack-id',
    label: '该备份缺少包标识（packageId）',
    detail: hasPackId ? '实际检测到 packageId，可按普通离线包处理' : '旧整库导出无包标识，将按内容哈希登记，并按道岔/日期/部件对回',
    level: hasPackId ? 'ok' : 'warn',
    checked: false,
  });
  const legacyFaultFields = arr('faults').filter((row) => {
    const r = row as Record<string, unknown>;
    return typeof r.faultType === 'string' || typeof r.faultPart === 'string';
  }).length;
  checks.push({
    key: 'legacy-fault-fields',
    label: '旧字段名迁移（faultType→type、faultPart→part）',
    detail:
      legacyFaultFields > 0
        ? `${legacyFaultFields} 条病害使用旧字段名，应用前自动转换`
        : '未发现旧字段名，无需转换',
    level: legacyFaultFields > 0 ? 'warn' : 'ok',
    checked: false,
  });
  const stringFaultIds = arr('workOrders').filter((row) => typeof (row as Record<string, unknown>).faultIds === 'string').length;
  checks.push({
    key: 'legacy-faultids',
    label: '作业单 faultIds 旧格式（逗号字符串→数组）',
    detail: stringFaultIds > 0 ? `${stringFaultIds} 张作业单需要拆分 faultIds` : 'faultIds 均为数组',
    level: stringFaultIds > 0 ? 'warn' : 'ok',
    checked: false,
  });
  const { faults, inspections, workOrders, switches, yards } = normalizeLegacySnapshot(raw);
  const inspectionIds = new Set(inspections.map((row) => row.id));
  const switchIds = new Set(switches.map((row) => row.id));
  const orphanFaults = faults.filter((row) => !inspectionIds.has(row.inspectionId)).length;
  const orphanInspections = inspections.filter((row) => !switchIds.has(row.switchId)).length;
  checks.push({
    key: 'orphan-faults',
    label: '孤儿病害（巡检不存在）',
    detail: orphanFaults > 0 ? `${orphanFaults} 条病害找不到所属巡检，归属闸门会拦截` : '无孤儿病害',
    level: orphanFaults > 0 ? 'danger' : 'ok',
    checked: false,
  });
  checks.push({
    key: 'orphan-inspections',
    label: '孤儿巡检（道岔不存在）',
    detail:
      orphanInspections > 0 ? `${orphanInspections} 条巡检找不到道岔，需人工指定归属或剔除` : '无孤儿巡检',
    level: orphanInspections > 0 ? 'danger' : 'ok',
    checked: false,
  });
  const faultIdsAll = new Set(faults.map((row) => row.id));
  const brokenOrders = workOrders
    .map((order) => ({ code: order.code, missing: order.faultIds.filter((id) => !faultIdsAll.has(id)).length }))
    .filter((item) => item.missing > 0);
  checks.push({
    key: 'broken-refs',
    label: '作业单引用断裂核对',
    detail:
      brokenOrders.length > 0
        ? `${brokenOrders.length} 张作业单引用了包内不存在的病害：${brokenOrders
            .map((item) => `${item.code}(${item.missing})`)
            .join('、')}`
        : '作业单引用在包内完整（对回台账后还会复核一次）',
    level: brokenOrders.length > 0 ? 'danger' : 'ok',
    checked: false,
  });
  const yardCount = yards.length;
  checks.push({
    key: 'row-counts',
    label: '记录条数核对',
    detail: `站场 ${yards.length} · 道岔 ${switches.length} · 巡检 ${inspections.length} · 病害 ${faults.length} · 作业单 ${workOrders.length}`,
    level: yardCount > 0 ? 'ok' : 'danger',
    checked: false,
  });
  return checks;
}

/** 是否为带标识的离线包 */
export function isOfflinePack(value: unknown): value is OfflinePack {
  const pack = value as OfflinePack | null;
  return Boolean(
    pack && typeof pack === 'object' && pack.kind === INTAKE_PACKAGE_KIND && Array.isArray(pack.faults) &&
      Array.isArray(pack.workOrders),
  );
}

/** 是否为旧整库备份（有 yards 数组但无离线包标识） */
export function isLegacySnapshot(value: unknown): boolean {
  const snap = value as Record<string, unknown> | null;
  return Boolean(snap && typeof snap === 'object' && Array.isArray(snap.yards) && !isOfflinePack(snap));
}

/* -------------------------------- 计划生成 -------------------------------- */

export interface BuildPlanResult {
  items: IntakeItem[];
  overrides: Record<string, string>;
}

/**
 * 生成 / 重算合并计划。prior 携带调度员已做的逐项选择，重算时沿用，
 * 因此写入失败恢复、他人改动台账后重新核闸都不会丢掉人工结论。
 */
export function buildIntakePlan(input: PlanInput, ledger: LedgerSnapshot, prior?: PriorChoices): BuildPlanResult {
  const decisions = prior?.decisions ?? {};
  const overrides = prior?.overrides ?? {};
  const batchHash = input.contentHash;
  const items: IntakeItem[] = [];

  // 台账索引：道岔按「站场名 + 道岔号」
  const ledgerYardByName = new Map(ledger.yards.map((row) => [row.name, row]));
  const ledgerSwitchKey = new Map(
    ledger.switches.map((row) => {
      const yard = ledger.yards.find((item) => item.id === row.yardId);
      return [`${yard?.name ?? ''}｜${row.code}`, row] as const;
    }),
  );
  const ledgerInspectionBySwitchDate = new Map(
    ledger.inspections.map((row) => [`${row.switchId}｜${row.date}`, row] as const),
  );
  const ledgerFaultByKey = new Map<string, Fault & { yardName: string; switchCode: string }>();
  for (const fault of ledger.faults) {
    const inspection = ledger.inspections.find((item) => item.id === fault.inspectionId);
    const target = inspection ? ledger.switches.find((item) => item.id === inspection.switchId) : undefined;
    const yard = target ? ledger.yards.find((item) => item.id === target.yardId) : undefined;
    if (!inspection || !target || !yard) continue;
    const key = faultKey(yard.name, target.code, inspection.date, fault.part);
    if (!ledgerFaultByKey.has(key)) {
      ledgerFaultByKey.set(key, { ...fault, yardName: yard.name, switchCode: target.code });
    }
  }
  const ledgerOrderByCode = new Map(ledger.workOrders.map((row) => [row.code, row]));

  const idMap = new Map<string, string>();
  /** 包内上下文：fault localId → 道岔/日期，供病害对键与摘要 */
  const faultContext = new Map<string, ResolvedContext>();

  const makeItem = (
    kind: IntakeItemKind,
    localId: string,
    ordinal: number,
    payload: IntakePayload,
  ): IntakeItem => ({
    id: itemId(batchHash.slice(0, 8), kind, localId),
    kind,
    localId,
    seq: seqBase(kind) + ordinal,
    status: 'ready',
    decision: 'undecided',
    conflicts: [],
    gates: [],
    payload,
  });

  // ---- 站场：同名复用，否则新建 ----
  input.yards.forEach((yard, index) => {
    const item = makeItem('yard', yard.id, index, yard);
    const existing = ledgerYardByName.get(yard.name);
    if (existing) {
      item.ledgerId = existing.id;
      item.locked = true;
      item.status = 'skipped';
    } else {
      item.assignedId = assignedId(batchHash, 'yard', yard.id);
    }
    idMap.set(yard.id, item.ledgerId ?? item.assignedId ?? yard.id);
    items.push(item);
  });

  // ---- 道岔：同站场同名道岔号复用，支持人工改判归属 ----
  input.switches.forEach((sw, index) => {
    const item = makeItem('switch', sw.id, index, sw);
    const yard = input.yards.find((row) => row.id === sw.yardId);
    const yardName = yard?.name ?? ledger.yards.find((row) => row.id === idMap.get(sw.yardId))?.name ?? '';
    const override = overrides[sw.id];
    const existing = override
      ? ledger.switches.find((row) => row.id === override)
      : ledgerSwitchKey.get(`${yardName}｜${sw.code}`);
    if (existing) {
      item.ledgerId = existing.id;
      item.locked = true;
      item.status = 'skipped';
    } else {
      item.assignedId = assignedId(batchHash, 'sw', sw.id);
    }
    idMap.set(sw.id, item.ledgerId ?? item.assignedId ?? sw.id);
    items.push(item);
  });

  // ---- 巡检：解析到道岔后按「道岔 + 日期」对回，找不到则新建 ----
  /** 解析包内道岔最终落到的台账道岔 id（人工改判优先） */
  const resolveSwitchId = (packSwitchLocalId: string | undefined): string | undefined => {
    if (!packSwitchLocalId) return undefined;
    if (overrides[packSwitchLocalId]) return overrides[packSwitchLocalId];
    return idMap.get(packSwitchLocalId);
  };
  input.inspections.forEach((inspection, index) => {
    const item = makeItem('inspection', inspection.id, index, inspection);
    const targetSwitchId = resolveSwitchId(inspection.switchId);
    const existing = targetSwitchId ? ledgerInspectionBySwitchDate.get(`${targetSwitchId}｜${inspection.date}`) : undefined;
    if (existing) {
      item.ledgerId = existing.id;
      item.locked = true;
      item.status = 'skipped';
      idMap.set(inspection.id, existing.id);
    } else {
      item.assignedId = assignedId(batchHash, 'insp', inspection.id);
      idMap.set(inspection.id, item.assignedId);
    }
    items.push(item);
  });

  // ---- 病害：道岔 + 日期 + 部件对回，等级 / 销号冲突逐项保留 ----
  const packFaultIds = new Set(input.faults.map((row) => row.id));
  input.faults.forEach((fault, index) => {
    const item = makeItem('fault', fault.id, index, fault);
    const inspection = input.inspections.find((row) => row.id === fault.inspectionId);
    // 归属上下文优先取改指后的台账道岔，其次包内道岔
    const effectiveSwitchId = resolveSwitchId(inspection?.switchId);
    const ledgerSwitch = effectiveSwitchId ? ledger.switches.find((row) => row.id === effectiveSwitchId) : undefined;
    const ledgerYard = ledgerSwitch ? ledger.yards.find((row) => row.id === ledgerSwitch.yardId) : undefined;
    const packSwitch = inspection ? input.switches.find((row) => row.id === inspection.switchId) : undefined;
    const packYard = packSwitch ? input.yards.find((row) => row.id === packSwitch.yardId) : undefined;
    const context: ResolvedContext = {
      yardName: ledgerYard?.name ?? packYard?.name ?? '',
      switchCode: ledgerSwitch?.code ?? packSwitch?.code ?? '',
      date: inspection?.date ?? '',
    };
    faultContext.set(fault.id, context);

    const gates: IntakeGate[] = [];
    const conflicts: IntakeConflict[] = [];
    if (!inspection || !effectiveSwitchId) {
      gates.push({ key: 'attribution', ok: false, message: '病害归属不到道岔：巡检或道岔在包内缺失且台账无同名记录' });
      conflicts.push({
        type: 'attrMissing',
        ledgerSummary: '台账无对应道岔 / 巡检',
        incomingSummary: faultSummaryText(`${context.switchCode || '?'} ${context.date}`, fault),
        message: '请在下方把包内道岔改指到台账道岔，或剔除该病害',
      });
    } else {
      gates.push({ key: 'attribution', ok: true, message: `归属 ${context.yardName} ${context.switchCode} ${context.date}` });
    }

    const matched =
      context.yardName && context.switchCode && context.date
        ? ledgerFaultByKey.get(faultKey(context.yardName, context.switchCode, context.date, fault.part))
        : undefined;
    if (matched) {
      item.ledgerId = matched.id;
      // 即使对到台账病害也预分新 id：选「两份并存」时用它新建，重算保持稳定
      item.assignedId = assignedId(batchHash, 'fault', fault.id);
      const head = `${matched.switchCode} ${context.date} ${FAULT_PART_LABEL[fault.part]}`;
      if (matched.severity !== fault.severity) {
        conflicts.push({
          type: 'severity',
          ledgerSummary: faultSummaryText(head, matched),
          incomingSummary: faultSummaryText(head, fault),
          message: `台账评定为「${FAULT_SEVERITY_LABEL[matched.severity]}」，交回为「${FAULT_SEVERITY_LABEL[fault.severity]}」，两份均保留，请逐项选定`,
        });
      }
      if (matched.state !== fault.state) {
        conflicts.push({
          type: 'solvedState',
          ledgerSummary: faultSummaryText(head, matched),
          incomingSummary: faultSummaryText(head, fault),
          message: `台账为「${FAULT_STATE_LABEL[matched.state]}」，交回为「${FAULT_STATE_LABEL[fault.state]}」，不允许整条覆盖`,
        });
      }
      if (conflicts.length === 0) {
        // 对到同键且等级 / 销号完全一致：直接复用台账病害
        item.locked = true;
        item.status = 'skipped';
        idMap.set(fault.id, matched.id);
      }
    } else {
      item.assignedId = assignedId(batchHash, 'fault', fault.id);
    }
    item.conflicts = conflicts;
    item.gates = gates;
    items.push(item);
  });

  // ---- 天窗作业单：编号重复 + 时间窗/人员/机具编排冲突；引用闸门 ----
  const usedCodes = new Set(ledger.workOrders.map((row) => row.code));
  input.workOrders.forEach((order, index) => {
    const item = makeItem('workOrder', order.id, index, order);
    const conflicts: IntakeConflict[] = [];

    // 引用解析：包内不存在、被剔除、关联病害冲突尚未核准时都算引用不成立
    const missingRefs = order.faultIds.filter((ref) => !packFaultIds.has(ref));
    const unresolvedRefs = order.faultIds.filter((ref) => {
      if (!packFaultIds.has(ref)) return false; // 已计入 missingRefs
      const faultItem = items.find((row) => row.kind === 'fault' && row.localId === ref);
      if (!faultItem) return true;
      const decision = decisions[faultItem.id] ?? 'undecided';
      if (decision === 'discard') return true;
      if (faultItem.conflicts.length > 0 && decision === 'undecided') return true;
      return false;
    });
    const refMessages: string[] = [];
    if (missingRefs.length > 0) refMessages.push(`引用病害在包内缺失 ${missingRefs.length} 条：${missingRefs.join('、')}`);
    if (unresolvedRefs.length > 0) refMessages.push(`关联病害尚未逐项核准 ${unresolvedRefs.length} 条，请先定病害再定作业单`);
    item.gates = [
      {
        key: 'reference',
        ok: refMessages.length === 0,
        message: refMessages.length ? refMessages.join('；') : `引用 ${order.faultIds.length} 条病害均可解析`,
      },
    ];

    const sameCode = ledgerOrderByCode.get(order.code);
    let samePlan = false;
    if (sameCode) {
      const sameRefs =
        sameCode.faultIds.length === order.faultIds.length &&
        order.faultIds.every((ref) => sameCode.faultIds.includes(ref));
      samePlan =
        sameRefs &&
        sameCode.windowStart === order.windowStart &&
        sameCode.windowEnd === order.windowEnd &&
        sameCode.leader === order.leader;
      if (samePlan) {
        item.ledgerId = sameCode.id;
        item.locked = true;
        item.status = 'skipped';
        idMap.set(order.id, sameCode.id);
        item.conflicts = conflicts;
        items.push(item);
        return;
      }
      conflicts.push({
        type: 'codeDup',
        ledgerSummary: orderSummaryText(sameCode),
        incomingSummary: orderSummaryText(order),
        message: '作业单编号已被台账占用且编排不同：可采用交回版本覆盖该单字段，或改挂编号两份并存',
      });
    }

    // 时间窗 + 人员 / 机具占用（与全部台账作业单比对；同编号且完全同编排的已在上面复用）
    const hitCodes: string[] = [];
    const hitReasons = new Set<string>();
    for (const other of ledger.workOrders) {
      if (samePlan) continue;
      if (!isOverlap(order, other)) continue;
      const sharedMembers = order.members.filter((name) => other.members.includes(name));
      const sharedMachines = order.machines.filter((name) => other.machines.includes(name));
      if (sharedMembers.length === 0 && sharedMachines.length === 0) continue;
      hitCodes.push(other.code);
      if (sharedMembers.length > 0) hitReasons.add(`人员 ${sharedMembers.join('、')}`);
      if (sharedMachines.length > 0) hitReasons.add(`机具 ${sharedMachines.join('、')}`);
    }
    if (hitCodes.length > 0) {
      conflicts.push({
        type: 'schedule',
        ledgerSummary: `占用方：${hitCodes.join('、')}`,
        incomingSummary: orderSummaryText(order),
        message: `天窗时间重叠且${[...hitReasons].join('、')}被占用，确认后两份编排都保留`,
      });
    }

    // 并存改挂编号：同编号或新增条目都给一个确定性的 -甲/-乙 后缀（仅 keepBoth 时启用）
    let candidate = `${order.code}-${shiftSuffix(input.shift)}`;
    let serial = 2;
    while (usedCodes.has(candidate)) {
      candidate = `${order.code}-${shiftSuffix(input.shift)}${serial}`;
      serial += 1;
    }
    item.assignedCode = candidate;
    item.assignedId = assignedId(batchHash, 'wo', order.id);
    item.conflicts = conflicts;
    items.push(item);
  });

  // ---- 决策落地：把调度员选择折算成 status / idMap，并复算闸门状态 ----
  for (const item of items) {
    if (item.locked) {
      item.status = 'skipped';
      continue;
    }
    const decision = decisions[item.id] ?? 'undecided';
    item.decision = decision;
    if (decision === 'discard') {
      item.status = 'skipped';
      continue;
    }
    const gateFailed = item.gates.some((gate) => !gate.ok);
    const undecidedConflict = item.conflicts.length > 0 && decision === 'undecided';
    if (gateFailed) {
      item.status = 'blocked';
    } else if (undecidedConflict) {
      item.status = 'conflict';
    } else {
      item.status = 'ready';
    }

    if (item.kind === 'fault') {
      if (item.ledgerId && decision === 'keepBoth') {
        idMap.set(item.localId, item.assignedId ?? assignedId(batchHash, 'fault', item.localId));
      } else if (item.ledgerId) {
        // accept（或无冲突的对回）落到台账病害；undecided 时先不映射，引用闸门会拦住作业单
        if (decision === 'accept' || item.conflicts.length === 0) idMap.set(item.localId, item.ledgerId);
      } else {
        idMap.set(item.localId, item.assignedId ?? assignedId(batchHash, 'fault', item.localId));
      }
    } else if (item.kind === 'workOrder') {
      if (item.ledgerId && decision === 'keepBoth') {
        idMap.set(item.localId, item.assignedId ?? assignedId(batchHash, 'wo', item.localId));
      } else if (item.ledgerId && decision === 'accept') {
        idMap.set(item.localId, item.ledgerId);
      } else if (!item.ledgerId) {
        idMap.set(item.localId, item.assignedId ?? assignedId(batchHash, 'wo', item.localId));
      }
    }
  }

  // 作业单引用按最终 idMap 复算一次（剔除 / 未核准导致的断裂在这一步定型）
  for (const item of items) {
    if (item.kind !== 'workOrder' || item.locked) continue;
    const order = item.payload as WorkOrder;
    const broken = order.faultIds.filter((ref) => !idMap.has(ref));
    const gate = item.gates.find((row) => row.key === 'reference');
    if (gate) {
      gate.ok = broken.length === 0;
      if (broken.length > 0) {
        gate.message = `引用病害无法随包写入 ${broken.length} 条（${broken.join('、')}）：请改判病害或剔除作业单`;
      } else {
        gate.message = `引用 ${order.faultIds.length} 条病害随归属/选择均可落库`;
      }
    }
    if (broken.length > 0 && item.status !== 'skipped') item.status = 'blocked';
  }

  return { items: items.sort((a, b) => a.seq - b.seq), overrides };
}

/** 整包是否可以进入写入：无待选冲突、无闸门拦截 */
export function planBlockers(items: IntakeItem[]): string[] {
  const blockers: string[] = [];
  const conflicts = items.filter((item) => item.status === 'conflict');
  const blocked = items.filter((item) => item.status === 'blocked');
  if (conflicts.length > 0) blockers.push(`还有 ${conflicts.length} 条待选冲突未逐项核准`);
  if (blocked.length > 0) blockers.push(`还有 ${blocked.length} 条记录闸门不成立（病害归属 / 作业单引用）`);
  return blockers;
}

/* -------------------------------- 行落库构造 ------------------------------- */

export type WritableRow =
  | ({ kind: 'yard'; row: Yard })
  | ({ kind: 'switch'; row: Switch })
  | ({ kind: 'inspection'; row: Inspection })
  | ({ kind: 'fault'; row: Fault; strategy: 'insert' | 'mergeMatched' })
  | ({ kind: 'workOrder'; row: WorkOrder; strategy: 'insert' | 'mergeMatched' });

/** 由计划条目构造最终写入台账的行（父级 id / 病害引用统一按 idMap 重写） */
export function buildWritableRow(item: IntakeItem, items: IntakeItem[], ledger: LedgerSnapshot): WritableRow | null {
  const targetId = item.ledgerId ?? item.assignedId ?? (item.payload as { id: string }).id;
  const byLocal = (kind: IntakeItemKind, localId: string): IntakeItem | undefined =>
    items.find((row) => row.kind === kind && row.localId === localId);
  const targetOf = (kind: IntakeItemKind, localId: string): string => {
    const peer = byLocal(kind, localId);
    if (peer?.ledgerId) return peer.ledgerId;
    if (peer?.assignedId) return peer.assignedId;
    return localId;
  };

  if (item.kind === 'yard') {
    return { kind: 'yard', row: { ...(item.payload as Yard), id: targetId } };
  }
  if (item.kind === 'switch') {
    const payload = item.payload as Switch;
    return { kind: 'switch', row: { ...payload, id: targetId, yardId: targetOf('yard', payload.yardId) } };
  }
  if (item.kind === 'inspection') {
    const payload = item.payload as Inspection;
    return { kind: 'inspection', row: { ...payload, id: targetId, switchId: targetOf('switch', payload.switchId) } };
  }
  if (item.kind === 'fault') {
    const payload = item.payload as Fault;
    const inspectionId = targetOf('inspection', payload.inspectionId);
    // 对回台账但选择两份并存：用预分新 id 新建，绝不能落到台账 id
    const insertId = item.decision === 'keepBoth' ? item.assignedId ?? targetId : targetId;
    if (item.ledgerId && item.decision !== 'keepBoth') {
      const matched = ledger.faults.find((row) => row.id === item.ledgerId);
      const merged: Fault = {
        ...(matched ?? payload),
        id: item.ledgerId,
        inspectionId: matched?.inspectionId ?? inspectionId,
        part: payload.part,
        type: matched?.type ?? payload.type,
        sizeMm: payload.sizeMm ?? matched?.sizeMm ?? null,
        // 只采用调度员逐项核准过的等级 / 销号两个字段，其余沿用台账（不整条覆盖）
        severity: payload.severity,
        state: payload.state,
        solvedAt:
          payload.state === 'solved'
            ? payload.solvedAt ?? matched?.solvedAt ?? new Date().toISOString()
            : null,
        revision: ROW_REVISION,
      };
      return { kind: 'fault', row: merged, strategy: 'mergeMatched' };
    }
    return { kind: 'fault', row: { ...payload, id: insertId, inspectionId }, strategy: 'insert' };
  }
  // workOrder
  const payload = item.payload as WorkOrder;
  // 引用统一按病害条目的最终目标 id 重写：对回且采用交回/无冲突→台账 id；并存/新增→预分 id
  const faultIds = payload.faultIds
    .map((ref) => {
      const peer = byLocal('fault', ref);
      if (!peer) return ref;
      if (peer.ledgerId && peer.decision !== 'keepBoth') return peer.ledgerId;
      return peer.assignedId ?? ref;
    })
    .filter((ref, index, all) => all.indexOf(ref) === index);
  const code = item.decision === 'keepBoth' && item.assignedCode ? item.assignedCode : payload.code;
  if (item.ledgerId && item.decision === 'accept') {
    const matched = ledger.workOrders.find((row) => row.id === item.ledgerId);
    const merged: WorkOrder = {
      ...(matched ?? payload),
      id: item.ledgerId,
      code: payload.code,
      faultIds,
      windowStart: payload.windowStart,
      windowEnd: payload.windowEnd,
      leader: payload.leader,
      members: payload.members,
      machines: payload.machines,
      state: payload.state,
      revision: ROW_REVISION,
      updatedAt: new Date().toISOString(),
    };
    return { kind: 'workOrder', row: merged, strategy: 'mergeMatched' };
  }
  // 同编号选择两份并存：用预分新 id 新建，避免覆盖台账作业单
  const orderInsertId = item.decision === 'keepBoth' && item.assignedId ? item.assignedId : targetId;
  return {
    kind: 'workOrder',
    row: { ...payload, id: orderInsertId, code, faultIds },
    strategy: 'insert',
  };
}

/** 旧计划与新计划之间沿用逐项选择（按稳定条目 id） */
export function priorChoicesOf(batch: IntakeBatch): PriorChoices {
  const decisions: Record<string, IntakeDecision> = {};
  for (const item of batch.items) {
    if (item.decision !== 'undecided') decisions[item.id] = item.decision;
  }
  return { decisions, overrides: batch.attributionOverrides };
}

export const INTAKE_PLAN_VERSION = INTAKE_PACKAGE_VERSION;

/** 给页面展示的病害字段类型（避免循环依赖时的类型兜底） */
export type { FaultSeverity, FaultState };
