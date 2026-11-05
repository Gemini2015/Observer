import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type AgentAccessTokenResult,
  type BulkScanResult,
  type EnrollTokenResult,
  type Machine,
  type ScanMode,
} from '../api';
import { EmptyState } from '../components/EmptyState';
import { Menu } from '../components/Menu';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { copyText } from '../lib/clipboard';
import { formatCount, formatRelative, formatTime } from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';
import { labelOf, machineStatus, mountState } from '../lib/labels';

const TTL_OPTIONS = [
  { hours: 24, label: '24 小时' },
  { hours: 72, label: '72 小时' },
  { hours: 168, label: '7 天' },
];

function modeLabel(mode: ScanMode): string {
  return mode === 'incremental' ? '增量' : '全量';
}

function machineCoverage(machine: Machine): { ratio: number | null; hashed: number; total: number } {
  let total = 0;
  let hashed = 0;
  for (const mount of machine.mounts) {
    total += mount.coverage?.total ?? 0;
    hashed += mount.coverage?.hashed ?? 0;
  }
  if (total === 0) return { ratio: null, hashed: 0, total: 0 };
  return { ratio: hashed / total, hashed, total };
}

function mountSummary(machine: Machine): string {
  if (machine.mounts.length === 0) return '无挂载点';
  const counts = new Map<string, number>();
  for (const mount of machine.mounts) {
    const label = labelOf(mountState, mount.state).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => `${label} ${count}`)
    .join(' · ');
}

