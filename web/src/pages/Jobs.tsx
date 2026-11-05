import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Job, type Machine } from '../api';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/StatusBadge';
import {
  formatCount,
  formatDuration,
  formatRelative,
  formatStatValue,
  formatTime,
} from '../lib/format';
import { useDocumentTitle, usePolling, useStoredFlag } from '../lib/hooks';
import { jobMode, jobStatus } from '../lib/labels';

const PAGE_SIZE = 25;
const STATUS_OPTIONS = ['pending', 'running', 'completed', 'failed', 'canceled', 'expired'];

function jobDuration(job: Job): string {
  if (!job.started_at || !job.finished_at) return '—';
  return formatDuration(job.finished_at - job.started_at);
}

function statsSummary(job: Job): string {
  if (!job.stats) return '—';
  return `发现 ${formatStatValue('seen', job.stats.seen)} · 校验 ${formatStatValue(
    'hashed',
    job.stats.hashed,
  )} · 跳过 ${formatStatValue('skipped', job.stats.skipped)}`;
}

export default function JobsPage() {
  useDocumentTitle('任务');
  const [params, setParams] = useSearchParams();
  const [autoRefresh, setAutoRefresh] = useStoredFlag('observer.jobs.autoRefresh', true);

  const status = params.get('status') ?? '';
  const machineId = params.get('machine_id') ?? '';
  const mountId = params.get('mount_id') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const patch = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    if (!('page' in next)) merged.delete('page');
    setParams(merged, { replace: true });
  };

  const machinesState = usePolling(
    async (signal) => api<Machine[]>('/api/v1/machines', { signal }),
    { intervalMs: 0 },
  );

  const jobsState = usePolling(
    async (signal) => {
      const query = new URLSearchParams();
      query.set('limit', '200');
      if (status) query.set('status', status);
      if (mountId) query.set('mount_id', mountId);
      if (machineId) query.set('machine_id', machineId);
      const jobs = await api<Job[]>(`/api/v1/jobs?${query.toString()}`, { signal });
      // 客户端兜底过滤：即使后端暂不支持某个筛选也能得到正确结果。
      return jobs.filter(
        (job) =>
          (!status || job.status === status) &&
          (!machineId || job.machine_id === machineId) &&
          (!mountId || job.mount_id === mountId),
      );
    },
    { intervalMs: autoRefresh ? 5_000 : 0, deps: [status, machineId, mountId] },
  );

  const mountOptions = useMemo(() => {
    const machines = machinesState.data ?? [];
    if (machineId) {
      const machine = machines.find((item) => item.machine_id === machineId);
      return (machine?.mounts ?? []).map((mount) => ({
        value: mount.mount_id,
        label: `${machine?.machine_id ?? machineId} / ${mount.label ?? mount.mount_id}`,
      }));
    }
    return machines.flatMap((machine) =>
      machine.mounts.map((mount) => ({
        value: mount.mount_id,
        label: `${machine.machine_id} / ${mount.label ?? mount.mount_id}`,
      })),
    );
  }, [machinesState.data, machineId]);

  const jobs = jobsState.data ?? [];
  const totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const visible = jobs.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  return (
    <>
      <PageHeader
        title="任务"
        subtitle={
          jobsState.lastUpdatedAt
            ? `共 ${formatCount(jobs.length)} 条 · 更新于 ${formatTime(jobsState.lastUpdatedAt)}`
            : '巡检任务的执行记录与统计'
        }
        actions={
          <>
            <label className="row" style={{ fontSize: 'var(--text-xs)' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              <span>自动刷新（5 秒）</span>
            </label>
            <button className="btn" type="button" onClick={() => jobsState.reload()}>
              刷新
            </button>
          </>
        }
      />

      <div className="panel">
        <div className="filter-grid">
          <label className="field">
            <span className="field-label">状态</span>
            <select
              className="select"
              value={status}
              onChange={(event) => patch({ status: event.target.value })}
            >
              <option value="">全部</option>
              {STATUS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {jobStatus[value]?.label ?? value}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">机器</span>
            <select
              className="select"
              value={machineId}
              onChange={(event) => patch({ machine_id: event.target.value, mount_id: '' })}
            >
              <option value="">全部机器</option>
              {(machinesState.data ?? []).map((machine) => (
                <option key={machine.machine_id} value={machine.machine_id}>
                  {machine.label ?? machine.machine_id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">挂载点</span>
            <select
              className="select"
              value={mountId}
              onChange={(event) => patch({ mount_id: event.target.value })}
            >
              <option value="">全部挂载点</option>
              {mountOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            重置筛选
          </button>
        </div>

        {jobsState.error ? (
          <div className="alert alert-danger" role="alert" style={{ marginTop: 12 }}>
            加载任务失败：{jobsState.error.message}
          </div>
        ) : null}

        {!jobsState.data && !jobsState.error ? <PageLoading /> : null}

        {jobsState.data && jobs.length === 0 ? (
          <EmptyState
            title={status || machineId || mountId ? '当前筛选没有任务' : '还没有巡检任务'}
            description={
              status || machineId || mountId
                ? '换一组筛选条件，或重置筛选后查看全部任务。'
                : '在机器页对整机或单个挂载点发起巡检，任务会出现在这里。'
            }
            action={
              status || machineId || mountId ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => setParams(new URLSearchParams(), { replace: true })}
                >
                  重置筛选
                </button>
              ) : (
                <Link className="btn btn-primary" to="/machines">
                  去机器页发起巡检
                </Link>
              )
            }
          />
        ) : null}

        {visible.length > 0 ? (
          <>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table table-wide">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">机器 / 挂载点</th>
                    <th scope="col">模式</th>
                    <th scope="col">状态</th>
                    <th scope="col">开始</th>
                    <th scope="col">耗时</th>
                    <th scope="col">统计</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((job) => (
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
                        {job.attempt > 0 ? (
                          <div className="cell-sub">重试 {job.attempt} 次</div>
                        ) : null}
                      </td>
                      <td title={formatTime(job.started_at ?? job.created_at)}>
                        {formatRelative(job.started_at ?? job.created_at)}
                      </td>
                      <td>{jobDuration(job)}</td>
                      <td className="muted">{statsSummary(job)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={pageSafe}
              totalPages={totalPages}
              total={jobs.length}
              itemLabel="个任务"
              onPage={(next) => patch({ page: String(next) })}
            />
            {jobs.length >= 200 ? (
              <div className="muted" style={{ marginTop: 8, fontSize: 'var(--text-xs)' }}>
                最多展示最近 200 条任务；用上方筛选缩小范围。
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
