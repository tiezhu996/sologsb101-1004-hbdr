/**
 * 病害筛选 hook
 * 维护站场、部件、等级、状态筛选状态并返回派生列表与分组计数，
 * 被病害评定页、巡检录入页消费（筛选条件存 Redux，跨页保留）。
 */
import { useMemo } from 'react';
import { useAppDispatch, useAppSelector } from './useAppStore';
import {
  selectFaultCounts,
  selectFaultViews,
  selectFilteredFaults,
  setPartFilters,
  setSeverityFilters,
  setStateFilters,
} from '../stores/faultStore';
import type { FaultPart, FaultSeverity, FaultState, FaultView } from '../types/fault';
import { countBySeverity } from '../utils/severity';

export interface FaultFilterResult {
  /** 命中筛选的病害 */
  faults: FaultView[];
  /** 全量病害 */
  allFaults: FaultView[];
  /** 等级 / 状态计数 */
  counts: ReturnType<typeof selectFaultCounts>;
  /** 等级分组计数 */
  severityCounts: Record<FaultSeverity, number>;
  /** 部件分组计数 */
  partCounts: Record<FaultPart, number>;
  /** 按站场分组计数 */
  yardCounts: Array<{ yardId: string; yardName: string; count: number; pending: number }>;
  /** 当前筛选值 */
  partFilters: FaultPart[];
  severityFilters: FaultSeverity[];
  stateFilters: FaultState[];
  setPartFilters: (values: FaultPart[]) => void;
  setSeverityFilters: (values: FaultSeverity[]) => void;
  setStateFilters: (values: FaultState[]) => void;
  resetFilters: () => void;
  /** 是否处于筛选状态 */
  active: boolean;
}

export function useFaultFilter(): FaultFilterResult {
  const dispatch = useAppDispatch();
  const faults = useAppSelector(selectFilteredFaults);
  const allFaults = useAppSelector(selectFaultViews);
  const counts = useAppSelector(selectFaultCounts);
  const partFilters = useAppSelector((state) => state.fault.partFilters);
  const severityFilters = useAppSelector((state) => state.fault.severityFilters);
  const stateFilters = useAppSelector((state) => state.fault.stateFilters);

  const severityCounts = useMemo(() => countBySeverity(allFaults), [allFaults]);

  const partCounts = useMemo<Record<FaultPart, number>>(
    () => ({
      pointRail: allFaults.filter((item) => item.part === 'pointRail').length,
      stockRail: allFaults.filter((item) => item.part === 'stockRail').length,
      frog: allFaults.filter((item) => item.part === 'frog').length,
      machine: allFaults.filter((item) => item.part === 'machine').length,
    }),
    [allFaults],
  );

  const yardCounts = useMemo(() => {
    const buckets = new Map<string, { yardId: string; yardName: string; count: number; pending: number }>();
    for (const fault of allFaults) {
      const bucket =
        buckets.get(fault.yardId) ??
        { yardId: fault.yardId, yardName: fault.yardName || '未归属站场', count: 0, pending: 0 };
      bucket.count += 1;
      if (fault.state === 'pending') bucket.pending += 1;
      buckets.set(fault.yardId, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.count - a.count);
  }, [allFaults]);

  return {
    faults,
    allFaults,
    counts,
    severityCounts,
    partCounts,
    yardCounts,
    partFilters,
    severityFilters,
    stateFilters,
    setPartFilters: (values) => dispatch(setPartFilters(values)),
    setSeverityFilters: (values) => dispatch(setSeverityFilters(values)),
    setStateFilters: (values) => dispatch(setStateFilters(values)),
    resetFilters: () => {
      dispatch(setPartFilters([]));
      dispatch(setSeverityFilters([]));
      dispatch(setStateFilters([]));
    },
    active: partFilters.length > 0 || severityFilters.length > 0 || stateFilters.length > 0,
  };
}
