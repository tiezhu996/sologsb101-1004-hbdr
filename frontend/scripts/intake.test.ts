/**
 * 离线包接收区合并流程的 Node 验证脚本（纯逻辑 + fake-indexeddb）。
 * 由 scripts/run-tests.mjs 用 esbuild 打包后执行，不进入前端 tsc 工程。
 * 覆盖：对回冲突逐项核准、双闸门、两份并存、断点续传、跨标签锁、同包去重、旧备份迁移。
 */
import 'fake-indexeddb/auto';
import { initDatabase, listFaults, listWorkOrders, resetDatabase } from '../src/utils/db';
import type { Fault } from '../src/types/fault';
import type { WorkOrder } from '../src/types/workOrder';
import type { OfflinePack } from '../src/types/intake';
import {
  applyIntakeBatch,
  armFailPoint,
  deleteIntakeBatch,
  finalizeMigrationPlan,
  getIntakeBatch,
  receiveIntakeFile,
  receiveLegacy,
  receivePack,
  setAttributionOverride,
  setItemDecision,
  toggleMigrationCheck,
} from '../src/utils/intakeDb';
import { buildIntakePlan, buildWritableRow, contentHash, planBlockers } from '../src/utils/intakePlan';
import type { LedgerSnapshot } from '../src/types/intake';
import { ROW_REVISION } from '../src/types/persistence';
import { readLedger } from '../src/utils/intakeDb';

/* ------------------------------- 最小断言框架 ------------------------------ */

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}
async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------- 内存版 Web Locks（跨标签模拟） --------------------------- */

interface FakeLocks {
  request: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
  held: (name: string) => boolean;
  __releaseNext__?: () => void;
}
const waiters = new Map<string, Array<() => void>>();
function installFakeLocks(): FakeLocks {
  const held = new Set<string>();
  const locks = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const run = (): void => {
          held.add(name);
          Promise.resolve()
            .then(callback)
            .then(
              (value) => {
                held.delete(name);
                resolve(value);
                waiters.get(name)?.shift()?.();
              },
              (error) => {
                held.delete(name);
                reject(error);
                waiters.get(name)?.shift()?.();
              },
            );
        };
        if (held.has(name)) {
          const queue = waiters.get(name) ?? [];
          queue.push(run);
          waiters.set(name, queue);
        } else {
          run();
        }
      });
    },
  };
  (globalThis as { navigator?: unknown }).navigator = {
    locks,
    userAgent: 'node-fake',
  };
  return { request: locks.request, held: (name: string) => held.has(name) };
}

/* -------------------------------- 测试数据 -------------------------------- */

const stamp = '2026-10-01T08:00:00.000Z';
function baseLedger(): LedgerSnapshot {
  const yard = { id: 'y1', name: '沙河堡站', mileage: 'K1', trackCount: 3, region: '车间', createdAt: stamp, revision: ROW_REVISION };
  const sw = {
    id: 's1', yardId: 'y1', code: '1#', frogNumber: '12' as const, railType: '60kg/m' as const,
    position: '东端', turnoutType: 'single' as const, createdAt: stamp, revision: ROW_REVISION,
  };
  const inspection = { id: 'i1', switchId: 's1', date: '2026-09-30', inspector: '赵铁军', weather: 'sunny' as const, method: 'manual' as const, createdAt: stamp, revision: ROW_REVISION };
  const fault: Fault = {
    id: 'f1', inspectionId: 'i1', part: 'pointRail', type: 'wear', severity: 'medium', sizeMm: 4,
    state: 'pending', solvedAt: null, createdAt: stamp, revision: ROW_REVISION,
  };
  const order: WorkOrder = {
    id: 'w1', code: 'TW-001', faultIds: ['f1'], windowStart: '2026-10-02 09:00', windowEnd: '2026-10-02 11:00',
    leader: '赵铁军', machines: ['轨距尺'], members: ['赵铁军', '孙立波'], state: 'planned',
    createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION,
  };
  return { yards: [yard], switches: [sw], inspections: [inspection], faults: [fault], workOrders: [order] };
}

