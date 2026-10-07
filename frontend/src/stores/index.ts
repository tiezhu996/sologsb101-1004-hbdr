/**
 * Redux Toolkit store 组装
 * 四个业务 slice：yardStore（站场与道岔台账）、switchStore（道岔筛选与部件字典）、
 * faultStore（病害与销号）、workOrderStore（天窗作业单与进度推进）。
 */
import { configureStore } from '@reduxjs/toolkit';
import yardReducer from './yardStore';
import switchReducer from './switchStore';
import faultReducer from './faultStore';
import workOrderReducer from './workOrderStore';
import { subscribeChange } from '../utils/events';
import { loadYardData } from './yardStore';
import { loadSwitchData } from './switchStore';
import { loadFaultData } from './faultStore';
import { loadWorkOrderData } from './workOrderStore';

export const store = configureStore({
  reducer: {
    yard: yardReducer,
    switch: switchReducer,
    fault: faultReducer,
    workOrder: workOrderReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      // Dexie 行对象均为可序列化的纯数据，无需关闭检查
      serializableCheck: { warnAfter: 200 },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/** 一次性刷新全部业务数据（首屏与任意写入后调用） */
export async function refreshAll(): Promise<void> {
  await Promise.all([
    store.dispatch(loadYardData()),
    store.dispatch(loadSwitchData()),
    store.dispatch(loadFaultData()),
    store.dispatch(loadWorkOrderData()),
  ]);
}

let subscribed = false;

/** 订阅 IndexedDB 变更广播：任何写入后自动刷新全部 slice */
export function subscribeStoreRefresh(): void {
  if (subscribed) return;
  subscribed = true;
  subscribeChange(() => {
    void refreshAll();
  });
}

export default store;
