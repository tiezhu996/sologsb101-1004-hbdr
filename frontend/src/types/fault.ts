import type { Revisioned } from './persistence';

/** 病害部件 */
export type FaultPart = 'pointRail' | 'stockRail' | 'frog' | 'machine';

/** 病害类型 */
export type FaultType = 'wear' | 'spalling' | 'crack' | 'gap' | 'looseBolt';

/** 病害等级 */
export type FaultSeverity = 'light' | 'medium' | 'heavy';

/** 病害状态 */
export type FaultState = 'pending' | 'solved';

export const FAULT_PART_LABEL: Record<FaultPart, string> = {
  pointRail: '尖轨',
  stockRail: '基本轨',
  frog: '辙叉',
  machine: '转辙机',
};

export const FAULT_TYPE_LABEL: Record<FaultType, string> = {
  wear: '磨耗',
  spalling: '掉块',
  crack: '裂纹',
  gap: '离缝',
  looseBolt: '螺栓松动',
};

export const FAULT_SEVERITY_LABEL: Record<FaultSeverity, string> = {
  light: '轻',
  medium: '中',
  heavy: '重',
};

export const FAULT_STATE_LABEL: Record<FaultState, string> = {
  pending: '待修',
  solved: '已销号',
};

export const FAULT_PARTS: FaultPart[] = ['pointRail', 'stockRail', 'frog', 'machine'];
export const FAULT_TYPES: FaultType[] = ['wear', 'spalling', 'crack', 'gap', 'looseBolt'];
export const FAULT_SEVERITIES: FaultSeverity[] = ['light', 'medium', 'heavy'];

/** 病害 */
export interface Fault extends Revisioned {
  id: string;
  /** 所属巡检 */
  inspectionId: string;
  /** 部件 */
  part: FaultPart;
  /** 病害类型 */
  type: FaultType;
  /** 等级 */
  severity: FaultSeverity;
  /** 尺寸（mm），无尺寸病害为 null */
  sizeMm: number | null;
  /** 状态 */
  state: FaultState;
  /** 销号时间 */
  solvedAt: string | null;
  createdAt: string;
}

/** 病害表单草稿 */
export interface FaultDraft {
  inspectionId: string;
  part: FaultPart;
  type: FaultType;
  severity: FaultSeverity;
  sizeMm: number | null;
}

/** 病害视图：带巡检与道岔上下文 */
export interface FaultView extends Fault {
  switchId: string;
  switchCode: string;
  yardId: string;
  yardName: string;
  inspectionDate: string;
  inspector: string;
  /** 是否已编排进天窗作业单 */
  planned: boolean;
  /** 关联作业单号 */
  workOrderCodes: string[];
}

/** 部件巡检要点 */
export const PART_CHECK_HINT: Record<FaultPart, string> = {
  pointRail: '尖轨与基本轨密贴、轨距加宽、尖端掉块',
  stockRail: '基本轨磨耗、肥边、接头错牙',
  frog: '辙叉心磨耗、翼轨掉块、有害空间',
  machine: '转辙机动作杆旷动、锁闭装置、表示缺口',
};
