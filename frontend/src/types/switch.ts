import type { Revisioned } from './persistence';

/** 辙叉号 */
export type FrogNumber = '9' | '12' | '18';

/** 轨型 */
export type RailType = '60kg/m' | '50kg/m';

/** 道岔类型 */
export type TurnoutType = 'single' | 'double' | 'crossing';

export const TURNOUT_TYPE_LABEL: Record<TurnoutType, string> = {
  single: '单开',
  double: '双开',
  crossing: '交分',
};

export const FROG_NUMBER_OPTIONS: FrogNumber[] = ['9', '12', '18'];
export const RAIL_TYPE_OPTIONS: RailType[] = ['60kg/m', '50kg/m'];

/** 道岔 */
export interface Switch extends Revisioned {
  id: string;
  /** 所属站场 */
  yardId: string;
  /** 道岔编号，如 12# */
  code: string;
  /** 辙叉号 */
  frogNumber: FrogNumber;
  /** 轨型 */
  railType: RailType;
  /** 位置描述 */
  position: string;
  /** 道岔类型 */
  turnoutType: TurnoutType;
  createdAt: string;
}

/** 道岔表单草稿 */
export interface SwitchDraft {
  yardId: string;
  code: string;
  frogNumber: FrogNumber;
  railType: RailType;
  position: string;
  turnoutType: TurnoutType;
}

/** 道岔视图：带站场上下文与病害统计 */
export interface SwitchView extends Switch {
  yardName: string;
  region: string;
  inspectionCount: number;
  faultCount: number;
  pendingFaultCount: number;
}

/** 辙叉号对应的允许侧向通过速度（km/h，参考值） */
export const FROG_SPEED_LIMIT: Record<FrogNumber, number> = {
  '9': 30,
  '12': 45,
  '18': 80,
};

/** 道岔状态判定：按待修病害数与重级病害数给出建议 */
export function switchHealth(pendingFaultCount: number, severeCount: number): '正常' | '关注' | '重点' {
  if (severeCount > 0 || pendingFaultCount >= 3) return '重点';
  if (pendingFaultCount > 0) return '关注';
  return '正常';
}

/** 轨型重量（kg/m），用于机具配置提示 */
export function railWeight(railType: RailType): number {
  return railType === '60kg/m' ? 60 : 50;
}
