import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface MenuEntry {
  label: string;
  onSelect?: () => void;
  to?: string;
  danger?: boolean;
  disabled?: boolean;
}

export function Menu({
  label,
  items,
  className,
}: {
  label: ReactNode;
  items: MenuEntry[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`menu${className ? ` ${className}` : ''}`} ref={containerRef}>
      <button
        className="btn btn-sm"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="menu-popover" role="menu">
          {items.map((item) =>
            item.to ? (
              <Link
                key={item.label}
                className={`menu-item${item.danger ? ' danger' : ''}`}
                role="menuitem"
                to={item.to}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                className={`menu-item${item.danger ? ' danger' : ''}`}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
