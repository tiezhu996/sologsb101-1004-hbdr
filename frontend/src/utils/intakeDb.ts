/**
 * 离线包接收区持久化与合并编排（Dexie + Web Locks）
 *
 * - receiveXxx：离线包 / 旧备份先进接收区，同一包（packageId 或内容哈希相同）
 *   多标签同时接收只认第一条，其余驳回为「重复接收」；
 * - setItemDecision / setAttributionOverride：逐项核准与人工归属改判后重算计划，
 *   台账一份、离线一份始终并排保留，不存在后导入整条覆盖；
 * - applyIntakeBatch：Web Lock 保证多标签只有一个完成；写入前按最新台账重算闸门，
 *   每条记录独立事务、逐条检查点，失败从已完成记录之后继续，未确认内容留在接收区。
 */
import type { Table } from 'dexie';
import type { IntakeBatch } from '../types/intake';
import {
  INTAKE_APPLY_LOCK,
  INTAKE_FAIL_SEQ_SETTING,
  type IntakeDecision,
  type IntakeItem,
  type IntakePayload,
  type IntakeItemKind,
  type LedgerSnapshot,
  type OfflinePack,
} from '../types/intake';
import {
  db,
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type WorkOrderRow,
  type YardRow,
} from './db';
import { emitChange } from './events';
import { nowIso } from './format';
import {
  buildIntakePlan,
  buildMigrationChecks,
  buildWritableRow,
  contentHash,
  isLegacySnapshot,
  isOfflinePack,
  normalizeLegacySnapshot,
  planBlockers,
  priorChoicesOf,
  type PlanInput,
} from './intakePlan';

/* ------------------------------- 接收区读侧 ------------------------------- */

export function listIntakeBatchesTable(): Table<IntakeBatch, string> {
  return db.intakeBatches;
}

