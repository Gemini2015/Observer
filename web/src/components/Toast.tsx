import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  push: (input: { tone?: ToastTone; title: string; description?: string }) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warn: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return undefined;
    const timeout = window.setTimeout(
      () => onDismiss(item.id),
      item.tone === 'danger' ? 8000 : 4500,
    );
    return () => window.clearTimeout(timeout);
  }, [paused, item.id, item.tone, onDismiss]);

  return (
    <div
      className={`toast tone-${item.tone}`}
      role={item.tone === 'danger' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="toast-body">
        <div className="toast-title">{item.title}</div>
        {item.description ? <div className="toast-desc">{item.description}</div> : null}
      </div>
      <button
        className="toast-close"
        type="button"
        aria-label="关闭提示"
        onClick={() => onDismiss(item.id)}
      >
        ×
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((input: { tone?: ToastTone; title: string; description?: string }) => {
    const item: ToastItem = {
      id: nextId.current++,
      tone: input.tone ?? 'info',
      title: input.title,
      description: input.description,
    };
    setItems((current) => [...current.slice(-3), item]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, description) => push({ tone: 'ok', title, description }),
      error: (title, description) => push({ tone: 'danger', title, description }),
      warn: (title, description) => push({ tone: 'warn', title, description }),
      info: (title, description) => push({ tone: 'info', title, description }),
      dismissAll: () => setItems([]),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast 必须在 ToastProvider 内使用');
  return api;
}
