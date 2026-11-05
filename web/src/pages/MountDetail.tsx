import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, type Job, type MountDetail, type ScanMode } from '../api';
import { EmptyState } from '../components/EmptyState';
import { JsonDetails, KeyValue } from '../components/KeyValue';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { copyText } from '../lib/clipboard';
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  formatStatValue,
  formatTime,
} from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';
import { jobMode, jobStatus, mountState, statLabel } from '../lib/labels';

interface MountBundle {
  mount: MountDetail;
  jobs: Job[];
}

function jobDuration(job: Job): string {
  if (!job.started_at || !job.finished_at) return '—';
  return formatDuration(job.finished_at - job.started_at);
}

export default function MountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [busy, setBusy] = useState<ScanMode | null>(null);

  const { data, error, reload } = usePolling<MountBundle>(
    async (signal) => {
      if (!id) throw new Error('缺少挂载点 ID');
      const mount = await api<MountDetail>(`/api/v1/mounts/${id}`, { signal });
      let jobs: Job[] = [];
      try {
        jobs = await api<Job[]>(
          `/api/v1/jobs?mount_id=${encodeURIComponent(mount.mount_id)}&limit=10`,
          { signal },
        );
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
      return { mount, jobs };
    },
    { intervalMs: 5_000, deps: [id] },
  );

  useDocumentTitle(data ? (data.mount.label ?? data.mount.mount_id) : '挂载点详情');

  const trigger = async (mode: ScanMode) => {
    if (!id) return;
    setBusy(mode);
    try {
      const result = await api<{ job_id: number }>(`/api/v1/mounts/${id}/scan`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      toast.success('巡检已提交', `已创建任务 #${result.job_id}`);
      reload();
    } catch (err) {
      toast.error('提交巡检失败', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyValue = async (value: string, label: string) => {
    const ok = await copyText(value);
    if (ok) toast.success(`已复制${label}`);
    else toast.error('复制失败', '浏览器不允许访问剪贴板，请手动选中复制。');
  };

  if (!data && error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="panel">
          <EmptyState
            title="挂载点不存在"
            description="该挂载点可能已被删除，或链接已失效。"
            action={
              <Link className="btn btn-primary" to="/machines">
                返回机器列表
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="alert alert-danger" role="alert">
        加载挂载点详情失败：{error.message}
      </div>
    );
  }
  if (!data) return <PageLoading />;

  const { mount, jobs } = data;
  const lastJob = mount.last_job;
  const stats = lastJob?.stats ? Object.entries(lastJob.stats) : [];
  const hasCoverage = mount.coverage.total > 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: '机器', to: '/machines' },
          { label: mount.machine_id ?? '未知机器', to: '/machines' },
          { label: mount.label ?? mount.mount_id },
        ]}
        title={
          <>
            {mount.label ?? mount.mount_id}
            <StatusBadge value={mount.state} map={mountState} />
          </>
        }
        subtitle={`${mount.label ? `${mount.mount_id} · ` : ''}${mount.machine_id ?? '—'}`}
        actions={
          <>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy !== null}
              onClick={() => void trigger('incremental')}
            >
              {busy === 'incremental' ? '提交中…' : '增量巡检'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy !== null}
              onClick={() => void trigger('full')}
            >
              {busy === 'full' ? '提交中…' : '全量巡检'}
            </button>
            <Link className="btn" to={`/files?mount_pk=${mount.id}`}>
              查看文件
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
          <span className="kpi-label">校验覆盖率</span>
          <span className="kpi-value">{hasCoverage ? formatPercent(mount.coverage.ratio) : '—'}</span>
          <span className="kpi-hint">
            {hasCoverage
              ? `${formatCount(mount.coverage.hashed)} / ${formatCount(mount.coverage.total)} 个文件已校验`
              : '还没有入库文件'}
          </span>
          <ProgressBar
            value={hasCoverage ? mount.coverage.ratio : null}
            label="挂载点覆盖率"
          />
        </div>
        <div className="kpi">
          <span className="kpi-label">清单版本</span>
          <span className="kpi-value">{formatCount(mount.manifest_epoch)}</span>
          <span className="kpi-hint">规则指纹 {mount.rules_hash.slice(0, 12)}…</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">最近巡检</span>
          <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
            {lastJob ? (
              <StatusBadge value={lastJob.status} map={jobStatus} />
            ) : (
              <span className="muted">尚未巡检</span>
            )}
          </span>
          <span className="kpi-hint">
            {lastJob
              ? `#${lastJob.id} · ${lastJob.finished_at ? formatRelative(lastJob.finished_at) : '进行中'}`
              : '还没有巡检任务'}
          </span>
        </div>
      </div>

      <div className="split" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-title" style={{ marginBottom: 12 }}>
            基本信息
          </div>
          <KeyValue
            items={[
              {
                label: '物理路径',
                value: (
                  <div className="row">
                    <span className="mono">{mount.physical_path}</span>
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => void copyValue(mount.physical_path, '物理路径')}
                    >
                      复制
                    </button>
                  </div>
                ),
              },
              {
                label: '所属机器',
                value: mount.machine_id ? (
                  <Link to="/machines">{mount.machine_id}</Link>
                ) : (
                  '—'
                ),
              },
              { label: '状态', value: <StatusBadge value={mount.state} map={mountState} /> },
              {
                label: '跨机修复',
                value: mount.repair_allowed ? '允许（可作为修复目标）' : '未开启',
              },
              {
                label: '规则指纹',
                value: (
                  <div className="row">
                    <span className="mono">{mount.rules_hash}</span>
                  </div>
                ),
              },
            ]}
          />
        </div>

        <div className="panel">
          <div className="panel-title" style={{ marginBottom: 12 }}>
            调度
          </div>
          <KeyValue
            items={[
              { label: '时间窗口', value: mount.schedule?.window ? mount.schedule.window : '全天' },
              {
                label: '每日预算',
                value:
                  mount.schedule && mount.schedule.budgetMinutesPerDay > 0
                    ? `${mount.schedule.budgetMinutesPerDay} 分钟`
                    : '不限',
              },
              {
                label: '巡检间隔',
                value: `${mount.schedule?.intervalMinutes ?? 1440} 分钟`,
              },
            ]}
          />
        </div>
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>规则</h2>
      <div className="panel stack-gap-3">
        <div>
          <div className="muted" style={{ fontSize: 'var(--text-xs)', marginBottom: 6 }}>
            include（{mount.include.length === 0 ? '全部' : `${mount.include.length} 条`}）
          </div>
          <div className="chips">
            {mount.include.length === 0 ? (
              <span className="muted">扫描挂载点下所有文件。</span>
            ) : (
              mount.include.map((pattern) => (
                <code className="chip chip-static" key={pattern}>
                  {pattern}
                </code>
              ))
            )}
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 'var(--text-xs)', marginBottom: 6 }}>
            exclude（{mount.exclude.length === 0 ? '无' : `${mount.exclude.length} 条`}）
          </div>
          <div className="chips">
            {mount.exclude.length === 0 ? (
              <span className="muted">没有排除规则。</span>
            ) : (
              mount.exclude.map((pattern) => (
                <code className="chip chip-static" key={pattern}>
                  {pattern}
                </code>
              ))
            )}
          </div>
        </div>
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>最近任务</h2>
      <div className="panel">
        {jobs.length === 0 ? (
          <div className="muted">这个挂载点还没有巡检任务。</div>
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">模式</th>
                  <th scope="col">状态</th>
                  <th scope="col">开始</th>
                  <th scope="col">耗时</th>
                  <th scope="col">统计</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link to={`/jobs/${job.id}`}>#{job.id}</Link>
                    </td>
                    <td>
                      <StatusBadge value={job.mode} map={jobMode} dot={false} />
                    </td>
                    <td>
                      <StatusBadge value={job.status} map={jobStatus} />
                    </td>
                    <td title={formatTime(job.started_at ?? job.created_at)}>
                      {formatRelative(job.started_at ?? job.created_at)}
                    </td>
                    <td>{jobDuration(job)}</td>
                    <td className="muted">
                      {job.stats
                        ? `发现 ${formatStatValue('seen', job.stats.seen)} · 已校验 ${formatStatValue(
                            'hashed',
                            job.stats.hashed,
                          )} · 跳过 ${formatStatValue('skipped', job.stats.skipped)}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {lastJob && stats.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <div className="section-title">
              <h3>最近一轮统计（#{lastJob.id}）</h3>
            </div>
            <div className="table-wrap">
              <table className="table table-compact">
                <tbody>
                  {stats.map(([key, value]) => (
                    <tr key={key}>
                      <td className="muted" style={{ width: 180 }} title={key}>
                        {statLabel(key)}
                      </td>
                      <td>{formatStatValue(key, value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <JsonDetails value={lastJob.stats} summary="查看原始统计 JSON" />
          </div>
        ) : null}
      </div>
    </>
  );
}