export async function listIntakeBatches(): Promise<IntakeBatch[]> {
  const rows = await db.intakeBatches.toArray();
  return rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function getIntakeBatch(id: string): Promise<IntakeBatch | undefined> {
  return db.intakeBatches.get(id);
}

/** 待处理批次（接收区角标 / 计数用） */
export async function pendingIntakeCount(): Promise<number> {
  return db.intakeBatches.where('status').noneOf(['applied', 'rejected']).count();
}

/** 读取当前正式台账快照（计划生成 / 写入前复核共用） */
export async function readLedger(): Promise<LedgerSnapshot> {
  const [yards, switches, inspections, faults, workOrders] = await Promise.all([
    db.yards.toArray(),
    db.switches.toArray(),
    db.inspections.toArray(),
    db.faults.toArray(),
    db.workOrders.toArray(),
  ]);
  return { yards, switches, inspections, faults, workOrders };
}

/* ------------------------------- 接收 / 去重 ------------------------------- */

export interface ReceiveResult {
  outcome: 'received' | 'duplicate' | 'invalid';
  message: string;
  batchId?: string;
}

/** 按 packageId 或内容哈希查找任一已有批次（含已并入 / 已驳回，防止同包重复开单） */
async function findBatchByPack(packageId: string, hash: string): Promise<IntakeBatch | undefined> {
  const rows = await db.intakeBatches.toArray();
  return rows.find((row) => row.packageId === packageId || row.contentHash === hash);
}

function duplicateMessage(batch: IntakeBatch): string {
  switch (batch.status) {
    case 'applying':
      return `同一离线包正在另一标签页合并写入（${batch.shift}），本标签不再重复处理`;
    case 'applied':
      return `同一离线包已并入正式台账（${batch.shift}），重复接收已驳回；如确需重收请先移除原记录`;
    case 'rejected':
      return '同一离线包此前已驳回，未重复接收';
    case 'migrate':
      return '该旧备份已在迁移核对清单中，请先核对再应用';
    default:
      return `同一离线包已在接收区核准（${batch.shift}），本次为重复接收，已驳回`;
  }
}

/** 用最新台账重算某批次计划（沿用人工决策与归属改判），返回更新后的批次 */
export async function recomputeBatch(batch: IntakeBatch, ledger?: LedgerSnapshot): Promise<IntakeBatch> {
  if (batch.status === 'migrate' && batch.rawSnapshot !== undefined) return batch;
  const snapshot = ledger ?? (await readLedger());
  const raw = batch.rawSnapshot ?? packFromBatch(batch);
  const normalized =
    batch.kind === 'legacy' ? normalizeLegacySnapshot(raw) : normalizePack(raw as Partial<OfflinePack>);
  const input: PlanInput = {
    packageId: batch.packageId,
    contentHash: batch.contentHash,
    shift: batch.shift,
    yards: normalized.yards,
    switches: normalized.switches,
    inspections: normalized.inspections,
    faults: normalized.faults,
    workOrders: normalized.workOrders,
  };
  const prior = priorChoicesOf(batch);
  const { items } = buildIntakePlan(input, snapshot, prior);
  // 保留已写入 / 已剔除的终态（断点恢复时不回退检查点）
  const byId = new Map(batch.items.map((item) => [item.id, item]));
  for (const item of items) {
    const old = byId.get(item.id);
    if (old?.status === 'applied') {
      item.status = 'applied';
      item.decision = old.decision;
      item.appliedAt = old.appliedAt;
    }
  }
  const updated: IntakeBatch = { ...batch, items, attributionOverrides: prior.overrides };
  await db.intakeBatches.put(updated);
  return updated;
}

type NormalizedPack = PlanInput;

/** 离线包 / 从条目还原的对象都归一为五类记录数组（容忍缺字段） */
function normalizePack(raw: Partial<OfflinePack>): NormalizedPack {
  return {
    packageId: raw.packageId ?? '',
    contentHash: '',
    shift: raw.shift ?? '',
    yards: raw.yards ?? [],
    switches: raw.switches ?? [],
    inspections: raw.inspections ?? [],
    faults: raw.faults ?? [],
    workOrders: raw.workOrders ?? [],
  };
}

function packFromBatch(batch: IntakeBatch): OfflinePack {
  // pack 批次的原始记录直接从当前 items 还原（payload 从未被修改）
  const pick = (kind: IntakeItemKind): IntakePayload[] =>
    batch.items.filter((item) => item.kind === kind).map((item) => item.payload);
  return {
    kind: 'gbrailswitch-offline-pack',
    packageVersion: 1,
    packageId: batch.packageId,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: batch.exportedAt,
    shift: batch.shift,
    crew: batch.crew,
    note: batch.note,
    yards: pick('yard') as YardRow[],
    switches: pick('switch') as SwitchRow[],
    inspections: pick('inspection') as InspectionRow[],
    faults: pick('fault') as FaultRow[],
    workOrders: pick('workOrder') as WorkOrderRow[],
  };
}

async function saveNewPackBatch(pack: OfflinePack, hash: string): Promise<IntakeBatch> {
  const now = nowIso();
  const batch: IntakeBatch = {
    id: `intake-${hash}`,
    packageId: pack.packageId,
    contentHash: hash,
    status: 'reviewing',
    kind: 'pack',
    shift: pack.shift || '未注明班次',
    crew: pack.crew || '',
    source: `${pack.exportedAt} 导出`,
    note: pack.note || '',
    exportedAt: pack.exportedAt || now,
    receivedAt: now,
    finishedAt: null,
    appliedCount: 0,
    stopReason: null,
    items: [],
    attributionOverrides: {},
    migrationChecks: [],
    // 保留原始包供「按最新台账重算闸门」使用；写入完成后清空
    rawSnapshot: pack,
    revision: ROW_REVISION,
  };
  const planned = await recomputeBatch(batch, await readLedger());
  planned.stopReason = describePlan(planned);
  return planned;
}

function describePlan(batch: IntakeBatch): string | null {
  const blockers = planBlockers(batch.items);
  if (blockers.length > 0) return `等待核准：${blockers.join('；')}`;
  return null;
}

/** 接收一个文件（自动识别离线包 / 旧整库备份）。同一包多标签重复提交只认第一条 */
export async function receiveIntakeFile(file: File): Promise<ReceiveResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { outcome: 'invalid', message: '文件不是合法 JSON，无法接收' };
  }
  if (isOfflinePack(parsed)) return receivePack(parsed);
  if (isLegacySnapshot(parsed)) return receiveLegacy(parsed, file.name);
  return { outcome: 'invalid', message: '无法识别：既不是离线包也不是整库备份 JSON' };
}

