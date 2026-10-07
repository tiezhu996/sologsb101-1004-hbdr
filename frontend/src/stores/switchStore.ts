/**
 * 道岔筛选与部件字典状态（Redux Toolkit slice）
 * 维护道岔台账的筛选条件、按站场/辙叉号/轨型的派生列表与部件字典校验。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  listFaults,
  listInspections,
  listSwitches,
  listYards,
  type FaultRow,
  type InspectionRow,
  type SwitchRow,
  type YardRow,
} from '../utils/db';
import type { FrogNumber, RailType, SwitchView } from '../types/switch';
import { FAULT_PART_LABEL, PART_CHECK_HINT, type FaultPart } from '../types/fault';

export interface SwitchState {
  switches: SwitchRow[];
  yards: YardRow[];
  inspections: InspectionRow[];
  faults: FaultRow[];
  yardFilters: string[];
  frogFilters: FrogNumber[];
  railFilters: RailType[];
  /** 部件字典：部件 → 检查要点 */
  partDictionary: Array<{ part: FaultPart; label: string; hint: string }>;
  loading: boolean;
  error: string;
}

const initialState: SwitchState = {
  switches: [],
  yards: [],
  inspections: [],
  faults: [],
  yardFilters: [],
  frogFilters: [],
  railFilters: [],
  partDictionary: (Object.keys(FAULT_PART_LABEL) as FaultPart[]).map((part) => ({
    part,
    label: FAULT_PART_LABEL[part],
    hint: PART_CHECK_HINT[part],
  })),
  loading: false,
  error: '',
};

export const loadSwitchData = createAsyncThunk<
  { switches: SwitchRow[]; yards: YardRow[]; inspections: InspectionRow[]; faults: FaultRow[] },
  void,
  { rejectValue: string }
>('switch/load', async (_arg, { rejectWithValue }) => {
  try {
    const [switches, yards, inspections, faults] = await Promise.all([
      listSwitches(),
      listYards(),
      listInspections(),
      listFaults(),
    ]);
    return { switches, yards, inspections, faults };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '道岔数据读取失败');
  }
});

const switchSlice = createSlice({
  name: 'switch',
  initialState,
  reducers: {
    setYardFilters(state, action: PayloadAction<string[]>) {
      state.yardFilters = action.payload;
    },
    setFrogFilters(state, action: PayloadAction<FrogNumber[]>) {
      state.frogFilters = action.payload;
    },
    setRailFilters(state, action: PayloadAction<RailType[]>) {
      state.railFilters = action.payload;
    },
    resetSwitchFilters(state) {
      state.yardFilters = [];
      state.frogFilters = [];
      state.railFilters = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadSwitchData.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(loadSwitchData.fulfilled, (state, action) => {
        state.loading = false;
        state.switches = action.payload.switches;
        state.yards = action.payload.yards;
        state.inspections = action.payload.inspections;
        state.faults = action.payload.faults;
      })
      .addCase(loadSwitchData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? '道岔数据读取失败';
      });
  },
});

export const { setYardFilters, setFrogFilters, setRailFilters, resetSwitchFilters } = switchSlice.actions;
export default switchSlice.reducer;

interface RootLike {
  switch: SwitchState;
}

/** 道岔视图：命中筛选条件后的列表 */
export function selectFilteredSwitches(state: RootLike): SwitchView[] {
  const { switches, yards, inspections, faults, yardFilters, frogFilters, railFilters } = state.switch;
  return switches
    .filter((item) => {
      if (yardFilters.length > 0 && !yardFilters.includes(item.yardId)) return false;
      if (frogFilters.length > 0 && !frogFilters.includes(item.frogNumber)) return false;
      if (railFilters.length > 0 && !railFilters.includes(item.railType)) return false;
      return true;
    })
    .map((item) => {
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
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

/** 辙叉号分组计数（用于筛选面板提示） */
export function selectFrogCounts(state: RootLike): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of selectFilteredSwitches(state)) {
    counts[item.frogNumber] = (counts[item.frogNumber] ?? 0) + 1;
  }
  return counts;
}

/** 部件字典 */
export function selectPartDictionary(state: RootLike) {
  return state.switch.partDictionary;
}
