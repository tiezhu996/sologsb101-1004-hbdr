/**
 * 离线包导出：巡检班无网作业结束后，把本班病害评定与天窗单打包交回调度台。
 * 与整库备份区分：离线包带 kind / packageId 标识，接收区据此直接入区核准，而不是整库覆盖。
 */
import type { OfflinePack } from '../types/intake';
import { INTAKE_PACKAGE_KIND, INTAKE_PACKAGE_VERSION } from '../types/intake';
import { DB_SCHEMA_VERSION, listFaults, listInspections, listSwitches, listWorkOrders, listYards } from './db';
import { nowIso } from './format';
import { todayDate } from './window';

export interface OfflinePackOptions {
  /** 班次：甲班 / 乙班 */
  shift: string;
  /** 作业人员 */
  crew?: string;
  note?: string;
  /** 固定 packageId（演示用）；不传则按内容自动生成 */
  packageId?: string;
  /** 可选范围：只导出某些道岔及其巡检 / 病害 / 作业单 */
  switchIds?: string[];
}

function packHash6(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** 从本机台账导出一份离线包 */
export async function exportOfflinePack(options: OfflinePackOptions): Promise<OfflinePack> {
  const [yardsAll, switchesAll, inspectionsAll, faultsAll, workOrdersAll] = await Promise.all([
    listYards(),
    listSwitches(),
    listInspections(),
    listFaults(),
    listWorkOrders(),
  ]);

  let switches = switchesAll;
  let inspections = inspectionsAll;
  let faults = faultsAll;
  let workOrders = workOrdersAll;
  let yards = yardsAll;

  if (options.switchIds && options.switchIds.length > 0) {
    const switchSet = new Set(options.switchIds);
    switches = switchesAll.filter((item) => switchSet.has(item.id));
    const yardSet = new Set(switches.map((item) => item.yardId));
    yards = yardsAll.filter((item) => yardSet.has(item.id));
    const inspectionSet = new Set(inspections.filter((item) => switchSet.has(item.switchId)).map((item) => item.id));
    inspections = inspections.filter((item) => inspectionSet.has(item.id));
    faults = faults.filter((item) => inspectionSet.has(item.inspectionId));
    const faultSet = new Set(faults.map((item) => item.id));
    workOrders = workOrders
      .map((order) => ({ ...order, faultIds: order.faultIds.filter((id) => faultSet.has(id)) }))
      .filter((order) => order.faultIds.length > 0);
  }

  return {
    kind: INTAKE_PACKAGE_KIND,
    packageVersion: INTAKE_PACKAGE_VERSION,
    packageId: options.packageId || `PK-${todayDate().replace(/-/g, '')}-${options.shift === '乙班' ? 'YI' : 'JIA'}-${packHash6()}`,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso().replace('T', ' ').slice(0, 16),
    shift: options.shift,
    crew: options.crew ?? '',
    note: options.note ?? '',
    yards,
    switches,
    inspections,
    faults,
    workOrders,
  };
}
