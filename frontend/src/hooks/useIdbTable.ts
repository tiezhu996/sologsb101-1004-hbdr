/**
 * Dexie 表响应式订阅封装（React hook）
 * 订阅全局数据变更广播，回调内触发 Redux 数据刷新，卸载时自动取消。
 * 被全部页面消费，保证任何页面写入后其它页面同步刷新。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeChange } from '../utils/events';

export interface UseIdbTableResult<T> {
  /** 当前数据 */
  data: T;
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string;
  /** 手动重新拉取 */
  reload: () => Promise<void>;
}

/**
 * 订阅 Dexie 表数据。
 * @param loader 读取函数（可为多表组合）
 * @param deps 依赖数组，变化时重新拉取
 */
export function useIdbTable<T>(loader: () => Promise<T>, deps: unknown[] = []): UseIdbTableResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const aliveRef = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    try {
      const result = await loaderRef.current();
      if (!aliveRef.current) return;
      setData(result);
      setError('');
    } catch (cause) {
      if (!aliveRef.current) return;
      setError(cause instanceof Error ? cause.message : '本地数据读取失败');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    const unsubscribe = subscribeChange(() => {
      void reload();
    });
    return () => {
      aliveRef.current = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);

  return { data: data as T, loading, error, reload };
}

/** 简化的列表订阅：直接返回数组 */
export function useIdbList<T>(loader: () => Promise<T[]>, deps: unknown[] = []): T[] {
  const { data } = useIdbTable<T[]>(loader, deps);
  return data ?? [];
}
