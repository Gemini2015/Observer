import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  formatRatio,
  formatRelative,
  formatTime,
  statusClass,
  type AgentAccessTokenResult,
  type BulkScanResult,
  type EnrollTokenResult,
  type Machine,
  type MountRef,
  type ScanMode,
} from '../api';

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [machineHint, setMachineHint] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [issued, setIssued] = useState<EnrollTokenResult | null>(null);
  const [accessToken, setAccessToken] = useState<AgentAccessTokenResult | null>(null);
  const [rotating, setRotating] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Machine[]>('/api/v1/machines')
      .then(setMachines)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const createToken = async () => {
    setCreating(true);
    setFormError(null);
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
      setFormError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const copyToken = async () => {
    if (!issued) return;
    await copyText(issued.token);
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 剪贴板不可用时用户可手动选中复制
    }
  };

  const issueAccessToken = async (machine: Machine) => {
    if (
      !window.confirm(
        `重新生成机器「${machine.machine_id}」的接入 token？\n旧 token 将立即失效，旧 agent 会掉线；token 只显示这一次。`,
      )
    ) {
      return;
    }
    setActionError(null);
    setRotating(machine.id);
    try {
      const result = await api<AgentAccessTokenResult>(`/api/v1/machines/${machine.id}/token`, {
        method: 'POST',
      });
      setAccessToken(result);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setRotating(null);
    }
  };

  const scanTarget = async (
    scope: 'all' | 'machine' | 'mount',
    mode: ScanMode,
    machine?: Machine,
    mount?: MountRef,
  ) => {
    const label = mode === 'incremental' ? '增量' : '全量';
    if (scope === 'all') {
      if (!window.confirm(`确认对全部机器的所有挂载点执行${label}扫描？`)) return;
    } else if (scope === 'machine') {
      if (!window.confirm(`确认对机器「${machine?.machine_id}」的所有挂载点执行${label}扫描？`)) return;
    }
    const key =
      scope === 'all'
        ? `all-${mode}`
        : scope === 'machine'
          ? `machine-${machine!.id}-${mode}`
          : `mount-${mount!.id}-${mode}`;
    setScanning(key);
    setScanMessage(null);
    setActionError(null);
    try {
      const body: Record<string, unknown> = { mode };
      if (scope === 'machine') body.machine_pk = machine!.id;
      if (scope === 'mount') body.mount_pk = mount!.id;
      const result = await api<BulkScanResult>('/api/v1/scans', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const parts: string[] = [];
      if (result.total_mounts === 0) {
        parts.push('没有匹配的挂载点');
      } else {
        parts.push(`已创建 ${result.created.length} 个任务`);
      }
      if (result.skipped.length > 0) {
        parts.push(`跳过 ${result.skipped.length} 个（已有活跃任务）`);
      }
      setScanMessage(`扫描模式：${result.mode === 'incremental' ? '增量' : '全量'} · ${parts.join(' · ')}`);
      load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setScanning(null);
    }
  };

  const removeMachine = async (machine: Machine) => {
    if (
      !window.confirm(
        `删除机器「${machine.machine_id}」及其全部挂载点与巡检数据？\n此操作不可恢复；删除后该 agent 需要重新注册。`,
      )
    ) {
      return;
    }
    setDeleting(`machine-${machine.id}`);
    setActionError(null);
    try {
      await api(`/api/v1/machines/${machine.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  const removeMount = async (machine: Machine, mount: MountRef) => {
    if (
      !window.confirm(
        `删除挂载点「${machine.machine_id}/${mount.mount_id}」及其巡检数据？\n此操作不可恢复；重新添加需要重新注册该挂载点。`,
      )
    ) {
      return;
    }
    setDeleting(`mount-${mount.id}`);
    setActionError(null);
    try {
      await api(`/api/v1/mounts/${mount.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  if (error) return <div className="error">{error}</div>;
  if (!machines) return <div className="muted">加载中…</div>;

  return (
    <>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <h1>机器与挂载点</h1>
        <div className="toolbar">
          <button
            className="primary"
            type="button"
            disabled={scanning !== null || !machines || machines.length === 0}
            onClick={() => void scanTarget('all', 'incremental')}
          >
            {scanning === 'all-incremental' ? '扫描中…' : '全部机器增量扫描'}
          </button>
          <button
            className="primary"
            type="button"
            disabled={scanning !== null || !machines || machines.length === 0}
            onClick={() => void scanTarget('all', 'full')}
          >
            {scanning === 'all-full' ? '扫描中…' : '全部机器全量扫描'}
          </button>
          <button className="primary" type="button" onClick={() => setShowTokenForm((value) => !value)}>
            {showTokenForm ? '收起' : '注册新机器'}
          </button>
        </div>
      </div>

      {scanMessage ? <div className="muted">{scanMessage}</div> : null}

      {showTokenForm ? (
        <div className="panel">
          <h2>生成注册 token</h2>
          <p className="muted">
            注册 token 仅用于新节点首次注册，一次性；已有节点重连请用机器面板里的「获取接入 token」。
          </p>
          {issued ? (
            <>
              <p className="muted">
                token 只显示这一次；把下面的值填入 agent 配置的 <code>agent.token</code>，然后启动 agent。
              </p>
              <pre className="code">{issued.token}</pre>
              <div className="toolbar">
                <button className="ghost" type="button" onClick={() => void copyToken()}>
                  复制 token
                </button>
                <span className="muted">
                  有效期至 {formatTime(issued.expires_at)}
                  {issued.machine_hint ? ` · 机器提示 ${issued.machine_hint}` : ''}
                </span>
                <button className="ghost" type="button" onClick={() => setIssued(null)}>
                  再生成一个
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="toolbar">
                <label>
                  机器 ID 提示（可选）
                  <input
                    value={machineHint}
                    onChange={(event) => setMachineHint(event.target.value)}
                    placeholder="例如 nas-01"
                  />
                </label>
                <label>
                  有效期
                  <select value={ttlHours} onChange={(event) => setTtlHours(Number(event.target.value))}>
                    <option value={24}>24 小时</option>
                    <option value={72}>72 小时</option>
                    <option value={168}>7 天</option>
                  </select>
                </label>
                <button className="primary" type="button" disabled={creating} onClick={() => void createToken()}>
                  {creating ? '生成中…' : '生成 token'}
                </button>
              </div>
              {formError ? <div className="error">{formError}</div> : null}
              <p className="muted">机器 ID 提示只用于展示，agent 实际以配置中的 machine_id 注册。</p>
            </>
          )}
        </div>
      ) : null}

      {accessToken ? (
        <div className="panel">
          <div className="panel-header">
            <h2>接入 token · {accessToken.machine_id}</h2>
            <button className="ghost" type="button" onClick={() => setAccessToken(null)}>
              关闭
            </button>
          </div>
          <p className="muted">
            长期有效，可多次使用；token 只显示这一次，重新生成后旧 token 立即失效。
            在 agent GUI 首次配置里粘贴，点「识别已有节点」即可自动填充机器与挂载点。
          </p>
          <pre className="code">{accessToken.token}</pre>
          <div className="toolbar">
            <button className="ghost" type="button" onClick={() => void copyText(accessToken.token)}>
              复制接入 token
            </button>
            <span className="muted">
              agent {accessToken.agent_id} · 撤销旧 agent {accessToken.revoked_agents} 个
            </span>
          </div>
        </div>
      ) : null}

      {actionError ? <div className="error">{actionError}</div> : null}
      {machines.length === 0 ? <div className="muted">还没有 agent 注册</div> : null}
      {machines.map((machine) => (
        <div className="panel" key={machine.id}>
          <div className="panel-header">
            <h2>
              {machine.label ?? machine.machine_id}{' '}
              <span className="muted">
                ({machine.machine_id} · {machine.status})
              </span>
            </h2>
            <div className="panel-actions">
              <button
                className="ghost"
                type="button"
                disabled={scanning !== null}
                onClick={() => void scanTarget('machine', 'incremental', machine)}
              >
                {scanning === `machine-${machine.id}-incremental` ? '扫描中…' : '整机增量'}
              </button>
              <button
                className="ghost"
                type="button"
                disabled={scanning !== null}
                onClick={() => void scanTarget('machine', 'full', machine)}
              >
                {scanning === `machine-${machine.id}-full` ? '扫描中…' : '整机全量'}
              </button>
              <Link className="ghost" to={`/files?machine_id=${encodeURIComponent(machine.machine_id)}`}>
                文件
              </Link>
              <button
                className="ghost"
                type="button"
                disabled={rotating === machine.id}
                onClick={() => void issueAccessToken(machine)}
              >
                {rotating === machine.id ? '生成中…' : '获取接入 token'}
              </button>
              <button
                className="ghost danger"
                type="button"
                disabled={deleting === `machine-${machine.id}`}
                onClick={() => void removeMachine(machine)}
              >
                {deleting === `machine-${machine.id}` ? '删除中…' : '删除机器'}
              </button>
            </div>
          </div>
          <p className="muted">
            {machine.hostname ?? '-'} · {machine.platform ?? '-'}/{machine.arch ?? '-'} · agent{' '}
            {machine.agent_version ?? '-'} · 最后心跳 {formatRelative(machine.last_seen_at)}
          </p>
          {machine.mounts.length === 0 ? (
            <div className="muted">没有挂载点</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>挂载点</th>
                  <th>状态</th>
                  <th>覆盖率</th>
                  <th>清单版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {machine.mounts.map((mount) => (
                  <tr key={mount.id}>
                    <td>
                      <Link to={`/mounts/${mount.id}`}>{mount.label ?? mount.mount_id}</Link>
                      <div className="muted">
                        {mount.mount_id} · {mount.state}
                      </div>
                    </td>
                    <td>
                      <span className={statusClass(mount.state)}>{mount.state}</span>
                    </td>
                    <td>
                      {mount.coverage ? (
                        <>
                          <div className="bar">
                            <span style={{ width: formatRatio(mount.coverage.ratio) }} />
                          </div>
                          <span className="muted">
                            {mount.coverage.hashed}/{mount.coverage.total} ·{' '}
                            {formatRatio(mount.coverage.ratio)}
                          </span>
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>{mount.manifest_epoch}</td>
                    <td>
                      <button
                        className="ghost"
                        type="button"
                        disabled={scanning !== null}
                        onClick={() => void scanTarget('mount', 'incremental', machine, mount)}
                      >
                        {scanning === `mount-${mount.id}-incremental` ? '扫描中…' : '增量扫描'}
                      </button>{' '}
                      <button
                        className="ghost"
                        type="button"
                        disabled={scanning !== null}
                        onClick={() => void scanTarget('mount', 'full', machine, mount)}
                      >
                        {scanning === `mount-${mount.id}-full` ? '扫描中…' : '全量扫描'}
                      </button>{' '}
                      <Link to={`/files?mount_pk=${mount.id}`}>文件</Link>{' '}
                      <button
                        className="ghost danger"
                        type="button"
                        disabled={deleting === `mount-${mount.id}`}
                        onClick={() => void removeMount(machine, mount)}
                      >
                        {deleting === `mount-${mount.id}` ? '删除中…' : '删除'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
  );
}
