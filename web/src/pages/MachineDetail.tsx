import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  api,
  type AgentAccessTokenResult,
  type BulkScanResult,
  type Job,
  type Machine,
  type MountRef,
  type ScanMode,
} from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { KeyValue } from '../components/KeyValue';
import { Menu } from '../components/Menu';
import { Modal } from '../components/Modal';
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
  formatTime,
} from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';
import { jobMode, jobStatus, machineStatus, mountState } from '../lib/labels';

interface MachineBundle {
  machine: Machine;
  jobs: Job[];
}

function jobDuration(job: Job): string {
  if (!job.started_at || !job.finished_at) return '—';
  return formatDuration(job.finished_at - job.started_at);
}

async function loadMachine(id: string, signal: AbortSignal): Promise<Machine> {
  try {
    return await api<Machine>(`/api/v1/machines/${id}`, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const all = await api<Machine[]>('/api/v1/machines', { signal });
      const found = all.find((machine) => String(machine.id) === id);
      if (found) return found;
    }
    throw error;
  }
}

async function loadJobs(machineId: string, signal: AbortSignal): Promise<Job[]> {
  try {
    return await api<Job[]>(
      `/api/v1/jobs?machine_id=${encodeURIComponent(machineId)}&limit=20`,
      { signal },
    );
  } catch (error) {
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
      const all = await api<Job[]>('/api/v1/jobs?limit=200', { signal });
      return all.filter((job) => job.machine_id === machineId).slice(0, 20);
    }
    throw error;
  }
}