function packWith(overrides: Partial<OfflinePack> = {}): OfflinePack {
  return {
    kind: 'gbrailswitch-offline-pack',
    packageVersion: 1,
    packageId: 'PK-TEST-1',
    schemaVersion: 3,
    exportedAt: '2026-10-01 18:00',
    shift: '甲班',
    crew: '赵铁军',
    note: '测试包',
    yards: [{ id: 'py1', name: '沙河堡站', mileage: 'K1', trackCount: 3, region: '车间', createdAt: stamp, revision: ROW_REVISION }],
    switches: [{
      id: 'ps1', yardId: 'py1', code: '1#', frogNumber: '12', railType: '60kg/m',
      position: '东端', turnoutType: 'single', createdAt: stamp, revision: ROW_REVISION,
    }],
    inspections: [{
      id: 'pi1', switchId: 'ps1', date: '2026-09-30', inspector: '赵铁军', weather: 'sunny', method: 'manual',
      createdAt: stamp, revision: ROW_REVISION,
    }],
    // 对到 f1：等级重 / 已销号（等级 + 销号双冲突）；另有一条全新辙叉病害
    faults: [
      { id: 'pf1', inspectionId: 'pi1', part: 'pointRail', type: 'wear', severity: 'heavy', sizeMm: 4, state: 'solved', solvedAt: '2026-10-01 17:00', createdAt: stamp, revision: ROW_REVISION },
      { id: 'pf2', inspectionId: 'pi1', part: 'frog', type: 'crack', severity: 'medium', sizeMm: null, state: 'pending', solvedAt: null, createdAt: stamp, revision: ROW_REVISION },
    ],
    // 作业单引用 pf1（未核准时引用闸门不成立）与 pf2
    workOrders: [{
      id: 'pw1', code: 'TW-900', faultIds: ['pf1', 'pf2'], windowStart: '2026-10-03 09:00', windowEnd: '2026-10-03 10:30',
      leader: '吴长胜', machines: ['发电机'], members: ['吴长胜'], state: 'planned', createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION,
    }],
    ...overrides,
  };
}

/* ---------------------------------- 用例 ---------------------------------- */

