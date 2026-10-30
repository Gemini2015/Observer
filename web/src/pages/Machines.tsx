import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  formatRatio,
  formatRelative,
  formatTime,
  statusClass,
  type EnrollTokenResult,
  type Machine,
  type MountRef,
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
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
    try {
      await navigator.clipboard.writeText(issued.token);
    } catch {
      // 剪贴板不可用时用户可手动选中复制
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
        <button className="primary" type="button" onClick={() => setShowTokenForm((value) => !value)}>
          {showTokenForm ? '收起' : '注册新机器'}
        </button>
      </div>

      {showTokenForm ? (
        <div className="panel">
          <h2>生成注册 token</h2>
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
            <button
              className="ghost danger"
              type="button"
              disabled={deleting === `machine-${machine.id}`}
              onClick={() => void removeMachine(machine)}
            >
              {deleting === `machine-${machine.id}` ? '删除中…' : '删除机器'}
            </button>
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
