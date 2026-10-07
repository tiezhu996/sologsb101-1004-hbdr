/**
 * 离线包演示生成：模拟巡检甲 / 乙班无网作业后交回调度台的离线包。
 * 从当前台账挑选真实站场 / 道岔，重新分配包内 id（对回只认「站场+道岔号+日期+部件」），
 * 刻意构造等级冲突、销号冲突、天窗编号重复与时间窗 / 人员 / 机具编排冲突。
 */
import type { Inspection } from '../types/inspection';
import type { Fault } from '../types/fault';
import type { Switch } from '../types/switch';
import type { WorkOrder } from '../types/workOrder';
import type { Yard } from '../types/yard';
import { ROW_REVISION } from '../types/persistence';
import type { OfflinePack } from '../types/intake';
import { listFaults, listInspections, listSwitches, listWorkOrders, listYards } from './db';
import { nowIso } from './format';
import { shiftDate, todayDate } from './window';

export interface DemoPackOptions {
  shift: '甲班' | '乙班';
  crew?: string;
}

/** 生成一份可直接 receivePack 的演示离线包 */
export async function buildDemoPack(options: DemoPackOptions): Promise<OfflinePack> {
  const isYi = options.shift === '乙班';
  const [yardsAll, switchesAll, inspectionsAll, faultsAll, ordersAll] = await Promise.all([
    listYards(),
    listSwitches(),
    listInspections(),
    listFaults(),
    listWorkOrders(),
  ]);

  // 选第一个站场的前两组道岔作为交回范围
  const yard = yardsAll[0];
  if (!yard) throw new Error('台账为空，无法生成演示离线包');
  const chosenSwitches = switchesAll.filter((item) => item.yardId === yard.id).slice(0, 2);
  const chosenSwitchIds = new Set(chosenSwitches.map((item) => item.id));
  const chosenInspections = inspectionsAll.filter((item) => chosenSwitchIds.has(item.switchId));
  const chosenInspectionIds = new Set(chosenInspections.map((item) => item.id));
  const chosenFaults = faultsAll.filter((item) => chosenInspectionIds.has(item.inspectionId));

  // 包内 id 一律重发，证明对回不依赖台账 id
  const yards: Yard[] = [{ ...yard, id: 'pack-yard-1', createdAt: nowIso(), revision: ROW_REVISION }];
  const switches: Switch[] = chosenSwitches.map((item, index) => ({
    ...item,
    id: `pack-sw-${index + 1}`,
    yardId: 'pack-yard-1',
    createdAt: nowIso(),
    revision: ROW_REVISION,
  }));
  const inspections: Inspection[] = chosenInspections.map((item, index) => ({
    ...item,
    id: `pack-insp-${index + 1}`,
    switchId: switches[chosenSwitches.findIndex((sw) => sw.id === item.switchId)]?.id ?? item.switchId,
    createdAt: nowIso(),
    revision: ROW_REVISION,
  }));

  const inspectionIdMap = new Map(chosenInspections.map((item, index) => [item.id, `pack-insp-${index + 1}`]));
  const faults: Fault[] = chosenFaults.slice(0, 4).map((item, index) => ({
    ...item,
    id: `pack-fault-${index + 1}`,
    inspectionId: inspectionIdMap.get(item.inspectionId) ?? item.inspectionId,
    createdAt: nowIso(),
    revision: ROW_REVISION,
  }));

  // 冲突 1：把第一条病害等级与销号都改成与台账不一致（两份必须逐项核准，不能整条盖掉）
  if (faults[0]) {
    faults[0] = {
      ...faults[0],
      severity: faults[0].severity === 'heavy' ? 'light' : faults[0].severity === 'light' ? 'medium' : 'heavy',
      state: faults[0].state === 'solved' ? 'pending' : 'solved',
      solvedAt: faults[0].state === 'solved' ? null : `${todayDate()} 16:20`,
    };
  }
  // 冲突 2：乙班再交一条对到同键的等级分歧，模拟两班各评定一次
  if (isYi && faults[1]) {
    faults[1] = {
      ...faults[1],
      severity: faults[1].severity === 'light' ? 'heavy' : 'light',
    };
  }
  // 新增一条包内病害（台账无同键记录，应直接新建）
  const anchorInspection = inspections[0];
  if (anchorInspection) {
    faults.push({
      id: 'pack-fault-new',
      inspectionId: anchorInspection.id,
      part: 'machine',
      type: 'gap',
      severity: 'medium',
      sizeMm: 3.5,
      state: 'pending',
      solvedAt: null,
      createdAt: nowIso(),
      revision: ROW_REVISION,
    });
  }

  // 冲突 3：交回一张与台账重号但编排不同的作业单（编号重复 → 覆盖字段 or 改号并存）
  const sameCodeOrder = ordersAll[0];
  const workOrders: WorkOrder[] = [];
  if (sameCodeOrder) {
    workOrders.push({
      ...sameCodeOrder,
      id: 'pack-wo-1',
      faultIds: faults.slice(0, 2).map((item) => item.id),
      windowStart: `${shiftDate(1)} 09:00`,
      windowEnd: `${shiftDate(1)} 11:00`,
      leader: isYi ? '吴长胜' : '赵铁军',
      members: isYi ? ['吴长胜', '韩学斌'] : ['赵铁军', '孙立波'],
      machines: ['轨距尺', '发电机'],
      state: 'planned',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  }
  // 冲突 4：另一张作业单刻意与台账作业单时间窗重叠且共用人员 / 机具
  const overlapOrder = ordersAll.find((item) => item.id !== sameCodeOrder?.id) ?? sameCodeOrder;
  if (overlapOrder && faults[2]) {
    workOrders.push({
      id: 'pack-wo-2',
      code: `TW-PACK-${isYi ? 'YI' : 'JIA'}`,
      faultIds: [faults[2].id, 'pack-fault-new'],
      windowStart: overlapOrder.windowStart,
      windowEnd: overlapOrder.windowEnd,
      leader: isYi ? '韩学斌' : '孙立波',
      members: overlapOrder.members.slice(0, 1),
      machines: overlapOrder.machines.slice(0, 1),
      state: 'planned',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  }

  return {
    kind: 'gbrailswitch-offline-pack',
    packageVersion: 1,
    packageId: `PK-DEMO-${isYi ? 'YIBAN' : 'JIABAN'}`,
    schemaVersion: ROW_REVISION,
    exportedAt: `${todayDate()} ${isYi ? '18' : '17'}:40`,
    shift: options.shift,
    crew: options.crew ?? (isYi ? '吴长胜、韩学斌' : '赵铁军、孙立波'),
    note: `演示离线包：${options.shift}无网巡检交回，含等级 / 销号 / 编号 / 编排冲突`,
    yards,
    switches,
    inspections,
    faults,
    workOrders,
  };
}