export default function MachinesPage() {
  useDocumentTitle('机器与挂载点');
  const toast = useToast();
  const confirm = useConfirm();

  const { data: machines, error, lastUpdatedAt, reload } = usePolling(
    async (signal) => api<Machine[]>('/api/v1/machines', { signal }),
    { intervalMs: 5_000 },
  );

  const [pending, setPending] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [machineHint, setMachineHint] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [issued, setIssued] = useState<EnrollTokenResult | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [accessToken, setAccessToken] = useState<AgentAccessTokenResult | null>(null);

  const closeEnroll = () => {
    setEnrollOpen(false);
    setIssued(null);
    setMachineHint('');
    setTtlHours(24);
  };

  const createEnrollToken = async () => {
    setEnrollBusy(true);
    try {
      const result = await api<EnrollTokenResult>('/api/v1/enroll-tokens', {
        method: 'POST',
        body: JSON.stringify({
          machine_hint: machineHint.trim() || undefined,
          ttl_hours: ttlHours,
        }),
      });
      setIssued(result);
    } catch (err) {
      toast.error('生成注册 token 失败', (err as Error).message);
    } finally {
      setEnrollBusy(false);
    }
  };

  const copyValue = async (value: string, label: string) => {
    const ok = await copyText(value);
    if (ok) toast.success(`已复制${label}`);
    else toast.error('复制失败', '浏览器不允许访问剪贴板，请手动选中复制。');
  };

  const runScan = async (scope: 'all' | 'machine', mode: ScanMode, machine?: Machine) => {
    if (scope === 'all') {
      const ok = await confirm({
        title: `对全部机器的所有挂载点执行${modeLabel(mode)}扫描？`,
        description: '已有排队中或进行中任务的挂载点会被自动跳过，不会打断正在运行的巡检。',
        confirmText: '开始扫描',
      });
      if (!ok) return;
    }
    const key = scope === 'all' ? `all-${mode}` : `machine-${machine?.id}-${mode}`;
    setPending(key);
    try {
      const result = await api<BulkScanResult>('/api/v1/scans', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          ...(scope === 'machine' ? { machine_pk: machine?.id } : {}),
        }),
      });
      const parts: string[] = [];
      if (result.total_mounts === 0) parts.push('没有匹配的挂载点');
      else parts.push(`已创建 ${result.created.length} 个任务`);
      if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 个`);
      toast.success(`${modeLabel(mode)}扫描已提交`, parts.join(' · '));
      reload();
    } catch (err) {
      toast.error('提交扫描失败', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const issueAccessToken = async (machine: Machine) => {
    const ok = await confirm({
      title: `重新生成机器「${machine.machine_id}」的接入 token？`,
      description: '旧 token 会立即失效，仍在运行的旧 agent 会掉线；新 token 只显示这一次。',
      confirmText: '生成 token',
      tone: 'danger',
    });
    if (!ok) return;
    setPending(`token-${machine.id}`);
    try {
      const result = await api<AgentAccessTokenResult>(`/api/v1/machines/${machine.id}/token`, {
        method: 'POST',
      });
      setAccessToken(result);
    } catch (err) {
      toast.error('生成接入 token 失败', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const removeMachine = async (machine: Machine) => {
    const ok = await confirm({
      title: '删除机器及其巡检数据？',
      description: `机器「${machine.machine_id}」的挂载点、文件记录、异常与任务都会被删除，且不可恢复。该 agent 需要重新注册才能接入。`,
      confirmText: '删除机器',
      tone: 'danger',
      requireText: machine.machine_id,
      inputLabel: `输入机器 ID「${machine.machine_id}」以确认`,
    });
    if (!ok) return;
    setPending(`delete-${machine.id}`);
    try {
      await api(`/api/v1/machines/${machine.id}`, { method: 'DELETE' });
      toast.success('已删除机器', machine.machine_id);
      reload();
    } catch (err) {
      toast.error('删除失败', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  if (!machines && error) {
    return (
      <div className="alert alert-danger" role="alert">
        加载机器列表失败：{error.message}
      </div>
    );
  }
  if (!machines) return <PageLoading />;

  const totalMounts = machines.reduce((sum, machine) => sum + machine.mounts.length, 0);
  const scanning = pending !== null;

  return (
    <>
      <PageHeader
        title="机器与挂载点"
        subtitle={`${machines.length} 台机器 · ${totalMounts} 个挂载点${
          lastUpdatedAt ? ` · 更新于 ${formatTime(lastUpdatedAt)}` : ''
        }`}
        actions={
          <>
            <button
              className="btn btn-primary"
              type="button"
              disabled={scanning || machines.length === 0}
              onClick={() => void runScan('all', 'incremental')}
            >
              {pending === 'all-incremental' ? '提交中…' : '全部机器增量巡检'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={scanning || machines.length === 0}
              onClick={() => void runScan('all', 'full')}
            >
              {pending === 'all-full' ? '提交中…' : '全部机器全量巡检'}
            </button>
            <button className="btn" type="button" onClick={() => setEnrollOpen(true)}>
              注册新机器
            </button>
          </>
        }
      />

      {error ? (
        <div className="alert alert-warn" role="status" style={{ marginBottom: 12 }}>
          刷新失败：{error.message}，当前显示上一次成功获取的数据。
        </div>
      ) : null}

      <div className="panel">
        {machines.length === 0 ? (
          <EmptyState
            title="还没有 agent 注册"
            description="生成一次性注册 token，在 agent 配置里填入后启动，机器与挂载点会自动出现。"
            action={
              <button className="btn btn-primary" type="button" onClick={() => setEnrollOpen(true)}>
                注册新机器
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col">机器</th>
                  <th scope="col">状态</th>
                  <th scope="col">最后心跳</th>
                  <th scope="col">挂载点</th>
                  <th scope="col">覆盖率</th>
                  <th scope="col" className="num">
                    未关闭异常
                  </th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((machine) => {
                  const coverage = machineCoverage(machine);
                  return (
                    <tr key={machine.id}>
                      <td>
                        <Link to={`/machines/${machine.id}`}>
                          <strong>{machine.label ?? machine.machine_id}</strong>
                        </Link>
                        <div className="cell-sub">
                          {machine.label && machine.label !== machine.machine_id
                            ? `${machine.machine_id} · `
                            : ''}
                          {machine.hostname ?? '—'} · {machine.platform ?? '—'}/
                          {machine.arch ?? '—'}
                        </div>
                        <div className="cell-sub">agent {machine.agent_version ?? '—'}</div>
                      </td>
                      <td>
                        <StatusBadge value={machine.status} map={machineStatus} />
                      </td>
                      <td title={formatTime(machine.last_seen_at)}>
                        {machine.last_seen_at ? formatRelative(machine.last_seen_at) : '从未上线'}
                      </td>
                      <td>
                        {formatCount(machine.mounts.length)} 个
                        <div className="cell-sub">{mountSummary(machine)}</div>
                      </td>
                      <td style={{ minWidth: 140 }}>
                        {coverage.ratio !== null ? (
                          <ProgressBar
                            value={coverage.ratio}
                            label={`${machine.machine_id} 覆盖率`}
                            showValue
                          />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        {machine.open_issues !== undefined ? (
                          <Link
                            to={`/issues?status=open&machine_id=${encodeURIComponent(machine.machine_id)}`}
                          >
                            {formatCount(machine.open_issues)}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <Menu
                            label="操作"
                            items={[
                              { label: '查看详情', to: `/machines/${machine.id}` },
                              {
                                label: '整机增量巡检',
                                onSelect: () => void runScan('machine', 'incremental', machine),
                                disabled: scanning,
                              },
                              {
                                label: '整机全量巡检',
                                onSelect: () => void runScan('machine', 'full', machine),
                                disabled: scanning,
                              },
                              {
                                label: '获取接入 token',
                                onSelect: () => void issueAccessToken(machine),
                                disabled: scanning,
                              },
                              {
                                label: '删除机器',
                                onSelect: () => void removeMachine(machine),
                                danger: true,
                                disabled: scanning,
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={enrollOpen}
        title="注册新机器"
        subtitle="注册 token 仅用于新节点首次注册，一次性使用"
        onClose={closeEnroll}
        footer={
          issued ? (
            <>
              <button className="btn" type="button" onClick={() => void copyValue(issued.token, '注册 token')}>
                复制 token
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setIssued(null);
                  setMachineHint('');
                }}
              >
                再生成一个
              </button>
              <button className="btn btn-primary" type="button" onClick={closeEnroll}>
                完成
              </button>
            </>
          ) : (
            <>
              <button className="btn" type="button" onClick={closeEnroll}>
                取消
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={enrollBusy}
                onClick={() => void createEnrollToken()}
              >
                {enrollBusy ? '生成中…' : '生成 token'}
              </button>
            </>
          )
        }
      >
        {issued ? (
          <div className="stack">
            <div className="alert alert-warn">
              token 只显示这一次。把它填入 agent 配置的 <code>agent.token</code> 后启动 agent。
            </div>
            <pre className="code-block" style={{ maxHeight: 120 }}>
              {issued.token}
            </pre>
            <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              有效期至 {formatTime(issued.expires_at)}
              {issued.machine_hint ? ` · 机器提示 ${issued.machine_hint}` : ''}
            </div>
          </div>
        ) : (
          <div className="stack">
            <label className="field">
              <span className="field-label">机器 ID 提示（可选）</span>
              <input
                className="input"
                value={machineHint}
                onChange={(event) => setMachineHint(event.target.value)}
                placeholder="例如 nas-01"
                autoComplete="off"
              />
              <span>仅用于展示，agent 实际以配置中的 machine_id 注册。</span>
            </label>
            <label className="field">
              <span className="field-label">有效期</span>
              <select
                className="select"
                value={String(ttlHours)}
                onChange={(event) => setTtlHours(Number(event.target.value))}
              >
                {TTL_OPTIONS.map((option) => (
                  <option key={option.hours} value={String(option.hours)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </Modal>

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
              长期有效、可多次使用。token 只显示这一次；重新生成后旧 token 立即失效。在 agent GUI
              首次配置里粘贴，点「识别已有节点」即可自动填充机器与挂载点。
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
