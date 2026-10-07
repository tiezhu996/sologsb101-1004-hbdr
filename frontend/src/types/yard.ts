import type { Revisioned } from './persistence';

/** 站场 */
export interface Yard extends Revisioned {
  id: string;
  /** 站场名 */
  name: string;
  /** 中心里程，如 K312+450 */
  mileage: string;
  /** 线路数 */
  trackCount: number;
  /** 管辖车间 */
  region: string;
  createdAt: string;
}

/** 站场表单草稿 */
export interface YardDraft {
  name: string;
  mileage: string;
  trackCount: number;
  region: string;
}

/** 站场视图：卡片回显道岔数与待修病害数 */
export interface YardView extends Yard {
  switchCount: number;
  faultCount: number;
  pendingFaultCount: number;
  /** 重级病害数 */
  severeCount: number;
}

/** 里程格式化：把纯数字里程转成 Kxxx+xxx 口径 */
export function formatMileage(km: number, meter: number): string {
  const kmText = Math.max(0, Math.floor(km));
  const meterText = String(Math.max(0, Math.min(999, Math.round(meter)))).padStart(3, '0');
  return `K${kmText}+${meterText}`;
}

/** 从里程字符串解析公里数，解析失败返回 0 */
export function mileageKm(mileage: string): number {
  const matched = /K?(\d+)\+(\d+)/.exec(mileage);
  if (!matched) return 0;
  return Number(matched[1]) + Number(matched[2]) / 1000;
}

/** 管辖车间分组统计口径 */
export function regionLabel(region: string): string {
  return region.trim() || '未指定车间';
}
