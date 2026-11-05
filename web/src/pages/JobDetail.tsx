import { Link, useParams } from 'react-router-dom';
import { ApiError, api, type Job } from '../api';
import { EmptyState } from '../components/EmptyState';
import { JsonDetails, KeyValue } from '../components/KeyValue';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { StatusBadge } from '../components/StatusBadge';
import {
  formatDuration,
  formatRelative,
  formatStatValue,
  formatTime,
} from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';
import { jobMode, jobStatus, statLabel } from '../lib/labels';

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data: job, error } = usePolling<Job>(
    async (signal) => {
      if (!id) throw new Error('缺少任务 ID');
      return api<Job>(`/api/v1/jobs/${id}`, { signal });
    },
    {
      intervalMs: 5_000,
      deps: [id],
      enabled: Boolean(id),
    },
  );

  useDocumentTitle(job ? `任务 #${job.id}` : '任务详情');

  if (!job && error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="panel">
          <EmptyState
            title="任务不存在"
            description="该任务可能已被清理，或链接已失效。"
            action={
              <Link className="btn btn-primary" to="/jobs">
                返回任务列表
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="alert alert-danger" role="alert">
        加载任务详情失败：{error.message}
      </div>
    );
  }
  if (!job) return <PageLoading />;

  const duration =
    job.started_at && job.finished_at ? formatDuration(job.finished_at - job.started_at) : '—';
  const stats = job.stats ? Object.entries(job.stats) : [];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: '任务', to: '/jobs' }, { label: `#${job.id}` }]}
        title={
          <>
            任务 #{job.id}
            <StatusBadge value={job.status} map={jobStatus} />
          </>
        }
        subtitle={`${job.machine_id} / ${job.mount_id}`}
        actions={
          <>
            <Link className="btn" to={`/jobs?machine_id=${encodeURIComponent(job.machine_id)}`}>
              同机器任务
            </Link>
            <Link className="btn" to={`/jobs?mount_id=${encodeURIComponent(job.mount_id)}`}>
              同挂载点任务
            </Link>
          </>
        }
      />

      {error ? (
        <div className="alert alert-warn" role="status" style={{ marginBottom: 12 }}>
          刷新失败：{error.message}，当前显示上一次成功获取的数据。
        </div>
      ) : null}

      <div className="kpi-grid">
        <div className="kpi">
          <span className="kpi-label">模式</span>
          <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
            <StatusBadge value={job.mode} map={jobMode} dot={false} />
          </span>
          <span className="kpi-hint">
            {job.mode === 'full' ? '全量重算所有文件哈希' : '大小与 mtime 未变则跳过'}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">耗时</span>
          <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
            {duration}
          </span>
          <span className="kpi-hint">开始于 {formatRelative(job.started_at ?? job.created_at)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">尝试次数</span>
          <span className="kpi-value">{job.attempt}</span>
          <span className="kpi-hint">租约过期会自动重派（最多 3 次）</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">完成时间</span>
          <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
            {job.finished_at ? formatRelative(job.finished_at) : '未完成'}
          </span>
          <span className="kpi-hint">{job.finished_at ? formatTime(job.finished_at) : '—'}</span>
        </div>
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>基本信息</h2>
      <div className="panel">
        <KeyValue
          items={[
            { label: '任务 ID', value: <span className="mono">#{job.id}</span> },
            {
              label: '机器',
              value: <Link to={`/jobs?machine_id=${encodeURIComponent(job.machine_id)}`}>{job.machine_id}</Link>,
            },
            {
              label: '挂载点',
              value: <Link to={`/jobs?mount_id=${encodeURIComponent(job.mount_id)}`}>{job.mount_id}</Link>,
            },
            { label: '模式', value: <StatusBadge value={job.mode} map={jobMode} dot={false} /> },
            { label: '状态', value: <StatusBadge value={job.status} map={jobStatus} /> },
            { label: '创建时间', value: formatTime(job.created_at) },
            { label: '开始时间', value: formatTime(job.started_at) },
            { label: '结束时间', value: formatTime(job.finished_at) },
          ]}
        />
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>统计</h2>
      <div className="panel">
        {stats.length === 0 ? (
          <div className="muted">任务还没有上报统计信息。</div>
        ) : (
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th scope="col">字段</th>
                  <th scope="col">值</th>
                </tr>
              </thead>
              <tbody>
                {stats.map(([key, value]) => (
                  <tr key={key}>
                    <td className="muted" style={{ width: 220 }} title={key}>
                      {statLabel(key)}
                    </td>
                    <td>{formatStatValue(key, value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <JsonDetails value={job.stats} />
      </div>
    </>
  );
}
