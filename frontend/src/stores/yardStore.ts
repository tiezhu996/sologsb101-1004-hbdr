/**
 * 站场与道岔台账状态（Redux Toolkit slice）
 * 维护站场列表、道岔列表、当前选中站场与站场卡片派生统计。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  ROW_REVISION,
  listFaults,
  listInspections,
  listSwitches,
  listYards,
  putSwitch,
  putSwitches,
  putYard,
  removeSwitch,
  removeYard,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type YardRow,
} from '../utils/db';
import type { SwitchDraft, SwitchView } from '../types/switch';
import type { YardDraft, YardView } from '../types/yard';
import { emitChange } from '../utils/events';
import { nowIso, uuid } from '../utils/format';

export interface YardState {
  yards: YardRow[];
  switches: SwitchRow[];
  inspections: InspectionRow[];
  faults: FaultRow[];
  activeYardId: string | null;
  loading: boolean;
  error: string;
}

const initialState: YardState = {
  yards: [],
  switches: [],
  inspections: [],
  faults: [],
  activeYardId: null,
  loading: false,
  error: '',
};

/** 一次性读取站场视图所需的全部表 */
export const loadYardData = createAsyncThunk<
  { yards: YardRow[]; switches: SwitchRow[]; inspections: InspectionRow[]; faults: FaultRow[] },
  void,
  { rejectValue: string }
>('yard/load', async (_arg, { rejectWithValue }) => {
  try {
    const [yards, switches, inspections, faults] = await Promise.all([
      listYards(),
      listSwitches(),
      listInspections(),
      listFaults(),
    ]);
    return { yards, switches, inspections, faults };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '站场数据读取失败');
  }
});

export const createYard = createAsyncThunk<void, YardDraft, { rejectValue: string }>(
  'yard/create',
  async (draft, { rejectWithValue }) => {
    try {
      await putYard({
        id: `yard-${uuid()}`,
        name: draft.name.trim(),
        mileage: draft.mileage.trim(),
        trackCount: draft.trackCount,
        region: draft.region.trim(),
        createdAt: nowIso(),
        revision: ROW_REVISION,
      });
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '新建站场失败');
    }
  },
);

export const updateYard = createAsyncThunk<void, { id: string; draft: YardDraft }, { state: { yard: YardState }; rejectValue: string }>(
  'yard/update',
  async ({ id, draft }, { getState, rejectWithValue }) => {
    try {
      const state = (getState() as { yard: YardState }).yard;
      const existing = state.yards.find((item) => item.id === id);
      if (!existing) return;
      await putYard({
        ...existing,
        name: draft.name.trim(),
        mileage: draft.mileage.trim(),
        trackCount: draft.trackCount,
        region: draft.region.trim(),
      });
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '更新站场失败');
    }
  },
);

export const deleteYard = createAsyncThunk<void, string, { rejectValue: string }>(
  'yard/delete',
  async (id, { rejectWithValue }) => {
    try {
      await removeYard(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除站场失败');
    }
  },
);

export const createSwitch = createAsyncThunk<void, SwitchDraft, { rejectValue: string }>(
  'yard/createSwitch',
  async (draft, { rejectWithValue }) => {
    try {
      await putSwitch({
        id: `sw-${uuid()}`,
        yardId: draft.yardId,
        code: draft.code.trim(),
        frogNumber: draft.frogNumber,
        railType: draft.railType,
        position: draft.position.trim(),
        turnoutType: draft.turnoutType,
        createdAt: nowIso(),
        revision: ROW_REVISION,
      });
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '新建道岔失败');
    }
  },
);

export const updateSwitch = createAsyncThunk<
  void,
  { id: string; draft: SwitchDraft },
  { state: { yard: YardState }; rejectValue: string }
>('yard/updateSwitch', async ({ id, draft }, { getState, rejectWithValue }) => {
  try {
    const state = (getState() as { yard: YardState }).yard;
    const existing = state.switches.find((item) => item.id === id);
    if (!existing) return;
    await putSwitch({
      ...existing,
      yardId: draft.yardId,
      code: draft.code.trim(),
      frogNumber: draft.frogNumber,
      railType: draft.railType,
      position: draft.position.trim(),
      turnoutType: draft.turnoutType,
    });
    emitChange();
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '更新道岔失败');
  }
});


export const deleteSwitch = createAsyncThunk<void, string, { rejectValue: string }>(
  'yard/deleteSwitch',
  // 删除道岔会级联清理巡检与病害，并同步摘除作业单引用
  async (id, { rejectWithValue }) => {
    try {
      await removeSwitch(id);
      emitChange();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '删除道岔失败');
    }
  },
);