/** 接收带标识离线包（含跨标签去重） */
export async function receivePack(pack: OfflinePack): Promise<ReceiveResult> {
  if (!Array.isArray(pack.faults) || !Array.isArray(pack.workOrders)) {
    return { outcome: 'invalid', message: '离线包缺少 faults / workOrders 数据' };
  }
  const hash = contentHash({
    yards: pack.yards ?? [],
    switches: pack.switches ?? [],
    inspections: pack.inspections ?? [],
    faults: pack.faults,
    workOrders: pack.workOrders,
  });
  // 跨标签去重：接收登记本身加锁，避免两个标签同时通过「不存在」检查
  return withWebLock('gbrailswitch-intake-receive', async () => {
    const duplicate = await findBatchByPack(pack.packageId || hash, hash);
    if (duplicate) {
      emitChange();
      return { outcome: 'duplicate', message: duplicateMessage(duplicate), batchId: duplicate.id };
    }
    const batch = await saveNewPackBatch(
      {
        ...pack,
        yards: pack.yards ?? [],
        switches: pack.switches ?? [],
        inspections: pack.inspections ?? [],
      },
      hash,
    );
    emitChange();
    return {
      outcome: 'received',
      batchId: batch.id,
      message: `离线包已进入接收区：${batch.items.length} 条记录，待选冲突 ${
        batch.items.filter((item) => item.status === 'conflict').length
      } 条`,
    };
  });
}

/** 接收无包标识旧备份：先存迁移清单（migrate），核对完才生成计划 */
export async function receiveLegacy(raw: unknown, sourceName: string): Promise<ReceiveResult> {
  const normalized = normalizeLegacySnapshot(raw);
  const hash = contentHash(normalized);
  return withWebLock('gbrailswitch-intake-receive', async () => {
    const pseudoPackageId = `legacy-${hash}`;
    const duplicate = await findBatchByPack(pseudoPackageId, hash);
    if (duplicate) {
      emitChange();
      return { outcome: 'duplicate', message: duplicateMessage(duplicate), batchId: duplicate.id };
    }
    const now = nowIso();
    const batch: IntakeBatch = {
      id: `intake-${hash}`,
      packageId: pseudoPackageId,
      contentHash: hash,
      status: 'migrate',
      kind: 'legacy',
      shift: '旧备份',
      crew: '',
      source: sourceName || '旧整库 JSON',
      note: '缺少包标识，按内容哈希登记',
      exportedAt: (raw as { exportedAt?: string }).exportedAt ?? now,
      receivedAt: now,
      finishedAt: null,
      appliedCount: 0,
      stopReason: '旧备份缺少包标识：请先逐项核对迁移清单',
      items: [],
      attributionOverrides: {},
      migrationChecks: buildMigrationChecks(raw),
      rawSnapshot: raw,
      revision: ROW_REVISION,
    };
    await db.intakeBatches.put(batch);
    emitChange();
    return {
      outcome: 'received',
      batchId: batch.id,
      message: `旧备份已登记，需先核对 ${batch.migrationChecks.length} 项迁移清单后才能生成合并计划`,
    };
  });
}

/* ----------------------------- 逐项核准 / 改判 ----------------------------- */

/** 调度员对某条待选冲突的逐项选择（undecided/accept/keepBoth/discard） */
export async function setItemDecision(batchId: string, itemId: string, decision: IntakeDecision): Promise<void> {
  const batch = await db.intakeBatches.get(batchId);
  if (!batch || batch.status === 'applying' || batch.status === 'applied') return;
  const next = await recomputeBatch({
    ...batch,
    items: batch.items.map((item) => (item.id === itemId ? { ...item, decision } : item)),
  });
  next.stopReason = describePlan(next);
  await db.intakeBatches.put(next);
  emitChange();
}

/** 人工改判包内道岔归属（包内道岔 localId → 台账道岔 id；空串表示取消改判） */
export async function setAttributionOverride(batchId: string, packSwitchLocalId: string, ledgerSwitchId: string): Promise<void> {
  const batch = await db.intakeBatches.get(batchId);
  if (!batch || batch.status === 'applying' || batch.status === 'applied') return;
  const overrides = { ...batch.attributionOverrides };
  if (ledgerSwitchId) overrides[packSwitchLocalId] = ledgerSwitchId;
  else delete overrides[packSwitchLocalId];
  const next = await recomputeBatch({ ...batch, attributionOverrides: overrides });
  next.stopReason = describePlan(next);
  await db.intakeBatches.put(next);
  emitChange();
}

/** 旧备份迁移清单项勾选 */
export async function toggleMigrationCheck(batchId: string, checkKey: string): Promise<void> {
  const batch = await db.intakeBatches.get(batchId);
  if (!batch || batch.kind !== 'legacy') return;
  const migrationChecks = batch.migrationChecks.map((item) =>
    item.key === checkKey ? { ...item, checked: !item.checked } : item,
  );
  await db.intakeBatches.put({ ...batch, migrationChecks });
  emitChange();
}

