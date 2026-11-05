import { formatPercent } from '../lib/format';

type ProgressTone = 'ok' | 'info' | 'warn' | 'danger';

export function ProgressBar({
  value,
  tone = 'ok',
  label,
  showValue = false,
}: {
  value: number | null | undefined;
  tone?: ProgressTone;
  label?: string;
  showValue?: boolean;
}) {
  const hasValue = typeof value === 'number' && Number.isFinite(value);
  const clamped = hasValue ? Math.min(1, Math.max(0, value as number)) : 0;
  return (
    <div className="progress-row">
      <div
        className={`progress tone-${tone}${hasValue ? '' : ' is-empty'}`}
        role="progressbar"
        aria-label={label ?? '进度'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasValue ? Math.round(clamped * 100) : undefined}
      >
        <span style={{ width: `${hasValue ? clamped * 100 : 0}%` }} />
      </div>
      {showValue ? <span className="meter-value">{hasValue ? formatPercent(clamped) : '—'}</span> : null}
    </div>
  );
}
