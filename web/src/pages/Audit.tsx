import { useState } from 'react';
import { api, type AuditEntry } from '../api';
import { EmptyState } from '../components/EmptyState';
import { JsonDetails } from '../components/KeyValue';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { formatCount, formatTime } from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';
import { actorLabel, auditActionLabel } from '../lib/labels';

const ACTION_OPTIONS = [
  { value: '', label: '全部动作' },
  { value: 'job.', label: '任务（job.*）' },
  { value: 'mount.', label: '挂载点（mount.*）' },
  { value: 'repair.', label: '修复（repair.*）' },
  { value: 'transfer.', label: '传输（transfer.*）' },
  { value: 'scan.', label: '扫描（scan.*）' },
  { value: 'scheduler.', label: '调度（scheduler.*）' },
  { value: 'enroll', label: '注册（enroll*）' },
  { value: 'agent.token.rotate', label: '令牌轮换' },
];

const LIMIT_OPTIONS = [100, 200, 500];

export default function AuditPage() {
  useDocumentTitle('审计');
  const [action, setAction] = useState('');
  const [limit, setLimit] = useState(200);

  const query = new URLSearchParams({ limit: String(limit) });
  if (action) query.set('action', action);

  const state = usePolling(
    async (signal) => api<AuditEntry[]>(`/api/v1/audit?${query.toString()}`, { signal }),
    { intervalMs: 30_000, deps: [action, limit] },
  );

  const entries = state.data ?? [];

  return (
    <>
      <PageHeader
        title="审计"
        subtitle={
          state.lastUpdatedAt
            ? `最近 ${formatCount(entries.length)} 条操作记录 · 更新于 ${formatTime(state.lastUpdatedAt)}`
            : '谁在什么时候触发了什么、结果如何'
        }
        actions={
          <button className="btn" type="button" onClick={() => state.reload()}>
            刷新
          </button>
        }
      />

      <div className="panel">
        <div className="filter-grid-compact">
          <label className="field">
            <span className="field-label">动作</span>
            <select className="select" value={action} onChange={(event) => setAction(event.target.value)}>
              {ACTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">条数</span>
            <select
              className="select"
              value={String(limit)}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((value) => (
                <option key={value} value={String(value)}>
                  最近 {value} 条
                </option>
              ))}
            </select>
          </label>
        </div>

        {state.error ? (
          <div className="alert alert-danger" role="alert" style={{ marginTop: 12 }}>
            加载审计记录失败：{state.error.message}
          </div>
        ) : null}

        {!state.data && !state.error ? <PageLoading /> : null}

        {state.data && entries.length === 0 ? (
          <EmptyState
            title={action ? '当前动作筛选没有记录' : '还没有审计记录'}
            description={
              action
                ? '换一个动作前缀看看。'
                : '登录、创建任务、确认异常、发起修复等操作都会记录在这里。'
            }
          />
        ) : null}

        {entries.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">操作者</th>
                  <th scope="col">动作</th>
                  <th scope="col">对象</th>
                  <th scope="col">详情</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="nowrap" title={formatTime(entry.at)}>
                      {formatTime(entry.at)}
                    </td>
                    <td>{actorLabel(entry.actor)}</td>
                    <td>
                      {auditActionLabel(entry.action)}
                      <div className="cell-sub mono">{entry.action}</div>
                    </td>
                    <td className="mono">{entry.target ?? '—'}</td>
                    <td>
                      {entry.detail ? (
                        <JsonDetails value={entry.detail} summary="展开" />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}
