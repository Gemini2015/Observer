import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialogBehavior } from './dialogBehavior';

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useDialogBehavior(open, onClose, panelRef);

  if (!open) return null;

  return createPortal(
    <div
      className="drawer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" ref={panelRef} tabIndex={-1}>
        <div className="drawer-head">
          <div>
            <div className="drawer-title" id="drawer-title">
              {title}
            </div>
            {subtitle ? <div className="drawer-sub">{subtitle}</div> : null}
          </div>
          <button className="btn btn-ghost btn-icon" type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  );
}