/** 迁移清单全部核对完成：生成合并计划，转入接收区待核准 */
export async function finalizeMigrationPlan(batchId: string): Promise<ReceiveResult> {
  const batch = await db.intakeBatches.get(batchId);
  if (!batch || batch.kind !== 'legacy') return { outcome: 'invalid', message: '批次不存在' };
  const unchecked = batch.migrationChecks.filter((item) => !item.checked);
  if (unchecked.length > 0) {
    return {
      outcome: 'invalid',
      message: `还有 ${unchecked.length} 项迁移清单未核对：${unchecked.map((item) => item.label).join('、')}`,
    };
  }
  const normalized = normalizeLegacySnapshot(batch.rawSnapshot);
  const input: PlanInput = {
    packageId: batch.packageId,
    contentHash: batch.contentHash,
    shift: batch.shift,
    ...normalized,
  };
  const { items } = buildIntakePlan(input, await readLedger());
  const pendingReason = describePlan({ items } as IntakeBatch);
  const next: IntakeBatch = {
    ...batch,
    status: 'reviewing',
    items,
    rawSnapshot: undefined,
    stopReason: pendingReason ?? '迁移清单核对完成，待逐项核准',
  };
  await db.intakeBatches.put(next);
  emitChange();
  return { outcome: 'received', batchId: batch.id, message: '迁移清单核对完成，已生成合并计划，进入逐项核准' };
}

/** 驳回（剔除）整包：保留记录用于审计，状态 rejected */
export async function rejectIntakeBatch(batchId: string): Promise<void> {
  const batch = await db.intakeBatches.get(batchId);
  if (!batch || batch.status === 'applying') return;
  await db.intakeBatches.put({
    ...batch,
    status: 'rejected',
    finishedAt: nowIso(),
    stopReason: '调度员驳回整包，未写入正式台账',
  });
  emitChange();
}

/** 从接收区彻底移除批次记录 */
export async function deleteIntakeBatch(batchId: string): Promise<void> {
  await db.intakeBatches.delete(batchId);
  emitChange();
}

/* -------------------------------- 合并写入 -------------------------------- */

/** Web Locks API：同一把锁在多个标签页间互斥（标签关闭自动释放） */
async function withWebLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const navigatorWithLocks = globalThis.navigator as Navigator & {
    locks?: { request: <R>(lockName: string, callback: () => Promise<R>) => Promise<R> };
  };
  if (!navigatorWithLocks.locks) return task();
  return navigatorWithLocks.locks.request(name, task);
}

export interface ApplyResult {
  completed: boolean;
  applied: number;
  skipped: number;
  message: string;
}

/**
 * 确认合并一份包。
 * 闸门双条件（病害归属 + 作业单引用）已在计划中逐条核算，这里再按最新台账复核；
 * 多标签同时确认时由 Web Lock 串行，抢锁后若批次已是 applied 直接让位，保证只有一个完成。
 */
