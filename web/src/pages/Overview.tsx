import { Link } from 'react-router-dom';
import { api, type Job, type Overview } from '../api';
import { EmptyState } from '../components/EmptyState';
import { KpiCard } from '../components/KpiCard';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTime,
} from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';
import { issueType, jobMode, jobStatus, mountState } from '../lib/labels';

const ISSUE_TYPES = ['mismatch', 'missing', 'unreadable'] as const;

function jobDuration(job: Job): string {
  if (!job.started_at || !job.finished_at) return '—';
  return formatDuration(job.finished_at - job.started_at);
}

export default function OverviewPage() {
  useDocumentTitle('总览');
  const { data, error, lastUpdatedAt } = usePolling(
    async (signal) => api<Overview>('/api/v1/overview', { signal }),
    { intervalMs: 10_000 },
  );

  if (!data && error) {
    return (
      <div className="alert alert-danger" role="alert">
        加载总览失败：{error.message}
      </div>
    );
  }
  if (!data) return <PageLoading />;

  const neverScanned = data.mounts.never_scanned ?? 0;
  const stale = data.mounts.stale_24h ?? 0;
  const attention = data.attention_mounts ?? [];
  const hasCoverage = data.coverage.total > 0;
  const offline = Math.max(0, data.machines.total - data.machines.online);

  return (
    <>
      <PageHeader
        title="总览"
        subtitle="机器在线状态、校验覆盖率、异常与最近巡检"
        actions={
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            数据更新于 {lastUpdatedAt ? formatTime(lastUpdatedAt) : '—'}
          </span>
        }
      />

      {error ? (
        <div className="alert alert-warn" role="status" style={{ marginBottom: 12 }}>
          刷新失败：{error.message}，当前显示上一次成功获取的数据。
        </div>
      ) : null}

      <div className="kpi-grid">
        <KpiCard
          label="在线机器"
          value={`${formatCount(data.machines.online)} / ${formatCount(data.machines.total)}`}
          hint={offline > 0 ? `${offline} 台离线` : '全部在线'}
          to="/machines"
        />
        <KpiCard
          label="待确认异常"
          value={formatCount(data.issues.open)}
          hint={`已忽略 ${formatCount(data.issues.ignored)} 条`}
          to="/issues?status=open"
        />
        <KpiCard
          label="校验覆盖率"
          value={hasCoverage ? formatPercent(data.coverage.ratio) : '—'}
          hint={
            hasCoverage
              ? `${formatCount(data.coverage.hashed)} / ${formatCount(data.coverage.total)} 个文件已校验`
              : '还没有入库文件'
          }
          to="/files?hash=unhashed"
        >
          <ProgressBar
            value={hasCoverage ? data.coverage.ratio : null}
            label="校验覆盖率"
            showValue={false}
          />
        </KpiCard>
        <KpiCard
          label="最近巡检"
          value={data.last_scan_at ? formatRelative(data.last_scan_at) : '尚未巡检'}
          hint={
            data.last_scan_at
              ? `${neverScanned} 个挂载点从未巡检 · ${stale} 个超过 24 小时`
              : '还没有完成过巡检任务'
          }
          to="/machines"
        />
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>需要关注</h2>
      <div className="split">
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">异常分布</div>
              <div className="panel-sub">按类型统计未关闭异常</div>
            </div>
            <Link className="btn btn-sm" to="/issues?status=open">
              查看全部
            </Link>
          </div>
          <div className="stack-gap-2">
            {ISSUE_TYPES.map((key) => (
              <Link
                key={key}
                className="row"
                to={`/issues?status=open&type=${key}`}
                style={{ justifyContent: 'space-between', color: 'inherit', textDecoration: 'none' }}
              >
                <StatusBadge value={key} map={issueType} />
                <span className="num" style={{ fontWeight: 600 }}>
                  {formatCount(data.issues_by_type[key])}
                </span>
              </Link>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">按机器</div>
              <div className="panel-sub">未关闭异常最多的机器</div>
            </div>
          </div>
          {data.issues_by_machine.length === 0 ? (
            <div className="muted">没有未关闭的异常。</div>
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th scope="col">机器</th>
                    <th scope="col" className="num">
                      未关闭
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.issues_by_machine.map((row) => (
                    <tr key={row.machine_id}>
                      <td>
                        <Link
                          to={`/issues?status=open&machine_id=${encodeURIComponent(row.machine_id)}`}
                        >
                          {row.machine_id}
                        </Link>
                      </td>
                      <td className="num">{formatCount(row.open)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {data.attention_mounts ? (
        <>
          <h2 style={{ margin: '22px 0 10px' }}>巡检新鲜度</h2>
          <div className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">最久未巡检的挂载点</div>
                <div className="panel-sub">按最近一次完成的巡检从旧到新排序，最多 10 个</div>
              </div>
              <Link className="btn btn-sm" to="/machines">
                机器列表
              </Link>
            </div>
            {attention.length === 0 ? (
              <div className="muted">还没有挂载点。</div>
            ) : (
              <div className="table-wrap">
                <table className="table table-wide">
                  <thead>
                    <tr>
                      <th scope="col">挂载点</th>
                      <th scope="col">状态</th>
                      <th scope="col">覆盖率</th>
                      <th scope="col">最近巡检</th>
                      <th scope="col">最近任务</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.map((mount) => (
                      <tr key={mount.mount_pk}>
                        <td>
                          <Link to={`/mounts/${mount.mount_pk}`}>{mount.mount_id}</Link>
                          <div className="cell-sub">{mount.machine_id}</div>
                        </td>
                        <td>
                          <StatusBadge value={mount.state} map={mountState} />
                        </td>
                        <td style={{ minWidth: 140 }}>
                          <ProgressBar
                            value={mount.coverage_ratio}
                            label={`${mount.mount_id} 覆盖率`}
                            showValue
                          />
                        </td>
                        <td title={mount.last_job_at ? formatTime(mount.last_job_at) : undefined}>
                          {mount.last_job_at ? formatRelative(mount.last_job_at) : '从未巡检'}
                        </td>
                        <td>
                          {mount.last_job_status ? (
                            <StatusBadge value={mount.last_job_status} map={jobStatus} />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      <h2 style={{ margin: '22px 0 10px' }}>最近任务</h2>
      <div className="panel">
        {data.recent_jobs.length === 0 ? (
          <EmptyState
            title="还没有巡检任务"
            description="在机器页对整机或单个挂载点发起一次巡检，结果会出现在这里。"
            action={
              <Link className="btn btn-primary" to="/machines">
                去机器页发起巡检
              </Link>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">机器 / 挂载点</th>
                  <th scope="col">模式</th>
                  <th scope="col">状态</th>
                  <th scope="col">耗时</th>
                  <th scope="col">完成时间</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link to={`/jobs/${job.id}`}>#{job.id}</Link>
                    </td>
                    <td>
                      <Link to={`/jobs?machine_id=${encodeURIComponent(job.machine_id)}`}>
                        {job.machine_id}
                      </Link>
                      <div className="cell-sub">
                        <Link to={`/jobs?mount_id=${encodeURIComponent(job.mount_id)}`}>
                          {job.mount_id}
                        </Link>
                      </div>
                    </td>
                    <td>
                      <StatusBadge value={job.mode} map={jobMode} dot={false} />
                    </td>
                    <td>
                      <StatusBadge value={job.status} map={jobStatus} />
                    </td>
                    <td>{jobDuration(job)}</td>
                    <td title={formatTime(job.finished_at)}>
                      {job.finished_at ? formatRelative(job.finished_at) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
