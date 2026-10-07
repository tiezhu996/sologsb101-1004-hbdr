/**
 * 离线包接收区状态（Redux Toolkit slice）
 * 流程：接收（多标签查重）→ 核准（病害归属 + 作业单引用同时成立）→ 逐条合并
 * （每条一个事务，断点可恢复）→ 等级 / 销号 / 作业编排冲突逐项核准 → 完成。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  applyPackageRecords,
  claimPackage,
  deletePackage,
  getPackage,
  listFaults,
  listInspections,
  listPackages,
  listSwitches,
  listWorkOrders,
  listYards,
  rejectPackage as rejectPackageRow,
  resolvePackageConflict,
  savePackageConflicts,
  settlePackage,
  stagePackage,
} from '../utils/db';
import type {
  ConflictChoice,
  MigrationManifest,
  OfflinePackageFile,
  OfflinePackagePayload,
  SyncPackageRow,
} from '../types/syncPackage';
import {
  buildMigrationManifest,
  buildPackageFile,
  buildPackageId,
  legacyPackageRow,
  packageRowFromFile,
  parseIncoming,
  planMerge,
  validatePackage,
  type LedgerData,
} from '../utils/packageIO';
import { APPLY_LEASE_MS, TAB_ID, leaseUntil } from '../utils/packageLock';
import { emitChange } from '../utils/events';
import { nowIso } from '../utils/format';

export interface PackageStateSlice {
  packages: SyncPackageRow[];
  loading: boolean;
  error: string;
  /** 本标签页正在合并的包 id（按钮置灰，防止重复点击） */
  busyPackageId: string | null;
}

const initialState: PackageStateSlice = {
  packages: [],
  loading: false,
  error: '',
  busyPackageId: null,
};

/** 读取当前台账（校验与合并计划的只读输入） */
async function loadLedger(): Promise<LedgerData> {
  const [switches, inspections, faults, workOrders] = await Promise.all([
    listSwitches(),
    listInspections(),
    listFaults(),
    listWorkOrders(),
  ]);
  return { switches, inspections, faults, workOrders };
}

export const loadPackages = createAsyncThunk<SyncPackageRow[], void, { rejectValue: string }>(
  'syncPackage/load',
  async (_arg, { rejectWithValue }) => {
    try {
      return await listPackages();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '接收区读取失败');
    }
  },
);

/** 导出离线包：班组离线携带（甲班 / 乙班） */
export const exportCrewPackage = createAsyncThunk<OfflinePackageFile, string, { rejectValue: string }>(
  'syncPackage/export',
  async (crew, { rejectWithValue }) => {
    try {
      const [yards, switches, inspections, faults, workOrders] = await Promise.all([
        listYards(),
        listSwitches(),
        listInspections(),
        listFaults(),
        listWorkOrders(),
      ]);
      return buildPackageFile(crew, { yards, switches, inspections, faults, workOrders });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '导出离线包失败');
    }
  },
);

export interface ReceiveResult {
  kind: 'staged' | 'duplicate' | 'legacy';
  message: string;
  /** 旧备份迁移：清单与载荷交给页面核对 */
  manifest?: MigrationManifest;
  payload?: OfflinePackagePayload;
}

/**
 * 接收离线包 / 旧备份。
 * 离线包：同一包标识多标签同时接收时，只有先提交事务的一个成功。
 * 旧备份：缺少包标识，先生成迁移清单，核对后再迁入接收区。
 */
export const receiveIncoming = createAsyncThunk<ReceiveResult, string, { rejectValue: string }>(
  'syncPackage/receive',
  async (text, { rejectWithValue }) => {
    try {
      const parsed = parseIncoming(text);
      if (parsed.kind === 'invalid') return rejectWithValue(parsed.reason);
      if (parsed.kind === 'legacy') {
        const ledger = await loadLedger();
        const { manifest, payload } = buildMigrationManifest(parsed.snapshot, buildPackageId('迁移'), ledger);
        return { kind: 'legacy', message: '旧备份缺少包标识，已生成迁移清单，请逐项核对', manifest, payload };
      }
      const row = packageRowFromFile(parsed.file, TAB_ID);
      const result = await stagePackage(row);
      if (!result.ok) return { kind: 'duplicate', message: result.reason };
      emitChange();
      return {
        kind: 'staged',
        message: `包 ${row.id} 已入接收区（病害 ${row.payload.faults.length} · 作业单 ${row.payload.workOrders.length}），待核准`,
      };
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '接收失败');
    }
  },
);