export async function applyIntakeBatch(batchId: string): Promise<ApplyResult> {
  return withWebLock(INTAKE_APPLY_LOCK, async () => {
    const current = await db.intakeBatches.get(batchId);
    if (!current) return { completed: false, applied: 0, skipped: 0, message: '接收区批次不存在' };
    if (current.status === 'applied') {
      return { completed: true, applied: current.appliedCount, skipped: 0, message: '该包已由另一标签页完成合并' };
    }
    if (current.status === 'applying') {
      return { completed: false, applied: current.appliedCount, skipped: 0, message: '另一标签页正在写入该包，本标签退出' };
    }
    if (current.status === 'migrate') {
      return { completed: false, applied: 0, skipped: 0, message: '旧备份迁移清单尚未核对完成' };
    }

    // 写入前按最新台账重算闸门（计划可能是较早生成的），沿用所有人工选择
    const planned = await recomputeBatch(current);
    const blockers = planBlockers(planned.items);
    if (blockers.length > 0) {
      await db.intakeBatches.put({
        ...planned,
        status: 'reviewing',
        stopReason: `核准拦截：${blockers.join('；')}`,
      });
      emitChange();
      return { completed: false, applied: 0, skipped: 0, message: blockers.join('；') };
    }

    await db.intakeBatches.put({ ...planned, status: 'applying', stopReason: null });
    emitChange();

    const ledger = await readLedger();
    let applied = planned.appliedCount;
    let skipped = planned.items.filter((item) => item.status === 'skipped').length;
    // 断点演练：对当前尚未越过检查点的记录，按顺序第 N 条注入一次失败
    const failOrdinal = await consumeFailPoint();

    // 从已完成记录之后继续：applied / skipped 终态直接越过（未确认内容仍留在接收区）
    const pending = planned.items.filter((item) => item.status !== 'applied' && item.status !== 'skipped');
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      try {
        if (failOrdinal !== null && index + 1 === failOrdinal) {
          throw new Error(`断点演练：第 ${index + 1} 条待写记录失败（已自动保留检查点，可继续）`);
        }
        await writeItem(item, planned.items, ledger);
        const stamped = nowIso();
        await db.intakeBatches
          .where('id')
          .equals(batchId)
          .modify((row: IntakeBatch) => {
            const target = row.items.find((entry) => entry.id === item.id);
            if (target) {
              target.status = 'applied';
              target.appliedAt = stamped;
              target.errorMessage = undefined;
            }
            row.appliedCount += 1;
          });
        applied += 1;
        emitChange();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '写入失败';
        const latest = await db.intakeBatches.get(batchId);
        if (latest) {
          await db.intakeBatches.put({
            ...latest,
            status: 'paused',
            stopReason: `写入「${itemLabel(item)}」时停下：${message}。已完成 ${applied} 条，从该条之后可继续`,
            items: latest.items.map((entry) =>
              entry.id === item.id ? { ...entry, status: 'error', errorMessage: message } : entry,
            ),
          });
        }
        emitChange();
        return { completed: false, applied, skipped, message };
      }
    }

    const finished = await db.intakeBatches.get(batchId);
    if (finished) {
      await db.intakeBatches.put({
        ...finished,
        status: 'applied',
        stopReason: null,
        finishedAt: nowIso(),
        rawSnapshot: undefined,
        items: finished.items.map((item) => (item.status === 'error' ? { ...item, status: 'ready' } : item)),
      });
    }
    emitChange();
    return {
      completed: true,
      applied,
      skipped,
      message: `该包已并入正式台账：写入 ${applied} 条，复用 / 剔除 ${skipped} 条`,
    };
  });
}

/** 断点演练设置（写入第 N 条待处理记录时失败一次，随即清除） */
export async function armFailPoint(seqOrdinal: number): Promise<void> {
  await db.settings.put({ id: INTAKE_FAIL_SEQ_SETTING, value: String(seqOrdinal), updatedAt: nowIso() });
}

async function consumeFailPoint(): Promise<number | null> {
  const row = await db.settings.get(INTAKE_FAIL_SEQ_SETTING);
  if (!row) return null;
  await db.settings.delete(INTAKE_FAIL_SEQ_SETTING);
  const ordinal = Number(row.value);
  return Number.isFinite(ordinal) ? ordinal : null;
}

function itemLabel(item: IntakeItem): string {
  const payload = item.payload as { code?: string; id: string };
  return payload.code || `${item.kind}:${item.localId}`;
}

/** 单条记录独立事务写入（父级先于子级；失败只回滚本条，已写检查点保留） */
async function writeItem(
  item: IntakeItem,
  allItems: IntakeItem[],
  ledger: LedgerSnapshot,
): Promise<void> {
  if (item.status === 'skipped') return;
  const writable = buildWritableRow(item, allItems, ledger);
  if (!writable) return;
  await db.transaction('rw', [db.yards, db.switches, db.inspections, db.faults, db.workOrders], async () => {
    if (writable.kind === 'yard') {
      await db.yards.put(writable.row);
      mirrorLedger(ledger.yards, writable.row);
    } else if (writable.kind === 'switch') {
      await db.switches.put(writable.row);
      mirrorLedger(ledger.switches, writable.row);
    } else if (writable.kind === 'inspection') {
      await db.inspections.put(writable.row);
      mirrorLedger(ledger.inspections, writable.row);
    } else if (writable.kind === 'fault') {
      await db.faults.put(writable.row);
      if (writable.strategy === 'insert') mirrorLedger(ledger.faults, writable.row);
    } else if (writable.kind === 'workOrder') {
      await db.workOrders.put(writable.row);
      if (writable.strategy === 'insert') mirrorLedger(ledger.workOrders, writable.row);
    }
  });
}

function mirrorLedger<T extends { id: string }>(list: T[], row: T): void {
  const index = list.findIndex((item) => item.id === row.id);
  if (index >= 0) list[index] = row;
  else list.push(row);
}
