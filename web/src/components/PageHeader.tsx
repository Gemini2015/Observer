import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface Breadcrumb {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: Breadcrumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav className="breadcrumbs" aria-label="面包屑">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`}>
          {index > 0 ? (
            <span className="sep" aria-hidden="true">
              /
            </span>
          ) : null}{' '}
          {item.to ? <Link to={item.to}>{item.label}</Link> : <span>{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Breadcrumb[];
}) {
  return (
    <div className="page-header">
      <div className="grow">
        {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
        <h1 className="page-title">{title}</h1>
        {subtitle ? <div className="page-sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}
