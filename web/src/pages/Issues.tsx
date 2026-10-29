import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  api,
  decodePath,
  formatTime,
  issueClass,
  statusClass,
  type Issue,
  type IssueDetail,
  type RepairView,
  type ReplicaResponse,
} from '../api';

const STATUSES = ['open', 'acked', 'ignored', 'resolved'] as const;
type IssueStatus = (typeof STATUSES)[number];

const LABELS: Record<IssueStatus, string> = {
  open: '待确认',
  acked: '已确认',
  ignored: '已忽略',
  resolved: '已解决',
};

const REPAIR_LABELS: Record<string, string> = {
  pending: '等待源上传',
  transferring: '源上传中',
  ready: '等待目标应用',
  applying: '目标替换中',
  completed: '修复完成',
  failed: '修复失败',
  canceled: '已取消',
};

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export default function IssuesPage() {
  const [status, setStatus] = useState<IssueStatus>('open');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [replicas, setReplicas] = useState<ReplicaResponse | null>(null);
  const [sourcePathId, setSourcePathId] = useState<number | null>(null);
  const [repair, setRepair] = useState<RepairView | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [reparing, setRepairing] = useState(false);

  const load = useCallback(() => {
    api<Issue[]>(`/api/v1/issues?status=${status}`)
      .then(setIssues)
      .catch((err: Error) => setError(err.message));
  }, [status]);

  useEffect(() => {
    setIssues(null);
    load();
  }, [load]);

  const loadDetail = useCallback(async (issueId: number) => {
    setDetail(null);
    setReplicas(null);
    setRepair(null);
    setRepairError(null);
    setSourcePathId(null);
    try {
      const [issueDetail, replicaData] = await Promise.all([
        api<IssueDetail>(`/api/v1/issues/${issueId}`),
        api<ReplicaResponse>(`/api/v1/issues/${issueId}/replicas`),
      ]);
      setDetail(issueDetail);
      setReplicas(replicaData);
      setSourcePathId(replicaData.replicas[0]?.path_id ?? null);
    } catch (err) {
      setRepairError((err as Error).message);
    }
  }, []);

  const toggleDetail = (issueId: number) => {
    if (selectedId === issueId) {
      setSelectedId(null);
      return;
    }
    setSelectedId(issueId);
    void loadDetail(issueId);
  };

  // 修复进行中时轮询状态。
  useEffect(() => {
    if (!repair || TERMINAL.has(repair.status)) return;
    const timer = setInterval(() => {
      void api<RepairView>(`/api/v1/repairs/${repair.id}`)
        .then((latest) => {
          setRepair(latest);
          if (TERMINAL.has(latest.status)) load();
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [repair, load]);

  const act = async (id: number, action: 'ack' | 'ignore') => {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/v1/issues/${id}/${action}`, { method: 'POST' });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startRepair = async () => {
    if (selectedId === null || sourcePathId === null) return;
    setRepairing(true);
    setRepairError(null);
    try {
      const created = await api<{ repair_id: number; transfer_id: number }>(
        `/api/v1/issues/${selectedId}/repair`,
        { method: 'POST', body: JSON.stringify({ source_path_id: sourcePathId }) },
      );
      setRepair(await api<RepairView>(`/api/v1/repairs/${created.repair_id}`));
    } catch (err) {
      setRepairError((err as Error).message);
    } finally {
      setRepairing(false);
    }
  };

  const cancelRepair = async () => {
    if (!repair) return;
    try {
      setRepair(await api<RepairView>(`/api/v1/repairs/${repair.id}/cancel`, { method: 'POST' }));
    } catch (err) {
      setRepairError((err as Error).message);
    }
  };

  const renderDetail = (issue: Issue) => {
    if (selectedId !== issue.id) return null;
    return (
      <tr>
        <td colSpan={7}>
          <div className="panel" style={{ margin: '4px 0' }}>
            {repairError ? <div className="error">{repairError}</div> : null}
            {detail === null ? (
              <div className="muted">加载详情…</div>
            ) : (
              <>
                <div className="toolbar">
                  <span>
                    目标：{detail.machine_id} / {detail.mount_id}
                  </span>
                  <span>
                    target_state：{detail.target_state} · size：{detail.target_size}
                  </span>
                  <span>repair_allowed：{detail.repair_allowed ? '是' : '否'}</span>
                </div>
                <p className="muted">期望哈希：{detail.expected_hash ?? '-'}</p>
                <p className="muted">观测哈希：{detail.observed_hash ?? '-'}</p>

                {repair ? (
                  <div>
                    <p>
                      修复状态：<span className={statusClass(repair.status)}>{REPAIR_LABELS[repair.status] ?? repair.status}</span>
                      {repair.error ? <span className="error"> · {repair.error}</span> : null}
                    </p>
                    <p className="muted">
                      传输：{repair.transfer.bytes_received}/{repair.transfer.size} bytes · 状态 {repair.transfer.status}
                    </p>
                    {!TERMINAL.has(repair.status) ? (
                      <button className="ghost" type="button" onClick={() => void cancelRepair()}>
                        取消修复
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <h2>健康副本</h2>
                    {replicas === null ? (
                      <div className="muted">加载副本…</div>
                    ) : replicas.replicas.length === 0 ? (
                      <div className="muted">没有找到同内容的健康副本</div>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>选择</th>
                            <th>机器</th>
                            <th>路径</th>
                            <th>大小</th>
                            <th>最近校验</th>
                            <th>置信度</th>
                          </tr>
                        </thead>
                        <tbody>
                          {replicas.replicas.map((replica) => (
                            <tr key={replica.path_id}>
                              <td>
                                <input
                                  type="radio"
                                  name="source"
                                  checked={sourcePathId === replica.path_id}
                                  onChange={() => setSourcePathId(replica.path_id)}
                                />
                              </td>
                              <td>{replica.machine_id}</td>
                              <td>{replica.path_key}</td>
                              <td>{replica.size}</td>
                              <td>{formatTime(replica.last_hashed_at)}</td>
                              <td>{replica.confidence}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="toolbar" style={{ marginTop: 8 }}>
                      <button
                        className="primary"
                        type="button"
                        disabled={
                          reparing ||
                          sourcePathId === null ||
                          !detail.repair_allowed ||
                          !replicas?.source_repairable
                        }
                        onClick={() => void startRepair()}
                      >
                        {reparing ? '修复中…' : '从副本修复'}
                      </button>
                      <span className="muted">
                        {detail.repair_allowed ? '目标允许修复' : '目标 mount 未开启 repair_allowed'}
                      </span>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <>
      <h1>异常</h1>
      <div className="toolbar">
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            className={value === status ? 'primary' : 'ghost'}
            onClick={() => setStatus(value)}
          >
            {LABELS[value]}
          </button>
        ))}
        <button className="ghost" type="button" onClick={load}>
          刷新
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="panel">
        {issues === null ? (
          <div className="muted">加载中…</div>
        ) : issues.length === 0 ? (
          <div className="muted">没有{LABELS[status]}的异常</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>文件</th>
                <th>机器 / 挂载点</th>
                <th>置信度</th>
                <th>次数</th>
                <th>最近出现</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <Fragment key={issue.id}>
                  <tr>
                    <td>
                      <span className={issueClass(issue.type)}>{issue.type}</span>
                    </td>
                    <td>
                      <div>{decodePath(issue.path_display_b64)}</div>
                      <div className="muted">{issue.path_key}</div>
                      {issue.evidence ? (
                        <details>
                          <summary className="muted">证据</summary>
                          <pre className="code">{JSON.stringify(issue.evidence, null, 2)}</pre>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      {issue.machine_id}
                      <div className="muted">{issue.mount_id}</div>
                    </td>
                    <td>{issue.confidence}</td>
                    <td>{issue.occurrences}</td>
                    <td>{formatTime(issue.last_seen_at)}</td>
                    <td>
                      <div className="toolbar" style={{ margin: 0 }}>
                        {issue.status === 'open' ? (
                          <>
                            <button
                              className="ghost"
                              type="button"
                              disabled={busy === issue.id}
                              onClick={() => act(issue.id, 'ack')}
                            >
                              确认
                            </button>
                            <button
                              className="ghost"
                              type="button"
                              disabled={busy === issue.id}
                              onClick={() => act(issue.id, 'ignore')}
                            >
                              忽略
                            </button>
                          </>
                        ) : issue.status === 'acked' ? (
                          <button
                            className="ghost"
                            type="button"
                            disabled={busy === issue.id}
                            onClick={() => act(issue.id, 'ignore')}
                          >
                            忽略
                          </button>
                        ) : (
                          <span className={statusClass(issue.status)}>{issue.status}</span>
                        )}
                        <button
                          className="ghost"
                          type="button"
                          onClick={() => toggleDetail(issue.id)}
                        >
                          {selectedId === issue.id ? '收起' : '详情 / 修复'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {renderDetail(issue)}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

