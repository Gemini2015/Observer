import { useCallback, useEffect, useState } from 'react';
import { api, formatTime, statusClass, type Job } from '../api';

interface JobStats {
  seen?: number;
  hashed?: number;
  skipped?: number;
  bytes_read?: number;
  duration_ms?: number;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Job[]>('/api/v1/jobs?limit=50')
      .then(setJobs)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <div className="error">{error}</div>;
  if (!jobs) return <div className="muted">加载中…</div>;

  return (
    <>
      <h1>任务</h1>
      <div className="toolbar">
        <button className="ghost" type="button" onClick={load}>
          刷新
        </button>
        <span className="muted">每 5 秒自动刷新</span>
      </div>
      <div className="panel">
        {jobs.length === 0 ? (
          <div className="muted">还没有任务</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>机器</th>
                <th>挂载点</th>
                <th>模式</th>
                <th>状态</th>
                <th>创建</th>
                <th>结束</th>
                <th>统计</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const stats = (job.stats as JobStats | null) ?? {};
                return (
                  <tr key={job.id}>
                    <td>{job.id}</td>
                    <td>{job.machine_id}</td>
                    <td>{job.mount_id}</td>
                    <td>{job.mode}</td>
                    <td>
                      <span className={statusClass(job.status)}>{job.status}</span>
                      {job.attempt > 0 ? <span className="muted"> · 重试 {job.attempt}</span> : null}
                    </td>
                    <td>{formatTime(job.created_at)}</td>
                    <td>{formatTime(job.finished_at)}</td>
                    <td className="muted">
                      seen {stats.seen ?? 0} · hashed {stats.hashed ?? 0} · skipped {stats.skipped ?? 0}
                      {stats.duration_ms ? ` · ${stats.duration_ms}ms` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
