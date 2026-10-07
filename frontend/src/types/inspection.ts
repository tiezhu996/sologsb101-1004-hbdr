import type { Revisioned } from './persistence';

/** 气象条件 */
export type Weather = 'sunny' | 'rain' | 'snow' | 'wind';

/** 检查方式 */
export type InspectMethod = 'manual' | 'car' | 'ride';

export const WEATHER_LABEL: Record<Weather, string> = {
  sunny: '晴',
  rain: '雨',
  snow: '雪',
  wind: '大风',
};

export const METHOD_LABEL: Record<InspectMethod, string> = {
  manual: '手工检查',
  car: '轨检车',
  ride: '添乘',
};

/** 巡检 */
export interface Inspection extends Revisioned {
  id: string;
  /** 所属道岔 */
  switchId: string;
  /** 巡检日期 yyyy-MM-dd */
  date: string;
  /** 巡检人 */
  inspector: string;
  /** 气象条件 */
  weather: Weather;
  /** 检查方式 */
  method: InspectMethod;
  createdAt: string;
}

/** 巡检表单草稿 */
export interface InspectionDraft {
  switchId: string;
  date: string;
  inspector: string;
  weather: Weather;
  method: InspectMethod;
}

/** 巡检视图：带道岔上下文与病害统计 */
export interface InspectionView extends Inspection {
  switchCode: string;
  yardId: string;
  yardName: string;
  frogNumber: string;
  faultCount: number;
  severeCount: number;
  pendingCount: number;
}

/** 气象对检查的附加提示 */
export function weatherHint(weather: Weather): string {
  if (weather === 'rain') return '雨天注意尖轨与基本轨间离缝，重点检查绝缘接头';
  if (weather === 'snow') return '雪天重点清扫转辙机动作部位，防止积雪卡阻';
  if (weather === 'wind') return '大风天注意添乘观察方向与轨向，避免登高作业';
  return '常规天气，按标准检查项逐项确认';
}

/** 检查方式对应的记录要求 */
export function methodHint(method: InspectMethod): string {
  if (method === 'car') return '轨检车数据需与现场复核一致，超限处所单独复核';
  if (method === 'ride') return '添乘发现的晃车处所应安排现场复核并记录里程';
  return '手工检查需逐项记录部件状态与尺寸';
}