export default function MachineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const { data, error, reload } = usePolling<MachineBundle>(
    async (signal) => {
      if (!id) throw new Error('缺少机器 ID');
      const machine = await loadMachine(id, signal);
      const jobs = await loadJobs(machine.machine_id, signal);
      return { machine, jobs };
    },
    { intervalMs: 5_000, deps: [id] },
  );

  const [pending, setPending] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<AgentAccessTokenResult | null>(null);

  useDocumentTitle(data ? (data.machine.label ?? data.machine.machine_id) : '机器详情');

  const copyValue = async (value: string, label: string) => {
    const ok = await copyText(value);
    if (ok) toast.success(`已复制${label}`);
    else toast.error('复制失败', '浏览器不允许访问剪贴板，请手动选中复制。');
  };

  const submitScan = async (
    mode: ScanMode,
    scope: { machinePk: number } | { mountPk: number },
    key: string,
  ) => {
    setPending(key);
    try {
      const result = await api<BulkScanResult>('/api/v1/scans', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          ...('machinePk' in scope ? { machine_pk: scope.machinePk } : { mount_pk: scope.mountPk }),
        }),
      });
      const parts: string[] = [];
      if (result.total_mounts === 0) parts.push('没有匹配的挂载点');
      else parts.push(`已创建 ${result.created.length} 个任务`);
      if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 个`);
      toast.success(`${mode === 'incremental' ? '增量' : '全量'}巡检已提交`, parts.join(' · '));
      reload();
    } catch (err) {
      toast.error('提交巡检失败', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const issueToken = async (machine: Machine) => {
    const ok = await confirm({
      title: `重新生成机器「${machine.machine_id}」的接入 token？`,
      description: '旧 token 会立即失效，仍在运行的旧 agent 会掉线；新 token 只显示这一次。',
      confirmText: '生成 token',
      tone: 'danger',
    });
    if (!ok) return;
    setPending('token');
    try {
      setAccessToken(
        await api<AgentAccessTokenResult>(`/api/v1/machines/${machine.id}/token`, {
          method: 'POST',
        }),
      );
    } catch (err) {
      toast.error('生成接入 token 失败', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const removeMachine = async (machine: Machine) => {
    const ok = await confirm({
      title: '删除机器及其巡检数据？',
      description: `机器「${machine.machine_id}」的挂载点、文件记录、异常与任务都会被删除，且不可恢复。`,
      confirmText: '删除机器',
      tone: 'danger',
      requireText: machine.machine_id,
      inputLabel: `输入机器 ID「${machine.machine_id}」以确认`,
    });
    if (!ok) return;
    setPending('delete-machine');
    try {
      await api(`/api/v1/machines/${machine.id}`, { method: 'DELETE' });
      toast.success('已删除机器', machine.machine_id);
      navigate('/machines');
    } catch (err) {
      toast.error('删除失败', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const removeMount = async (machine: Machine, mount: MountRef) => {
    const ok = await confirm({
      title: `删除挂载点「${mount.mount_id}」？`,
      description: '该挂载点的文件记录与巡检数据会被删除；agent 再次上报同名挂载点前不会恢复。',
      confirmText: '删除挂载点',
      tone: 'danger',
    });
    if (!ok) return;
    setPending(`delete-mount-${mount.id}`);
    try {
      await api(`/api/v1/mounts/${mount.id}`, { method: 'DELETE' });
      toast.success('已删除挂载点', `${machine.machine_id}/${mount.mount_id}`);
      reload();
    } catch (err) {
      toast.error('删除挂载点失败', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  if (!data && error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="panel">
          <EmptyState
            title="机器不存在"
            description="该机器可能已被删除，或链接已失效。"
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
        加载机器详情失败：{error.message}
      </div>
    );
  }
  if (!data) return <PageLoading />;

  const { machine, jobs } = data;
  const scanning = pending !== null;
  const coverageTotals = machine.mounts.reduce(
    (acc, mount) => {
      acc.total += mount.coverage?.total ?? 0;
      acc.hashed += mount.coverage?.hashed ?? 0;
      return acc;
    },
    { total: 0, hashed: 0 },
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: '机器', to: '/machines' }, { label: machine.label ?? machine.machine_id }]}
        title={
          <>
            {machine.label ?? machine.machine_id}
            <StatusBadge value={machine.status} map={machineStatus} />
          </>
        }
        subtitle={`${machine.machine_id} · 最后心跳 ${
          machine.last_seen_at ? formatRelative(machine.last_seen_at) : '从未上线'
        }`}
        actions={
          <>
            <button
              className="btn btn-primary"
              type="button"
              disabled={scanning || machine.mounts.length === 0}
              onClick={() => void submitScan('incremental', { machinePk: machine.id }, 'scan-incremental')}
            >
              {pending === 'scan-incremental' ? '提交中…' : '整机增量巡检'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={scanning || machine.mounts.length === 0}
              onClick={() => void submitScan('full', { machinePk: machine.id }, 'scan-full')}
            >
              {pending === 'scan-full' ? '提交中…' : '整机全量巡检'}
            </button>
            <Menu
              label="更多操作"
              items={[
                {
                  label: '获取接入 token',
                  onSelect: () => void issueToken(machine),
                  disabled: scanning,
                },
                { label: '返回机器列表', to: '/machines' },
                {
                  label: '删除机器',
                  onSelect: () => void removeMachine(machine),
                  danger: true,
                  disabled: scanning,
                },
              ]}
            />
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
          <span className="kpi-label">挂载点</span>
          <span className="kpi-value">{formatCount(machine.mounts.length)}</span>
          <span className="kpi-hint">共 {formatCount(coverageTotals.total)} 个入库文件</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">覆盖率</span>
          <span className="kpi-value">
            {coverageTotals.total > 0 ? formatPercent(coverageTotals.hashed / coverageTotals.total) : '—'}
          </span>
          <ProgressBar
            value={coverageTotals.total > 0 ? coverageTotals.hashed / coverageTotals.total : null}
            label="机器整体覆盖率"
          />
        </div>
        <div className="kpi">
          <span className="kpi-label">未关闭异常</span>
          <span className="kpi-value">
            <Link
              to={`/issues?status=open&machine_id=${encodeURIComponent(machine.machine_id)}`}
              style={{ color: 'inherit' }}
            >
              {formatCount(machine.open_issues ?? 0)}
            </Link>
          </span>
          <span className="kpi-hint">点击查看该机器的异常</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">最近巡检</span>
          <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
            {machine.last_job_at ? formatRelative(machine.last_job_at) : '尚未巡检'}
          </span>
          <span className="kpi-hint">
            {jobs[0] ? `最近任务 #${jobs[0].id}` : '还没有巡检任务'}
          </span>
        </div>
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>基本信息</h2>
      <div className="panel">
        <KeyValue
          items={[
            { label: '机器 ID', value: <span className="mono">{machine.machine_id}</span> },
            { label: '主机名', value: machine.hostname ?? '—' },
            { label: '平台', value: `${machine.platform ?? '—'} / ${machine.arch ?? '—'}` },
            { label: 'agent 版本', value: machine.agent_version ?? '—' },
            { label: 'agent 协议', value: machine.agent_protocol ?? '—' },
            {
              label: '最后心跳',
              value: machine.last_seen_at ? formatTime(machine.last_seen_at) : '从未上线',
            },
            { label: '机器主键', value: <span className="mono">#{machine.id}</span> },
          ]}
        />
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>挂载点</h2>
      <div className="panel">
        {machine.mounts.length === 0 ? (
          <EmptyState
            title="这台机器还没有挂载点"
            description="在 agent 配置或桌面端设置里新增挂载点并启动，挂载点会自动同步到这里。"
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col">挂载点</th>
                  <th scope="col">状态</th>
                  <th scope="col">覆盖率</th>
                  <th scope="col" className="num">
                    清单版本
                  </th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {machine.mounts.map((mount) => (
                  <tr key={mount.id}>
                    <td>
                      <Link to={`/mounts/${mount.id}`}>{mount.label ?? mount.mount_id}</Link>
                      {mount.label && mount.label !== mount.mount_id ? (
                        <div className="cell-sub">{mount.mount_id}</div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge value={mount.state} map={mountState} />
                    </td>
                    <td style={{ minWidth: 140 }}>
                      {mount.coverage ? (
                        <ProgressBar
                          value={mount.coverage.total > 0 ? mount.coverage.ratio : null}
                          label={`${mount.mount_id} 覆盖率`}
                          showValue
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">{formatCount(mount.manifest_epoch)}</td>
                    <td>
                      <div className="row-actions">
                        <Link className="btn btn-sm" to={`/files?mount_pk=${mount.id}`}>
                          文件
                        </Link>
                        <Menu
                          label="更多"
                          items={[
                            { label: '挂载点详情', to: `/mounts/${mount.id}` },
                            {
                              label: '增量扫描',
                              onSelect: () =>
                                void submitScan(
                                  'incremental',
                                  { mountPk: mount.id },
                                  `mount-${mount.id}-incremental`,
                                ),
                              disabled: scanning,
                            },
                            {
                              label: '全量扫描',
                              onSelect: () =>
                                void submitScan('full', { mountPk: mount.id }, `mount-${mount.id}-full`),
                              disabled: scanning,
                            },
                            {
                              label: '删除挂载点',
                              onSelect: () => void removeMount(machine, mount),
                              danger: true,
                              disabled: scanning,
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>最近任务</h2>
      <div className="panel">
        {jobs.length === 0 ? (
          <div className="muted">这台机器还没有巡检任务。</div>
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">挂载点</th>
                  <th scope="col">模式</th>
                  <th scope="col">状态</th>
                  <th scope="col">开始</th>
                  <th scope="col">耗时</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link to={`/jobs/${job.id}`}>#{job.id}</Link>
                    </td>
                    <td>{job.mount_id}</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={accessToken !== null}
        title="接入 token"
        subtitle={accessToken ? `机器 ${accessToken.machine_id}` : undefined}
        onClose={() => setAccessToken(null)}
        footer={
          <>
            <button
              className="btn"
              type="button"
              onClick={() => accessToken && void copyValue(accessToken.token, '接入 token')}
            >
              复制接入 token
            </button>
            <button className="btn btn-primary" type="button" onClick={() => setAccessToken(null)}>
              关闭
            </button>
          </>
        }
      >
        {accessToken ? (
          <div className="stack">
            <div className="alert alert-info">
              长期有效、可多次使用；重新生成后旧 token 立即失效。在 agent GUI 首次配置里粘贴，点「识别已有节点」即可自动填充机器与挂载点。
            </div>
            <pre className="code-block" style={{ maxHeight: 120 }}>
              {accessToken.token}
            </pre>
            <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              agent #{accessToken.agent_id} · 已撤销旧 agent {accessToken.revoked_agents} 个
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
