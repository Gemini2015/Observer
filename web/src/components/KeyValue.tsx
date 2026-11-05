import { Fragment, type ReactNode } from 'react';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
}

export function KeyValue({ items }: { items: KeyValueItem[] }) {
  return (
    <dl className="kv">
      {items.map((item, index) => (
        <Fragment key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function JsonDetails({
  value,
  summary = '技术信息（原始 JSON）',
}: {
  value: unknown;
  summary?: string;
}) {
  return (
    <details className="raw-json">
      <summary>{summary}</summary>
      <pre className="code-block">{JSON.stringify(value ?? null, null, 2)}</pre>
    </details>
  );
}
