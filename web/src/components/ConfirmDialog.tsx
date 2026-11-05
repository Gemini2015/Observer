import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDialogBehavior } from './dialogBehavior';

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: 'primary' | 'danger';
  /** 需要用户原样输入该文本才能确认（用于删除机器等高风险操作）。 */
  requireText?: string;
  inputLabel?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface ConfirmState {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [typed, setTyped] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setState({ options, resolve });
      }),
    [],
  );

  const settle = useCallback((value: boolean) => {
    setState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  useDialogBehavior(state !== null, () => settle(false), panelRef);

  const options = state?.options;
  const requireText = options?.requireText;
  const canConfirm = !requireText || typed === requireText;

  useEffect(() => {
    if (!state) return undefined;
    const timer = window.setTimeout(() => {
      const selector = state.options.requireText ? 'input[data-confirm-input]' : '[data-confirm-cancel]';
      panelRef.current?.querySelector<HTMLElement>(selector)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && options
        ? createPortal(
            <div
              className="modal-overlay"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) settle(false);
              }}
            >
              <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirm-title"
                ref={panelRef}
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    canConfirm &&
                    !event.nativeEvent.isComposing &&
                    (event.target as HTMLElement).tagName !== 'BUTTON'
                  ) {
                    event.preventDefault();
                    settle(true);
                  }
                }}
              >
                <div className="modal-head">
                  <div className="modal-title" id="confirm-title">
                    {options.title}
                  </div>
                </div>
                {options.description ? <div className="modal-body">{options.description}</div> : null}
                {requireText ? (
                  <label className="field" style={{ marginTop: 12 }}>
                    <span className="field-label">{options.inputLabel ?? `输入「${requireText}」以确认`}</span>
                    <input
                      className="input"
                      data-confirm-input
                      value={typed}
                      autoComplete="off"
                      onChange={(event) => setTyped(event.target.value)}
                    />
                  </label>
                ) : null}
                <div className="modal-foot">
                  <button
                    className="btn"
                    type="button"
                    data-confirm-cancel
                    onClick={() => settle(false)}
                  >
                    {options.cancelText ?? '取消'}
                  </button>
                  <button
                    className={options.tone === 'danger' ? 'btn btn-danger-solid' : 'btn btn-primary'}
                    type="button"
                    disabled={!canConfirm}
                    onClick={() => settle(true)}
                  >
                    {options.confirmText ?? '确认'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm 必须在 ConfirmProvider 内使用');
  return confirm;
}
