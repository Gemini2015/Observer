import { useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialogBehavior } from './dialogBehavior';

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  footer,
  children,
  width,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  width?: number | string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(open, onClose, panelRef);

  if (!open) return null;

  const style: CSSProperties | undefined = width ? { width } : undefined;

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={panelRef}
        tabIndex={-1}
        style={style}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" id="modal-title">
              {title}
            </div>
            {subtitle ? <div className="panel-sub">{subtitle}</div> : null}
          </div>
          <button className="btn btn-ghost btn-icon" type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
