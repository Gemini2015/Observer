import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function KpiCard({
  label,
  value,
  hint,
  to,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  to?: string;
  children?: ReactNode;
}) {
  const content = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
      {children}
    </>
  );
  if (to) {
    return (
      <Link className="kpi" to={to}>
        {content}
      </Link>
    );
  }
  return <div className="kpi">{content}</div>;
}
