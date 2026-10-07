/** 病害等级权重、配色映射与毫米尺寸归一化显示 */
import type { FaultSeverity } from '../types/fault';
import { FAULT_SEVERITY_LABEL } from '../types/fault';

/** 等级权重：重 > 中 > 轻，用于排序与批量升级 */
export const SEVERITY_WEIGHT: Record<FaultSeverity, number> = {
  light: 1,
  medium: 2,
  heavy: 3,
};

/** 等级配色（与 MUI Chip 的 color 语义对应） */
export const SEVERITY_COLOR: Record<FaultSeverity, 'default' | 'warning' | 'error'> = {
  light: 'default',
  medium: 'warning',
  heavy: 'error',
};

/** 等级对应的十六进制底色，用于图表与内联样式 */
export const SEVERITY_HEX: Record<FaultSeverity, string> = {
  light: '#8a8f99',
  medium: '#ed6c02',
  heavy: '#d32f2f',
};

/** 等级背景浅色 */
export const SEVERITY_BG: Record<FaultSeverity, string> = {
  light: '#f5f6f8',
  medium: '#fff4e5',
  heavy: '#fdecea',
};

/** 等级图标（MUI 图标名，供页面映射） */
export const SEVERITY_ICON: Record<FaultSeverity, 'CheckCircle' | 'WarningAmber' | 'ErrorOutline'> = {
  light: 'CheckCircle',
  medium: 'WarningAmber',
  heavy: 'ErrorOutline',
};

/** 等级中文标签 */
export function severityText(severity: FaultSeverity): string {
  return FAULT_SEVERITY_LABEL[severity];
}

/** 等级比较：返回正数表示 a 更严重 */
export function compareSeverity(a: FaultSeverity, b: FaultSeverity): number {
  return SEVERITY_WEIGHT[a] - SEVERITY_WEIGHT[b];
}

/** 排序：重 → 中 → 轻 */
export function sortBySeverity<T extends { severity: FaultSeverity }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
}

/** 升级一级等级，已是重级则保持 */
export function escalate(severity: FaultSeverity): FaultSeverity {
  if (severity === 'light') return 'medium';
  if (severity === 'medium') return 'heavy';
  return 'heavy';
}

/**
 * 毫米尺寸归一化显示：
 * - 无尺寸（null）显示为「—」
 * - 小于 1mm 显示到 0.1mm
 * - 其余按整数毫米显示
 */
export function formatSizeMm(sizeMm: number | null): string {
  if (sizeMm === null || Number.isNaN(sizeMm)) return '—';
  if (Math.abs(sizeMm) < 1) return `${sizeMm.toFixed(1)} mm`;
  return `${Math.round(sizeMm)} mm`;
}

/** 依据尺寸与等级给出超限判断（磨耗类：>8mm 重级、>4mm 中级的参考口径） */
export function sizeSeverityHint(sizeMm: number | null): string {
  if (sizeMm === null) return '无尺寸记录，按外观判定等级';
  if (sizeMm >= 8) return '尺寸超限明显，建议按重级处理并纳入天窗修';
  if (sizeMm >= 4) return '尺寸接近限值，建议按中级跟踪观察';
  return '尺寸在容许范围内，可按轻级销号';
}

/** 统计各等级数量 */
export function countBySeverity<T extends { severity: FaultSeverity }>(
  rows: T[],
): Record<FaultSeverity, number> {
  return {
    light: rows.filter((item) => item.severity === 'light').length,
    medium: rows.filter((item) => item.severity === 'medium').length,
    heavy: rows.filter((item) => item.severity === 'heavy').length,
  };
}