export async function main(): Promise<void> {
  installFakeLocks();

  // 纯引擎：对回 / 冲突 / 闸门
  {
    const ledger = baseLedger();
    const pack = packWith();
    const { items } = buildIntakePlan(
      {
        packageId: pack.packageId, contentHash: contentHash(pack), shift: pack.shift,
        yards: pack.yards, switches: pack.switches, inspections: pack.inspections,
        faults: pack.faults, workOrders: pack.workOrders,
      },
      ledger,
    );
    const byKind = (kind: string) => items.filter((i) => i.kind === kind);
    eq('站场同名自动复用', byKind('yard')[0].status, 'skipped');
    eq('道岔同号自动复用', byKind('switch')[0].status, 'skipped');
    eq('巡检同日自动复用', byKind('inspection')[0].status, 'skipped');
    const pf1 = items.find((i) => i.localId === 'pf1')!;
    eq('病害对回台账（按道岔+日期+部件）', pf1.ledgerId, 'f1');
    check('病害待选冲突含等级与销号两项', pf1.conflicts.length === 2, `冲突数 ${pf1.conflicts.length}`);
    eq('病害未逐项核准前状态为 conflict', pf1.status, 'conflict');
    const pw1 = items.find((i) => i.localId === 'pw1')!;
    const refGate = pw1.gates.find((g) => g.key === 'reference')!;
    check('作业单引用闸门在病害未核准时不成立', !refGate.ok, refGate.message);
    eq('整包存在阻断项', planBlockers(items).length > 0, true);

    // 逐项采用交回 → 作业单引用成立
    const decided = buildIntakePlan(
      {
        packageId: pack.packageId, contentHash: contentHash(pack), shift: pack.shift,
        yards: pack.yards, switches: pack.switches, inspections: pack.inspections,
        faults: pack.faults, workOrders: pack.workOrders,
      },
      ledger,
      { decisions: { [pf1.id]: 'accept' }, overrides: {} },
    );
    const pw1b = decided.items.find((i) => i.localId === 'pw1')!;
    check('病害核准后作业单引用闸门成立', pw1b.gates.find((g) => g.key === 'reference')!.ok);
    eq('整包无阻断', planBlockers(decided.items), []);

    // 合并行只改等级/销号，不整条覆盖（type/sizeMm 等沿用台账）
    const pf1b = decided.items.find((i) => i.localId === 'pf1')!;
    const writable = buildWritableRow(pf1b, decided.items, ledger)!;
    if (writable.kind === 'fault') {
      eq('合并病害仅采用核准字段 severity', writable.row.severity, 'heavy');
      eq('合并病害仅采用核准字段 state', writable.row.state, 'solved');
      eq('其余字段沿用台账（type=wear）', writable.row.type, 'wear');
      eq('沿用台账 id（不新建）', writable.row.id, 'f1');
    } else {
      check('合并病害行类型正确', false);
    }
  }

  // 全链路：初始化空库 → 播种 → 置成基线台账 → 收包 → 核准 → 写入
  await initDatabase();
  await resetDatabase();
  // 用确定性基线替换播种数据，保证对回结果可预期
  const { resetToLedger } = await import('./ledgerHelper');
  await resetToLedger(baseLedger());

  {
    const result = await receivePack(packWith());
    eq('首次接收成功', result.outcome, 'received');
    const batchId = result.batchId!;
    const dup = await receivePack(packWith());
    eq('同包重复接收被驳回', dup.outcome, 'duplicate');

    let batch = await getIntakeBatch(batchId);
    const pf1Item = batch!.items.find((i) => i.localId === 'pf1')!;
    await setItemDecision(batchId, pf1Item.id, 'accept');
    batch = await getIntakeBatch(batchId);
    check(
      '确认前仍有阻断？（作业单引用应已随核准解除）',
      planBlockers(batch!.items).length === 0,
      planBlockers(batch!.items).join('；'),
    );

    const applied = await applyIntakeBatch(batchId);
    eq('写入完成', applied.completed, true);
    const faults = await listFaults();
    const f1After = faults.find((f) => f.id === 'f1')!;
    eq('台账病害等级被逐项核准结果更新', f1After.severity, 'heavy');
    eq('台账病害销号被逐项核准结果更新', f1After.state, 'solved');
    eq('台账病害未被整条覆盖（type 保留）', f1After.type, 'wear');
    check('全新病害已插入台账', faults.some((f) => f.part === 'frog' && f.type === 'crack'), `病害数 ${faults.length}`);
    const orders = await listWorkOrders();
    const newOrder = orders.find((o) => o.code === 'TW-900')!;
    check('新作业单已插入', Boolean(newOrder));
    check(
      '作业单病害引用已重写为台账/新行 id',
      newOrder.faultIds.includes('f1') && newOrder.faultIds.some((id) => id !== 'pf2'),
      newOrder.faultIds.join(','),
    );
    check('未产生重复站场', (await readLedger()).yards.length === 1);

    // 已并入后同包再交 → 仍然去重，不覆盖
    const again = await receivePack(packWith());
    eq('已并入后同包仍拒绝重复接收', again.outcome, 'duplicate');
    await deleteIntakeBatch(batchId);
  }

  // 两份并存 + 编号重复 + 编排冲突
  {
    await resetToLedger(baseLedger());
    const pack = packWith({
      packageId: 'PK-TEST-KEEPBOTH',
      shift: '乙班',
      workOrders: [{
        id: 'pw1', code: 'TW-001', faultIds: ['pf2'], windowStart: '2026-10-02 09:30', windowEnd: '2026-10-02 10:30',
        leader: '孙立波', machines: ['轨距尺'], members: ['孙立波'], state: 'planned', createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION,
      }],
    });
    const received = await receivePack(pack);
    const batchId = received.batchId!;
    let batch = await getIntakeBatch(batchId);
    const orderItem = batch!.items.find((i) => i.localId === 'pw1')!;
    check('编号重复冲突被识别', orderItem.conflicts.some((c) => c.type === 'codeDup'));
    check('时间窗+人员/机具编排冲突被识别', orderItem.conflicts.some((c) => c.type === 'schedule'));
    // pf1 病害仍是冲突，作业单只引用 pf2（新增），但 pf1 不阻断该单；先核准 pf1 才能放行整包
    const pf1Item = batch!.items.find((i) => i.localId === 'pf1')!;
    await setItemDecision(batchId, pf1Item.id, 'discard'); // 剔除有分歧的病害
    await setItemDecision(batchId, orderItem.id, 'keepBoth');
    batch = await getIntakeBatch(batchId);
    const orderItem2 = batch!.items.find((i) => i.localId === 'pw1')!;
    check('并存改挂编号带班次后缀', Boolean(orderItem2.assignedCode?.includes('乙')), orderItem2.assignedCode);
    const blockers = planBlockers(batch!.items);
    check('剔除病害 + 并存作业单后无阻断', blockers.length === 0, blockers.join('；'));
    const res = await applyIntakeBatch(batchId);
    eq('并存写入完成', res.completed, true);
    const orders = await listWorkOrders();
    eq('原编号作业单仍在', orders.filter((o) => o.code === 'TW-001').length, 1);
    check('并存出一张改挂编号作业单', orders.some((o) => o.code.includes('TW-001-')), orders.map((o) => o.code).join(','));
    const faults = await listFaults();
    eq('被剔除的分歧病害未改变台账等级', faults.find((f) => f.id === 'f1')!.severity, 'medium');
    await deleteIntakeBatch(batchId);
  }

  // 病害「两份并存」：原台账病害原样保留 + 交回病害以新 id 插入，作业单引用新 id
  {
    await resetToLedger(baseLedger());
    const pack = packWith({ packageId: 'PK-TEST-FAULT-KEEPBOTH' });
    const received = await receivePack(pack);
    const batchId = received.batchId!;
    const batch = await getIntakeBatch(batchId);
    const pf1Item = batch!.items.find((i) => i.localId === 'pf1')!;
    await setItemDecision(batchId, pf1Item.id, 'keepBoth');
    const res = await applyIntakeBatch(batchId);
    eq('并存写入完成', res.completed, true);
    const faults = await listFaults();
    const original = faults.find((f) => f.id === 'f1')!;
    eq('原台账病害等级保持不变', original.severity, 'medium');
    eq('原台账病害销号保持不变', original.state, 'pending');
    // 同巡检同部件多出一条（交回的重级 / 已销号）
    const twins = faults.filter((f) => f.inspectionId === 'i1' && f.part === 'pointRail');
    eq('pointRail 病害两份并存', twins.length, 2);
    const inserted = twins.find((f) => f.id !== 'f1')!;
    eq('新增一份采用交回等级', inserted.severity, 'heavy');
    eq('新增一份采用交回销号', inserted.state, 'solved');
    const orders = await listWorkOrders();
    const wo900 = orders.find((o) => o.code === 'TW-900')!;
    check('作业单引用新插入病害 id（而非台账 f1）', wo900.faultIds.includes(inserted.id) && !wo900.faultIds.includes('f1'), wo900.faultIds.join(','));
    await deleteIntakeBatch(batchId);
  }

  // 断点续传：第 2 条失败 → 停下 → 从断点继续
  {
    await resetToLedger(baseLedger());
    const pack = packWith({ packageId: 'PK-TEST-RESUME' });
    const received = await receivePack(pack);
    const batchId = received.batchId!;
    const batch = await getIntakeBatch(batchId);
    await setItemDecision(batchId, batch!.items.find((i) => i.localId === 'pf1')!.id, 'accept');
    await armFailPoint(2); // 待写顺序：pf1 之后为 pf2，第二条失败
    const first = await applyIntakeBatch(batchId);
    eq('首次写入未完成', first.completed, false);
    let current = await getIntakeBatch(batchId);
    eq('中断后批次 paused', current!.status, 'paused');
    eq('已应用数量检查点为 1', current!.appliedCount, 1);
    check('停下原因已记录', Boolean(current!.stopReason?.includes('断点演练')), current!.stopReason ?? '');
    const faultsMid = await listFaults();
    check('第一条已落库（f1 已改重级）', faultsMid.find((f) => f.id === 'f1')!.severity === 'heavy');
    check('第二条未落库', !faultsMid.some((f) => f.type === 'crack' && f.part === 'frog'));

    const second = await applyIntakeBatch(batchId);
    eq('从断点继续后完成', second.completed, true);
    current = await getIntakeBatch(batchId);
    eq('恢复后批次 applied', current!.status, 'applied');
    const faultsEnd = await listFaults();
    check('第二条随后落库', faultsEnd.some((f) => f.type === 'crack' && f.part === 'frog'));
    const ordersEnd = await listWorkOrders();
    check('作业单在续传时写入', ordersEnd.some((o) => o.code === 'TW-900'));
    eq('没有重复写入（f1 仅一条）', faultsEnd.filter((f) => f.id === 'f1').length, 1);
    await deleteIntakeBatch(batchId);
  }

  // 归属闸门：巡检指向包内缺失道岔 → blocked → 人工改指到台账道岔后放行（不新建道岔）
  {
    await resetToLedger(baseLedger());
    const pack = packWith({
      packageId: 'PK-TEST-ATTR',
      yards: [],
      switches: [],
      // 巡检引用了包内不存在的道岔 ps9（现场只交了病害评定）
      inspections: [{ id: 'pi9', switchId: 'ps9', date: '2026-09-30', inspector: '钱七', weather: 'sunny', method: 'manual', createdAt: stamp, revision: ROW_REVISION }],
      faults: [{ id: 'pf9', inspectionId: 'pi9', part: 'frog', type: 'gap', severity: 'heavy', sizeMm: 2, state: 'pending', solvedAt: null, createdAt: stamp, revision: ROW_REVISION }],
      workOrders: [],
    });
    const received = await receivePack(pack);
    const batchId = received.batchId!;
    let batch = await getIntakeBatch(batchId);
    const faultItem = batch!.items.find((i) => i.localId === 'pf9')!;
    eq('归属不到道岔时 blocked', faultItem.status, 'blocked');
    // 人工把缺失道岔 ps9 改指台账 s1（1#）
    await setAttributionOverride(batchId, 'ps9', 's1');
    batch = await getIntakeBatch(batchId);
    const after = batch!.items.find((i) => i.localId === 'pf9')!;
    check('改指后归属闸门成立', after.gates.every((g) => g.ok), after.gates.map((g) => g.message).join('；'));
    const res = await applyIntakeBatch(batchId);
    eq('改指后可写入', res.completed, true);
    const ledger = await readLedger();
    check('新病害挂到台账巡检 i1', ledger.faults.some((f) => f.inspectionId === 'i1' && f.part === 'frog'));
    check('未凭空建立新站场道岔（站场仍 1 个 / 道岔仍 1 组）', ledger.yards.length === 1 && ledger.switches.length === 1);
    await deleteIntakeBatch(batchId);
  }

  // 旧备份迁移清单
  {
    await resetToLedger(baseLedger());
    const legacy = {
      name: 'gbrailswitch', schemaVersion: 1, exportedAt: '2026-01-01 00:00',
      yards: [],
      switches: [],
      inspections: [],
      faults: [{ id: 'lf1', inspectionId: 'missing-insp', faultPart: 'machine', faultType: 'crack', severity: 'light', state: 'pending', sizeMm: null, solvedAt: null, createdAt: stamp }],
      workOrders: [{ id: 'lw1', code: 'TW-OLD', faultIds: 'lf1,ghost', members: '赵', machines: '道尺', leader: '赵', windowStart: 'x', windowEnd: 'y', state: 'planned', createdAt: stamp, updatedAt: stamp }],
      restrictions: [],
    };
    const received = await receiveLegacy(legacy, 'old-backup.json');
    eq('旧备份进入 migrate', received.outcome, 'received');
    const batchId = received.batchId!;
    let batch = await getIntakeBatch(batchId);
    eq('旧备份批次状态 migrate', batch!.status, 'migrate');
    check('迁移清单识别旧字段名', batch!.migrationChecks.some((c) => c.key === 'legacy-fault-fields' && c.level === 'warn'));
    check('迁移清单识别孤儿病害风险', batch!.migrationChecks.some((c) => c.key === 'orphan-faults' && c.level === 'danger'));
    const before = await finalizeMigrationPlan(batchId);
    eq('未核对完清单不能生成计划', before.outcome, 'invalid');
    for (const checkItem of batch!.migrationChecks) {
      await toggleMigrationCheck(batchId, checkItem.key);
    }
    const finalized = await finalizeMigrationPlan(batchId);
    eq('清单核对完成后生成计划', finalized.outcome, 'received');
    batch = await getIntakeBatch(batchId);
    check('旧字段已归一化（part=machine）', batch!.items.some((i) => i.kind === 'fault' && (i.payload as Fault).part === 'machine'));
    const wo = batch!.items.find((i) => i.kind === 'workOrder')!;
    check('字符串 faultIds 已拆数组', Array.isArray((wo.payload as WorkOrder).faultIds) && (wo.payload as WorkOrder).faultIds.length === 2);
    // 引用断裂 + 归属缺失：旧备份数据无法落库，必须停在接收区
    const blockers = planBlockers(batch!.items);
    check('孤儿病害 / 断裂引用被闸门拦截', blockers.length > 0, blockers.join('；'));
    await deleteIntakeBatch(batchId);
  }

  // 多标签同时接收同一包：只能有一个成功
  {
    await resetToLedger(baseLedger());
    const pack = packWith({ packageId: 'PK-TEST-RACE' });
    const [a, b] = await Promise.all([receivePack(pack), receivePack(pack)]);
    const outcomes = [a.outcome, b.outcome].sort();
    eq('同包并发接收恰有一个成功', outcomes, ['duplicate', 'received']);
    const accepted = a.outcome === 'received' ? a : b;
    await deleteIntakeBatch(accepted.batchId!);
  }

  // 多标签同时确认同一包：只能有一个完成写入
  {
    await resetToLedger(baseLedger());
    const received = await receivePack(packWith({ packageId: 'PK-TEST-APPLY-RACE' }));
    const batchId = received.batchId!;
    const batch = await getIntakeBatch(batchId);
    await setItemDecision(batchId, batch!.items.find((i) => i.localId === 'pf1')!.id, 'accept');
    const [r1, r2] = await Promise.all([applyIntakeBatch(batchId), applyIntakeBatch(batchId)]);
    const completed = [r1, r2].filter((r) => r.completed && !r.message.includes('另一标签'));
    eq('并发确认恰有一个完成', completed.length, 1);
    const ledger = await readLedger();
    eq('并发写入不产生重复作业单', ledger.workOrders.filter((o) => o.code === 'TW-900').length, 1);
    const finalBatch = await getIntakeBatch(batchId);
    eq('终态为已并入', finalBatch!.status, 'applied');
    await deleteIntakeBatch(batchId);
  }

  // 文件入口：非法 JSON
  {
    const bad = new File(['{not-json'], 'x.json', { type: 'application/json' });
    const res = await receiveIntakeFile(bad);
    eq('非法文件被识别', res.outcome, 'invalid');
  }

  console.log(`\n通过 ${passed} 项断言，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