/** 批量新增道岔（同站场按编号递增，重复编号自动跳过） */
export const batchCreateSwitches = createAsyncThunk<
  number,
  { yardId: string; startSeq: number; count: number; frogNumber: SwitchRow['frogNumber']; railType: SwitchRow['railType'] },
  { state: { yard: YardState }; rejectValue: string }
>('yard/batchCreateSwitches', async (input, { getState, rejectWithValue }) => {
  try {
    const state = getState().yard;
    const rows: SwitchRow[] = [];
    for (let offset = 0; offset < input.count; offset += 1) {
      const seq = input.startSeq + offset * 2;
      const code = `${seq}#`;
      if (state.switches.some((item) => item.yardId === input.yardId && item.code === code)) continue;
      rows.push({
        id: `sw-${uuid()}`,
        yardId: input.yardId,
        code,
        frogNumber: input.frogNumber,
        railType: input.railType,
        position: `${seq} 号道岔（批量登记）`,
        turnoutType: 'single',
        createdAt: nowIso(),
        revision: ROW_REVISION,
      });
    }
    if (rows.length > 0) {
      await putSwitches(rows);
      emitChange();
    }
    return rows.length;
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '批量新增道岔失败');
  }
});

const yardSlice = createSlice({
  name: 'yard',
  initialState,
  reducers: {
    setActiveYard(state, action: PayloadAction<string | null>) {
      state.activeYardId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadYardData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadYardData.fulfilled, (state, action) => {
        state.loading = false;
        state.yards = action.payload.yards;
        state.switches = action.payload.switches;
        state.inspections = action.payload.inspections;
        state.faults = action.payload.faults;
        if (!state.activeYardId || !action.payload.yards.some((item) => item.id === state.activeYardId)) {
          state.activeYardId = action.payload.yards[0]?.id ?? null;
        }
      })
      .addCase(loadYardData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '站场数据读取失败';
      });
  },
});

export const { setActiveYard } = yardSlice.actions;
export default yardSlice.reducer;

/* ------------------------------ 选择器 ------------------------------ */

interface RootLike {
  yard: YardState;
}

/** 道岔视图：带站场上下文与病害统计 */
export function selectSwitchViews(state: RootLike): SwitchView[] {
  const { yards, switches, inspections, faults } = state.yard;
  return switches.map((item) => {
    const yard = yards.find((row) => row.id === item.yardId);
    const ownedInspections = inspections.filter((row) => row.switchId === item.id);
    const inspectionIds = new Set(ownedInspections.map((row) => row.id));
    const ownedFaults = faults.filter((row) => inspectionIds.has(row.inspectionId));
    return {
      ...item,
      yardName: yard?.name ?? '未归属站场',
      region: yard?.region ?? '-',
      inspectionCount: ownedInspections.length,
      faultCount: ownedFaults.length,
      pendingFaultCount: ownedFaults.filter((row) => row.state === 'pending').length,
      revision: item.revision,
    };
  });
}

/** 站场视图：卡片回显道岔数与待修病害数 */
export function selectYardViews(state: RootLike): YardView[] {
  const { yards, switches, inspections, faults } = state.yard;
  return yards.map((yard) => {
    const ownedSwitches = switches.filter((item) => item.yardId === yard.id);
    const switchIds = new Set(ownedSwitches.map((item) => item.id));
    const ownedInspections = inspections.filter((item) => switchIds.has(item.switchId));
    const inspectionIds = new Set(ownedInspections.map((item) => item.id));
    const ownedFaults = faults.filter((item) => inspectionIds.has(item.inspectionId));
    return {
      ...yard,
      switchCount: ownedSwitches.length,
      faultCount: ownedFaults.length,
      pendingFaultCount: ownedFaults.filter((item) => item.state === 'pending').length,
      severeCount: ownedFaults.filter((item) => item.severity === 'heavy').length,
    };
  });
}

/** 当前选中站场 */
export function selectActiveYard(state: RootLike): YardRow | null {
  const { yards, activeYardId } = state.yard;
  return yards.find((item) => item.id === activeYardId) ?? null;
}

/** 管辖车间分组 */
export function selectRegionGroups(state: RootLike): Array<{ region: string; count: number; yardNames: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const yard of state.yard.yards) {
    const list = buckets.get(yard.region) ?? [];
    list.push(yard.name);
    buckets.set(yard.region, list);
  }
  return [...buckets.entries()]
    .map(([region, yardNames]) => ({ region, count: yardNames.length, yardNames }))
    .sort((a, b) => b.count - a.count);
}