/** 迁移清单核对通过：旧备份迁入接收区（走同一核准合并流程） */
export const stageLegacyPackage = createAsyncThunk<
  string,
  { manifest: MigrationManifest; payload: OfflinePackagePayload },
  { rejectValue: string }
>('syncPackage/stageLegacy', async ({ manifest, payload }, { rejectWithValue }) => {
  try {
    const result = await stagePackage(legacyPackageRow(manifest, payload, TAB_ID));
    if (!result.ok) return rejectWithValue(result.reason);
    emitChange();
    return `迁移包 ${manifest.packageId} 已入接收区，待核准合并`;
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '迁入接收区失败');
  }
});

/**
 * 核准合并：认领租约 → 校验（病害归属 + 作业单引用同时成立）→ 逐条写入。
 * 每条记录一个事务（台账写入 + 包游标推进原子完成），写入失败停在断点，
 * 恢复时从已完成记录之后继续；未确认内容一直留在接收区。
 */
export const confirmPackage = createAsyncThunk<string, string, { rejectValue: string }>(
  'syncPackage/confirm',
  async (packageId, { rejectWithValue }) => {
    const claim = await claimPackage(packageId, TAB_ID, APPLY_LEASE_MS);
    if (!claim.ok) return rejectWithValue(claim.reason);

    try {
      const row = await getPackage(packageId);
      if (!row) return rejectWithValue('包不存在或已被移除');
      const ledger = await loadLedger();

      // 确认前提：病害归属与作业单引用同时成立才写入正式台账
      const validation = validatePackage(row.payload, ledger);
      if (!validation.ok) {
        const reason = [
          ...validation.ownership.map((item) => item.reason),
          ...validation.references.map((item) => item.reason),
        ].join('；');
        await settlePackage(packageId, 'blocked', `核准未通过：${reason}`);
        emitChange();
        return rejectWithValue('病害归属或作业单引用不成立，包已停在接收区');
      }

      const plan = planMerge(row.payload, ledger, {
        inspectionIds: row.appliedInspectionIds,
        faultIds: row.appliedFaultIds,
        orderIds: row.appliedOrderIds,
      });

      // 合并冲突清单：已有的保留（含已核准结果），新发现的追加
      const known = new Set(row.conflicts.map((item) => item.id));
      const mergedConflicts = [...row.conflicts, ...plan.conflicts.filter((item) => !known.has(item.id))];
      await savePackageConflicts(packageId, mergedConflicts);

      // 逐条写入：每条一个事务，断点恢复时按游标继续
      for (const inspection of plan.inspections) {
        await applyPackageRecords(
          packageId,
          { inspections: [{ ...inspection, revision: ROW_REVISION }] },
          { inspectionIds: [inspection.id] },
          leaseUntil(),
        );
      }
      if (plan.reconciledInspectionIds.length > 0) {
        await applyPackageRecords(packageId, {}, { inspectionIds: plan.reconciledInspectionIds }, leaseUntil());
      }
      for (const fault of plan.faults) {
        await applyPackageRecords(
          packageId,
          { faults: [{ ...fault, revision: ROW_REVISION }] },
          { faultIds: [fault.id] },
          leaseUntil(),
        );
      }
      if (plan.reconciledFaultIds.length > 0) {
        await applyPackageRecords(packageId, {}, { faultIds: plan.reconciledFaultIds }, leaseUntil());
      }
      for (const order of plan.orders) {
        await applyPackageRecords(
          packageId,
          { workOrders: [{ ...order, revision: ROW_REVISION, updatedAt: nowIso() }] },
          { orderIds: [order.id] },
          leaseUntil(),
        );
      }
      if (plan.reconciledOrderIds.length > 0) {
        await applyPackageRecords(packageId, {}, { orderIds: plan.reconciledOrderIds }, leaseUntil());
      }

      const pending = mergedConflicts.filter((item) => item.resolution === 'pending');
      if (pending.length > 0) {
        const countOf = (kind: (typeof pending)[number]['kind']) =>
          pending.filter((item) => item.kind === kind).length;
        await settlePackage(
          packageId,
          'conflicted',
          `待逐项核准冲突 ${pending.length} 项（等级 ${countOf('severity')} · 销号 ${countOf('solved')} · 作业编排 ${countOf(
            'schedule',
          )}），两份均已保留`,
        );
        emitChange();
        return `无冲突记录已应用，${pending.length} 项冲突待逐项核准`;
      }

      await settlePackage(packageId, 'merged', '');
      emitChange();
      return '合并完成，已写入正式台账';
    } catch (cause) {
      // 写入失败：记录断点进度，包停在接收区，恢复后从已完成记录之后继续
      const message = cause instanceof Error ? cause.message : '未知错误';
      let progress = '';
      try {
        const fresh = await getPackage(packageId);
        if (fresh) {
          const done =
            fresh.appliedInspectionIds.length + fresh.appliedFaultIds.length + fresh.appliedOrderIds.length;
          const total =
            fresh.payload.inspections.length + fresh.payload.faults.length + fresh.payload.workOrders.length;
          progress = `（已应用 ${done}/${total} 条，点「继续合并」从断点恢复）`;
        }
      } catch {
        // 读取进度失败时仅给出原始错误
      }
      await settlePackage(packageId, 'blocked', `写入失败：${message}${progress}`);
      emitChange();
      return rejectWithValue('合并中断，已记录断点，未确认内容仍在接收区');
    }
  },
);

