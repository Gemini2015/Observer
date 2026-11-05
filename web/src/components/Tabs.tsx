import { useRef, type ReactNode } from 'react';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number;
}

export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label = '切换视图',
}: {
  items: Array<TabItem<K>>;
  value: K;
  onChange: (key: K) => void;
  label?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const move = (direction: 1 | -1) => {
    const index = items.findIndex((item) => item.key === value);
    if (index < 0) return;
    const next = (index + direction + items.length) % items.length;
    onChange(items[next]!.key);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    buttons?.[next]?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} ref={listRef}>
      {items.map((item) => (
        <button
          key={item.key}
          className="tab"
          type="button"
          role="tab"
          aria-selected={item.key === value}
          tabIndex={item.key === value ? 0 : -1}
          onClick={() => onChange(item.key)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              move(-1);
            }
          }}
        >
          <span>{item.label}</span>
          {item.count !== undefined ? <span className="tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
