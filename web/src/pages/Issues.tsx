import { useCallback, useEffect, useState } from 'react';
import {
  api,
  decodePath,
  formatTime,
  issueClass,
  statusClass,
  type Issue,
} from '../api';

const STATUSES = ['open', 'acked', 'ignored', 'resolved'] as const;
type IssueStatus = (typeof STATUSES)[number];

const LABELS: Record<IssueStatus, string> = {
  open: '待确认',
  acked: '已确认',
  ignored: '已忽略',
  resolved: '已解决',
};

export default function IssuesPage() {
  const [status, setStatus] = useState<IssueStatus>('open');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api<Issue[]>(`/api/v1/issues?status=${status}`)
      .then(setIssues)
      .catch((err: Error) => setError(err.message));
  }, [status]);

  useEffect(() => {
    setIssues(null);
    load();
  }, [load]);

  const act = async (id: number, action: 'ack' | 'ignore') => {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/v1/issues/${id}/${action}`, { method: 'POST' });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h1>异常</h1>
      <div className="toolbar">
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            className={value === status ? 'primary' : 'ghost'}
            onClick={() => setStatus(value)}
          >
            {LABELS[value]}
          </button>
        ))}
        <button className="ghost" type="button" onClick={load}>
          刷新
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="panel">
        {issues === null ? (
          <div className="muted">加载中…</div>
        ) : issues.length === 0 ? (
          <div className="muted">没有{LABELS[status]}的异常</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>文件</th>
                <th>机器 / 挂载点</th>
                <th>置信度</th>
                <th>次数</th>
                <th>最近出现</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <tr key={issue.id}>
                  <td>
                    <span className={issueClass(issue.type)}>{issue.type}</span>
                  </td>
                  <td>
                    <div>{decodePath(issue.path_display_b64)}</div>
                    <div className="muted">{issue.path_key}</div>
                    {issue.evidence ? (
                      <details>
                        <summary className="muted">证据</summary>
                        <pre className="code">{JSON.stringify(issue.evidence, null, 2)}</pre>
                      </details>
                    ) : null}
                  </td>
                  <td>
                    {issue.machine_id}
                    <div className="muted">{issue.mount_id}</div>
                  </td>
                  <td>{issue.confidence}</td>
                  <td>{issue.occurrences}</td>
                  <td>{formatTime(issue.last_seen_at)}</td>
                  <td>
                    {issue.status === 'open' ? (
                      <div className="toolbar" style={{ margin: 0 }}>
                        <button
                          className="ghost"
                          type="button"
                          disabled={busy === issue.id}
                          onClick={() => act(issue.id, 'ack')}
                        >
                          确认
                        </button>
                        <button
                          className="ghost"
                          type="button"
                          disabled={busy === issue.id}
                          onClick={() => act(issue.id, 'ignore')}
                        >
                          忽略
                        </button>
                      </div>
                    ) : issue.status === 'acked' ? (
                      <button
                        className="ghost"
                        type="button"
                        disabled={busy === issue.id}
                        onClick={() => act(issue.id, 'ignore')}
                      >
                        忽略
                      </button>
                    ) : (
                      <span className={statusClass(issue.status)}>{issue.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
