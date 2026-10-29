import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatRatio, formatTime, statusClass, type Overview } from '../api';

interface JobStats {
  seen?: number;
  hashed?: number;
  skipped?: number;
}

export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api<Overview>('/api/v1/overview')
        .then((value) => {
          if (!cancelled) setData(value);
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">加载中…</div>;

  return (
    <>
      <h1>总览</h1>
      <div className="cards">
        <div className="card">
          <div className="label">在线机器</div>
          <div className="value">
            {data.machines.online}/{data.machines.total}
          </div>
        </div>
        <div className="card">
          <div className="label">挂载点</div>
          <div className="value">{data.mounts.total}</div>
        </div>
        <div className="card">
          <div className="label">校验覆盖率</div>
          <div className="value">{formatRatio(data.coverage.ratio)}</div>
          <div className="muted">
            {data.coverage.hashed}/{data.coverage.total} 个文件
          </div>
        </div>
        <div className="card">
          <div className="label">待确认异常</div>
          <div className="value">{data.issues.open}</div>
          <div className="muted">已确认 {data.issues.acked}</div>
        </div>
        <div className="card">
          <div className="label">任务</div>
          <div className="value">
            {data.jobs.running}/{data.jobs.pending}
          </div>
          <div className="muted">运行中 / 排队</div>
        </div>
      </div>

      <h2>最近任务</h2>
      <div className="panel">
        {data.recent_jobs.length === 0 ? (
          <div className="muted">还没有任务</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>挂载点</th>
                <th>模式</th>
                <th>状态</th>
                <th>结束时间</th>
                <th>统计</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_jobs.map((job) => {
                const stats = (job.stats as JobStats | null) ?? {};
                return (
                  <tr key={job.id}>
                    <td>{job.id}</td>
                    <td>
                      <Link to="/jobs">{job.mount_id}</Link>
                    </td>
                    <td>{job.mode}</td>
                    <td>
                      <span className={statusClass(job.status)}>{job.status}</span>
                    </td>
                    <td>{formatTime(job.finished_at ?? job.created_at)}</td>
                    <td>
                      seen {stats.seen ?? 0} · hashed {stats.hashed ?? 0} · skipped {stats.skipped ?? 0}
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
