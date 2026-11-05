import type { ReactNode } from 'react';
import { labelOf, type LabelMap, type Tone } from '../lib/labels';

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function StatusBadge({
  value,
  map,
  dot = true,
}: {
  value: string | null | undefined;
  map: LabelMap;
  dot?: boolean;
}) {
  const labeled = labelOf(map, value);
  return (
    <Badge tone={labeled.tone} dot={dot}>
      {labeled.label}
    </Badge>
  );
}