/** 逐项核准冲突：保留台账 / 采用包内 */
export const resolveConflictItem = createAsyncThunk<
  string,
  { packageId: string; conflictId: string; choice: ConflictChoice },
  { rejectValue: string }
>('syncPackage/resolveConflict', async ({ packageId, conflictId, choice }, { rejectWithValue }) => {
  try {
    const result = await resolvePackageConflict(packageId, conflictId, choice);
    if (!result.ok) return rejectWithValue(result.message);
    emitChange();
    return result.message;
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '核准失败');
  }
});

/** 退回：不并入台账，包留在接收区备查 */
export const rejectPackage = createAsyncThunk<string, string, { rejectValue: string }>(
  'syncPackage/reject',
  async (packageId, { rejectWithValue }) => {
    try {
      const result = await rejectPackageRow(packageId);
      if (!result.ok) return rejectWithValue(result.reason);
      emitChange();
      return '已退回班组，包留在接收区备查';
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '退回失败');
    }
  },
);

/** 从接收区移除包记录 */
export const removePackage = createAsyncThunk<string, string, { rejectValue: string }>(
  'syncPackage/remove',
  async (packageId, { rejectWithValue }) => {
    try {
      await deletePackage(packageId);
      emitChange();
      return '已从接收区移除';
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '移除失败');
    }
  },
);

const syncPackageSlice = createSlice({
  name: 'syncPackage',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadPackages.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadPackages.fulfilled, (state, action) => {
        state.loading = false;
        state.packages = action.payload;
      })
      .addCase(loadPackages.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '接收区读取失败';
      })
      .addCase(confirmPackage.pending, (state, action) => {
        state.busyPackageId = action.meta.arg;
      })
      .addCase(confirmPackage.fulfilled, (state) => {
        state.busyPackageId = null;
      })
      .addCase(confirmPackage.rejected, (state) => {
        state.busyPackageId = null;
      });
  },
});

export default syncPackageSlice.reducer;

interface RootLike {
  syncPackage: PackageStateSlice;
}

/** 接收区包列表（按接收时间倒序，db 层已排序） */
export function selectPackageRows(state: RootLike): SyncPackageRow[] {
  return state.syncPackage.packages;
}

/** 包的待选冲突数 */
export function pendingConflictCount(row: SyncPackageRow): number {
  return row.conflicts.filter((item) => item.resolution === 'pending').length;
}

/** 接收区汇总指标 */
export function selectPackageStats(state: RootLike): {
  total: number;
  received: number;
  conflicted: number;
  blocked: number;
  merged: number;
  pendingConflicts: number;
} {
  const rows = state.syncPackage.packages;
  return {
    total: rows.length,
    received: rows.filter((item) => item.status === 'received').length,
    conflicted: rows.filter((item) => item.status === 'conflicted').length,
    blocked: rows.filter((item) => item.status === 'blocked').length,
    merged: rows.filter((item) => item.status === 'merged').length,
    pendingConflicts: rows.reduce((sum, item) => sum + pendingConflictCount(item), 0),
  };
}
