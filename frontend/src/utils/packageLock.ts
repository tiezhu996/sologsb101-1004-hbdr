/**
 * 跨标签合并互斥：多标签同时接收 / 合并同一包时只能有一个完成。
 * 通过接收区行上的 applyOwner + applyLeaseUntil 租约实现；
 * 认领、查重与续期都在 Dexie 事务内完成（同源标签页的事务互斥执行），
 * 持有方崩溃后租约到期，其它标签页可接管并从断点继续。
 */
import { uuid } from './format';

/** 本标签页 id（模块加载时生成一次） */
export const TAB_ID = `tab-${uuid()}`;

/** 合并租约时长（毫秒）：每写入一条记录续期一次 */
export const APPLY_LEASE_MS = 10000;

/** 租约到期时间戳 */
export function leaseUntil(now: number = Date.now()): number {
  return now + APPLY_LEASE_MS;
}

/** 租约是否仍有效 */
export function isLeaseLive(
  row: { applyOwner: string | null; applyLeaseUntil: number },
  now: number = Date.now(),
): boolean {
  return Boolean(row.applyOwner) && row.applyLeaseUntil > now;
}

/** 本标签页是否可认领（无人持有有效租约，或租约就是自己的） */
export function canClaim(
  row: { applyOwner: string | null; applyLeaseUntil: number },
  tabId: string = TAB_ID,
): boolean {
  return !isLeaseLive(row) || row.applyOwner === tabId;
}
