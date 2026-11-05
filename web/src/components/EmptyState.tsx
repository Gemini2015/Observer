import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {description ? <div className="empty-desc">{description}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
