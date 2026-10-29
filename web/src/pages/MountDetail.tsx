import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, formatRatio, formatTime, statusClass, type MountDetail } from '../api';

export default function MountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [mount, setMount] = useState<MountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api<MountDetail>(`/api/v1/mounts/${id}`)
      .then(setMount)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const trigger = async (mode: 'incremental' | 'full') => {
    if (!id) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ job_id: number }>(`/api/v1/mounts/${id}/scan`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      setMessage(`已创建任务 #${result.job_id}`);
      load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="error">{error}</div>;
  if (!mount) return <div className="muted">加载中…</div>;

  const lastJob = mount.last_job;

  return (
    <>
      <h1>
        {mount.label ?? mount.mount_id}{' '}
        <span className="muted">
          ({mount.mount_id} · {mount.machine_id ?? '-'})
        </span>
      </h1>
      <p>
        <span className={statusClass(mount.state)}>{mount.state}</span>{' '}
        <span className="muted">物理路径：{mount.physical_path}</span>
      </p>

      <div className="cards">
        <div className="card">
          <div className="label">覆盖率</div>
          <div className="value">{formatRatio(mount.coverage.ratio)}</div>
          <div className="muted">
            {mount.coverage.hashed}/{mount.coverage.total}
          </div>
        </div>
        <div className="card">
          <div className="label">清单版本</div>
          <div className="value">{mount.manifest_epoch}</div>
        </div>
        <div className="card">
          <div className="label">规则指纹</div>
          <div className="value" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {mount.rules_hash}
          </div>
        </div>
      </div>

      <h2>规则</h2>
      <div className="panel">
        <p>
          <strong>include</strong>：{mount.include.length === 0 ? '（全部）' : mount.include.join(', ')}
        </p>
        <p>
          <strong>exclude</strong>：{mount.exclude.length === 0 ? '（无）' : mount.exclude.join(', ')}
        </p>
      </div>

      <h2>调度</h2>
      <div className="panel">
        <p>
          <strong>时间窗口</strong>：{mount.schedule?.window ? mount.schedule.window : '全天'}
        </p>
        <p>
          <strong>每日预算</strong>：
          {mount.schedule && mount.schedule.budgetMinutesPerDay > 0
            ? `${mount.schedule.budgetMinutesPerDay} 分钟`
            : '不限'}
        </p>
        <p>
          <strong>巡检间隔</strong>：{mount.schedule?.intervalMinutes ?? 1440} 分钟
        </p>
        <p>
          <strong>跨机修复</strong>：{mount.repair_allowed ? '允许（作为修复目标）' : '未开启'}
        </p>
      </div>

      <h2>巡检</h2>
      <div className="panel">
        <div className="toolbar">
          <button className="primary" type="button" disabled={busy} onClick={() => trigger('incremental')}>
            增量巡检
          </button>
          <button className="ghost" type="button" disabled={busy} onClick={() => trigger('full')}>
            全量巡检
          </button>
          {message ? <span className="muted">{message}</span> : null}
        </div>
        {lastJob ? (
          <>
            <p>
              最近任务 #{lastJob.id} · {lastJob.mode} ·{' '}
              <span className={statusClass(lastJob.status)}>{lastJob.status}</span> ·{' '}
              {formatTime(lastJob.finished_at ?? lastJob.started_at ?? lastJob.created_at)}
            </p>
            {lastJob.stats ? <pre className="code">{JSON.stringify(lastJob.stats, null, 2)}</pre> : null}
          </>
        ) : (
          <div className="muted">还没有巡检任务</div>
        )}
      </div>
    </>
  );
}
