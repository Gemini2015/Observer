import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatRatio, formatTime, statusClass, type Machine } from '../api';

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <div className="error">{error}</div>;
  if (!machines) return <div className="muted">加载中…</div>;

  return (
    <>
      <h1>机器与挂载点</h1>
      {machines.length === 0 ? <div className="muted">还没有 agent 注册</div> : null}
      {machines.map((machine) => (
        <div className="panel" key={machine.id}>
          <h2>
            {machine.label ?? machine.machine_id}{' '}
            <span className="muted">
              ({machine.machine_id} · {machine.status})
            </span>
          </h2>
          <p className="muted">
            {machine.hostname ?? '-'} · {machine.platform ?? '-'}/{machine.arch ?? '-'} · 最后心跳{' '}
            {formatTime(machine.last_seen_at)}
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
