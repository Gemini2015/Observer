import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  lastUpdatedAt: number | null;
  reload: () => void;
}

/**
 * 统一的数据加载/轮询：请求可取消、切换依赖时保留旧数据、成功后清空错误、
 * 页面不可见时暂停轮询。`deps` 变化会立即重新拉取（用于筛选条件）。
 */
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { intervalMs?: number; enabled?: boolean; deps?: readonly unknown[] } = {},
): PollingState<T> {
  const { intervalMs = 0, enabled = true } = options;
  const depsKey = JSON.stringify(options.deps ?? []);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setLoading(true);
    try {
      const value = await fetcherRef.current(controller.signal);
      if (controller.signal.aborted || seq !== seqRef.current) return;
      setData(value);
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (err) {
      if (controller.signal.aborted || seq !== seqRef.current) return;
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    // 依赖变化（筛选/选中项切换）时清掉上一次的错误，避免展示过期错误。
    setError(null);
    void run();

    let timer: number | undefined;
    if (intervalMs > 0) {
      timer = window.setInterval(() => {
        if (!document.hidden) void run();
      }, intervalMs);
    }

    const onVisibility = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      controllerRef.current?.abort();
    };
    // fetcher 通过 ref 读取，只有 deps/enabled/intervalMs 变化才重启。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, depsKey, run]);

  return { data, error, loading, lastUpdatedAt, reload: run };
}

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useDocumentTitle(title?: string | null): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · Observer` : 'Observer';
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** 布尔偏好存到 localStorage；隐私模式/禁用存储时静默降级。 */
export function useStoredFlag(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : raw === '1';
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // 忽略存储失败
      }
    },
    [key],
  );

  return [value, set];
}
