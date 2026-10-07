/**
 * 销号与归档辅助：集中登记病害销号、天窗作业单归档所需的判定口径与摘要文案，
 * 供病害评定页、进度页与备份页共用，避免同类规则散落在各页面。
 */
import type { FaultSeverity, FaultState, FaultView } from './fault';
import { FAULT_SEVERITY_LABEL } from './fault';
import type { WorkOrderState, WorkOrderView } from './workOrder';
import { WORK_ORDER_STATE_LABEL } from './workOrder';

/** 归档保留年限（年） */
export const ARCHIVE_KEEP_YEARS = 3;

/** 销号判定：重级病害必须关联作业单才允许直接销号 */
export function canSolveDirectly(fault: Pick<FaultView, 'severity' | 'planned'>): { ok: boolean; message: string } {
  if (fault.severity === 'heavy' && !fault.planned) {
    return { ok: false, message: '重级病害建议先编排天窗作业单，再随作业完成销号' };
  }
  return { ok: true, message: '可手工销号' };
}

/** 销号率 */
export function solveRate(faults: Array<{ state: FaultState }>): number {
  if (faults.length === 0) return 0;
  const solved = faults.filter((item) => item.state === 'solved').length;
  return Number(((solved / faults.length) * 100).toFixed(1));
}

/** 等级分布摘要 */
export function severitySummary(faults: Array<{ severity: FaultSeverity }>): string {
  const counts: Record<FaultSeverity, number> = { light: 0, medium: 0, heavy: 0 };
  for (const fault of faults) counts[fault.severity] += 1;
  return (Object.keys(counts) as FaultSeverity[])
    .map((severity) => `${FAULT_SEVERITY_LABEL[severity]} ${counts[severity]}`)
    .join(' · ');
}

/** 作业单归档条件：全部关联病害已销号 */
export function canArchiveOrder(order: WorkOrderView): { ok: boolean; message: string } {
  if (order.state !== 'done') {
    return { ok: false, message: `作业单处于「${WORK_ORDER_STATE_LABEL[order.state]}」，完成后才能归档` };
  }
  if (order.pendingFaultCount > 0) {
    return { ok: false, message: `仍有 ${order.pendingFaultCount} 处关联病害未销号` };
  }
  return { ok: true, message: '关联病害已全部销号，可归档' };
}

/** 作业单归档摘要 */
export function orderSummary(order: WorkOrderView): string {
  return `${order.code}：${order.windowStart} ~ ${order.windowEnd.slice(-5)} · ${
    WORK_ORDER_STATE_LABEL[order.state]
  } · 病害 ${order.faultIds.length} 处 · 负责人 ${order.leader} · 资料保留 ${ARCHIVE_KEEP_YEARS} 年`;
}

/** 批量销号前置校验：返回不可直接销号的病害 */
export function partitionSolvable(faults: FaultView[]): { solvable: FaultView[]; blocked: FaultView[] } {
  const solvable: FaultView[] = [];
  const blocked: FaultView[] = [];
  for (const fault of faults) {
    if (canSolveDirectly(fault).ok) solvable.push(fault);
    else blocked.push(fault);
  }
  return { solvable, blocked };
}

/** 状态中文名 */
export function stateText(state: WorkOrderState): string {
  return WORK_ORDER_STATE_LABEL[state];
}
