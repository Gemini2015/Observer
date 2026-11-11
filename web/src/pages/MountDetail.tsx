import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  api,
  fetchMountUnseen,
  rebaselineMount,
  type Job,
  type MountDetail,
  type MountUnseen,
  type ScanMode,
} from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { JsonDetails, KeyValue } from '../components/KeyValue';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { copyText } from '../lib/clipboard';
import {
  formatBytes,
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
  /** 最近一轮未出现的已知文件；接口未就绪或请求失败时为 null。 */
  unseen: MountUnseen | null;
}

function jobDuration(job: Job): string {
  if (!job.started_at || !job.finished_at) return '—';
  return formatDuration(job.finished_at - job.started_at);
}

export default function MountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<ScanMode | null>(null);
  const [rebaselineBusy, setRebaselineBusy] = useState(false);

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
      // 附加数据：接口未就绪或请求失败时降级为不展示，不影响整页其他内容。
      let unseen: MountUnseen | null = null;
      try {
        unseen = await fetchMountUnseen(mount.id, 200, signal);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
      }
      return { mount, jobs, unseen };
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

  const { mount, jobs, unseen } = data;
  const lastJob = mount.last_job;
  const stats = lastJob?.stats ? Object.entries(lastJob.stats) : [];
  const hasCoverage = mount.coverage.total > 0;
  const visibleUnseenItems = unseen?.items.slice(0, 50) ?? [];
  const hiddenUnseenCount = unseen
    ? Math.max(0, unseen.unseen_count - visibleUnseenItems.length)
    : 0;

  const performRebaseline = async (target: MountUnseen) => {
    const job = target.job;
    if (!job) return;
    const count = formatCount(target.unseen_count);
    const ok = await confirm({
      title: `确认这 ${count} 个文件已删除并重建基线？`,
      description: (
        <>
          <div>
            确认后这 {count} 个文件将标记为「已移出规则」并从此基线移除；系统会重建基线、把挂载点恢复为
            active（正常），并通知 agent 重新拉取清单。
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            不会删除磁盘上的任何文件。
          </div>
        </>
      ),
      confirmText: '确认删除',
      tone: 'danger',
    });
    if (!ok) return;
    setRebaselineBusy(true);
    try {
      const result = await rebaselineMount(mount.id, job.id);
      toast.success(
        '已确认删除',
        `已处理 ${formatCount(result.updated)} 个文件，挂载点已恢复为正常`,
      );
      reload();
    } catch (err) {
      toast.error('重建基线失败', (err as Error).message);
    } finally {
      setRebaselineBusy(false);
    }
  };

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

      {unseen && unseen.job && unseen.unseen_count > 0 ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="section-title">
            <h3>最近一轮未出现的文件</h3>
            <span className="muted">
              {formatCount(unseen.unseen_count)} / {formatCount(unseen.total_active)} 个已知文件
            </span>
          </div>
          <div className="muted" style={{ marginBottom: 10, fontSize: 'var(--text-xs)' }}>
            任务 #{unseen.job.id}（{jobMode[unseen.job.mode]?.label ?? unseen.job.mode}、
            {unseen.job.finished_at ? formatRelative(unseen.job.finished_at) : '进行中'}）共发现{' '}
            {formatCount(unseen.job.seen)} 个文件；{formatCount(unseen.unseen_count)}{' '}
            个已知文件在本轮未出现。系统按「疑似掉盘」熔断，不会逐文件报异常。
          </div>
          {visibleUnseenItems.length > 0 ? (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th scope="col">路径</th>
                    <th scope="col" className="num">
                      大小
                    </th>
                    <th scope="col">最后发现</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnseenItems.map((item) => (
                    <tr key={item.id}>
                      <td className="mono">{item.path_key}</td>
                      <td className="num">{formatBytes(item.size)}</td>
                      <td title={item.last_seen_at ? formatTime(item.last_seen_at) : undefined}>
                        {item.last_seen_at ? formatRelative(item.last_seen_at) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">没有可展示的未出现文件明细。</div>
          )}
          {hiddenUnseenCount > 0 ? (
            <div className="muted" style={{ marginTop: 8, fontSize: 'var(--text-xs)' }}>
              还有 {formatCount(hiddenUnseenCount)} 条未显示。
            </div>
          ) : null}
          {unseen.truncated ? (
            <div className="muted" style={{ marginTop: 4, fontSize: 'var(--text-xs)' }}>
              接口最多返回 {formatCount(unseen.limit)} 条，共 {formatCount(unseen.unseen_count)}{' '}
              条未出现文件。
            </div>
          ) : null}
          {unseen.rules_changed ? (
            <div className="alert alert-warn" style={{ marginTop: 10 }}>
              巡检规则已变化，最近一轮结果不能用于判定消失；请先手动巡检后再确认。
            </div>
          ) : unseen.job.seen === 0 ? (
            <div className="alert alert-warn" style={{ marginTop: 10 }}>
              最近一轮没有读到任何文件（挂载可能不可用），请先确认磁盘已挂载。
            </div>
          ) : (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button
                className="btn btn-danger"
                type="button"
                disabled={rebaselineBusy}
                onClick={() => void performRebaseline(unseen)}
              >
                {rebaselineBusy ? '处理中…' : '确认已删除并重建基线'}
              </button>
              <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                确认后这 {formatCount(unseen.unseen_count)}{' '}
                个文件将标记为“已移出规则”并从此基线移除，挂载点恢复为正常并通知 agent
                重新拉取清单；不会删除磁盘上的任何文件。
              </span>
            </div>
          )}
        </div>
      ) : null}

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
