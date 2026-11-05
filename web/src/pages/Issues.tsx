import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type Issue,
  type IssueDetail,
  type IssueSummary,
  type Machine,
  type ReplicaResponse,
  type RepairView,
} from '../api';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { JsonDetails, KeyValue } from '../components/KeyValue';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs } from '../components/Tabs';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { copyText } from '../lib/clipboard';
import {
  decodePath,
  formatBytes,
  formatCount,
  formatRelative,
  formatTime,
} from '../lib/format';
import { useDebouncedValue, useDocumentTitle, usePolling } from '../lib/hooks';
import {
  RESOLVE_HINT,
  confidence,
  fileState,
  isRepairTerminal,
  issueStatus,
  issueType,
  labelOf,
  repairStatus,
  transferStatus,
} from '../lib/labels';

const STATUS_TABS = [
  { key: 'open', label: '待确认' },
  { key: 'acked', label: '已确认' },
  { key: 'ignored', label: '已忽略' },
  { key: 'resolved', label: '已解决' },
] as const;

type IssueStatusKey = (typeof STATUS_TABS)[number]['key'];

function isIssueStatus(value: string | null): value is IssueStatusKey {
  return value !== null && STATUS_TABS.some((tab) => tab.key === value);
}

interface IssueDrawerProps {
  issueId: number;
  onClose: () => void;
  onChanged: () => void;
}

function IssueDrawer({ issueId, onClose, onChanged }: IssueDrawerProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [sourcePathId, setSourcePathId] = useState<number | null>(null);
  const [repairId, setRepairId] = useState<number | null>(null);
  const [repair, setRepair] = useState<RepairView | null>(null);
  const [busy, setBusy] = useState(false);
  const terminalRef = useRef(false);

  const detailState = usePolling(
    async (signal) => {
      const [detail, replicas] = await Promise.all([
        api<IssueDetail>(`/api/v1/issues/${issueId}`, { signal }),
        api<ReplicaResponse>(`/api/v1/issues/${issueId}/replicas`, { signal }),
      ]);
      return { detail, replicas };
    },
    { intervalMs: 0, deps: [issueId] },
  );

  useEffect(() => {
    setSourcePathId(null);
    setRepairId(null);
    setRepair(null);
    terminalRef.current = false;
  }, [issueId]);

  useEffect(() => {
    if (sourcePathId === null && detailState.data) {
      setSourcePathId(detailState.data.replicas.replicas[0]?.path_id ?? null);
    }
  }, [detailState.data, sourcePathId]);

  // 修复进行中时轮询；终态自动停止。
  useEffect(() => {
    if (repairId === null) {
      setRepair(null);
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const latest = await api<RepairView>(`/api/v1/repairs/${repairId}`);
        if (cancelled) return;
        setRepair(latest);
        if (!isRepairTerminal(latest.status)) {
          timer = window.setTimeout(() => void load(), 3_000);
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void load(), 5_000);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [repairId]);

  const repairTerminal = repair ? isRepairTerminal(repair.status) : false;

  useEffect(() => {
    if (!repair || !repairTerminal || repairId === null || terminalRef.current) return;
    terminalRef.current = true;
    toast.info('修复已结束', `状态：${repairStatus[repair.status]?.label ?? repair.status}`);
    onChanged();
    detailState.reload();
  }, [repair, repairTerminal, repairId, toast, onChanged, detailState]);

  const copyValue = async (value: string, label: string) => {
    const ok = await copyText(value);
    if (ok) toast.success(`已复制${label}`);
    else toast.error('复制失败', '浏览器不允许访问剪贴板，请手动选中复制。');
  };

  const startRepair = async () => {
    if (sourcePathId === null) return;
    const ok = await confirm({
      title: '从选中的健康副本修复该异常？',
      description:
        '目标端会先隔离坏文件，再原子替换为副本内容并复核哈希。传输经 hub 中转，过程中可以取消。',
      confirmText: '开始修复',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const created = await api<{ repair_id: number; transfer_id: number }>(
        `/api/v1/issues/${issueId}/repair`,
        { method: 'POST', body: JSON.stringify({ source_path_id: sourcePathId }) },
      );
      terminalRef.current = false;
      setRepairId(created.repair_id);
    } catch (err) {
      toast.error('发起修复失败', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancelRepair = async () => {
    if (!repair) return;
    const ok = await confirm({
      title: '取消这次修复？',
      description: '已上传的临时传输会被清理，目标端不会修改文件。',
      confirmText: '取消修复',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const updated = await api<RepairView>(`/api/v1/repairs/${repair.id}/cancel`, {
        method: 'POST',
      });
      setRepair(updated);
    } catch (err) {
      toast.error('取消失败', (err as Error).message);
    }
  };

  const detail = detailState.data?.detail;
  const replicas = detailState.data?.replicas;
  const transferProgress =
    repair && repair.transfer.size > 0 ? repair.transfer.bytes_received / repair.transfer.size : null;

  return (
    <Drawer
      open
      title={detail ? `${issueType[detail.type]?.label ?? detail.type} · 异常 #${detail.id}` : `异常 #${issueId}`}
      subtitle={detail ? `${detail.machine_id} / ${detail.mount_id}` : undefined}
      onClose={onClose}
      footer={
        <button className="btn" type="button" onClick={onClose}>
          关闭
        </button>
      }
    >
      {detailState.error ? <div className="alert alert-danger">{detailState.error.message}</div> : null}
      {!detailState.data && !detailState.error ? <PageLoading /> : null}

      {detail ? (
        <>
          <section>
            <div className="panel-title" style={{ marginBottom: 8 }}>
              概要
            </div>
            <KeyValue
              items={[
                { label: '类型', value: <StatusBadge value={detail.type} map={issueType} /> },
                { label: '状态', value: <StatusBadge value={detail.status} map={issueStatus} /> },
                {
                  label: '置信度',
                  value: <StatusBadge value={detail.confidence} map={confidence} dot={false} />,
                },
                {
                  label: '文件',
                  value: (
                    <Link
                      to={`/files?machine_id=${encodeURIComponent(detail.machine_id)}&q=${encodeURIComponent(detail.path_key)}`}
                    >
                      <span className="mono">{detail.path_key}</span>
                    </Link>
                  ),
                },
                { label: '目标状态', value: labelOf(fileState, detail.target_state).label },
                { label: '目标大小', value: formatBytes(detail.target_size) },
                {
                  label: '修复开关',
                  value: detail.repair_allowed
                    ? '目标挂载点允许修复'
                    : '目标挂载点未开启跨机修复（repair_allowed）',
                },
              ]}
            />
          </section>

          <section>
            <div className="panel-title" style={{ marginBottom: 8 }}>
              哈希对比
            </div>
            <KeyValue
              items={[
                {
                  label: '期望',
                  value: (
                    <div className="row">
                      <span className="mono">{detail.expected_hash ?? '—'}</span>
                      {detail.expected_hash ? (
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => void copyValue(detail.expected_hash ?? '', '期望哈希')}
                        >
                          复制
                        </button>
                      ) : null}
                    </div>
                  ),
                },
                {
                  label: '观测',
                  value: <span className="mono">{detail.observed_hash ?? '（文件缺失或不可读）'}</span>,
                },
              ]}
            />
            <JsonDetails value={detail.evidence} summary="查看证据（原始 JSON）" />
          </section>

          <section>
            <div className="panel-title" style={{ marginBottom: 8 }}>
              健康副本
            </div>
            {replicas === null || !replicas ? (
              <div className="muted">加载副本…</div>
            ) : replicas.replicas.length === 0 ? (
              <div className="alert alert-warn">
                没有找到同内容的健康副本，暂时无法修复。可以先确认或忽略这条异常。
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th scope="col">选择</th>
                        <th scope="col">机器</th>
                        <th scope="col">路径</th>
                        <th scope="col" className="num">
                          大小
                        </th>
                        <th scope="col">最近校验</th>
                        <th scope="col">置信度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {replicas.replicas.map((replica) => (
                        <tr key={replica.path_id}>
                          <td>
                            <input
                              type="radio"
                              name={`source-${issueId}`}
                              checked={sourcePathId === replica.path_id}
                              onChange={() => setSourcePathId(replica.path_id)}
                              aria-label={`选择副本 ${replica.machine_id} ${replica.path_key}`}
                            />
                          </td>
                          <td>{replica.machine_id}</td>
                          <td className="mono">{replica.path_key}</td>
                          <td className="num">{formatBytes(replica.size)}</td>
                          <td title={formatTime(replica.last_hashed_at)}>
                            {replica.last_hashed_at ? formatRelative(replica.last_hashed_at) : '—'}
                          </td>
                          <td>
                            <StatusBadge value={replica.confidence} map={confidence} dot={false} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="toolbar" style={{ marginTop: 10 }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={
                      busy ||
                      sourcePathId === null ||
                      !detail.repair_allowed ||
                      !replicas.source_repairable
                    }
                    onClick={() => void startRepair()}
                  >
                    {busy ? '提交中…' : '从副本修复'}
                  </button>
                  <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                    {!detail.repair_allowed
                      ? '目标挂载点未开启跨机修复（repair_allowed）'
                      : !replicas.source_repairable
                        ? '该异常类型不支持跨机修复'
                        : '修复过程需要源机器在线'}
                  </span>
                </div>
              </>
            )}
          </section>

          {repair ? (
            <section>
              <div className="section-title">
                <h3>修复进度</h3>
                <StatusBadge value={repair.status} map={repairStatus} />
              </div>
              <ProgressBar
                value={transferProgress}
                tone={repair.status === 'failed' ? 'danger' : repair.status === 'completed' ? 'ok' : 'info'}
                label="修复传输进度"
                showValue
              />
              <div className="muted" style={{ marginTop: 6, fontSize: 'var(--text-xs)' }}>
                传输 {formatBytes(repair.transfer.bytes_received)} / {formatBytes(repair.transfer.size)} ·{' '}
                <StatusBadge value={repair.transfer.status} map={transferStatus} dot={false} />
              </div>
              {repair.source && repair.target ? (
                <div className="muted" style={{ marginTop: 6, fontSize: 'var(--text-xs)' }}>
                  源 {repair.source.machine_id}:
                  <span className="mono">{repair.source.mount_id}/{repair.source.path_key}</span>
                  {' → '}
                  目标 {repair.target.machine_id}:
                  <span className="mono">{repair.target.mount_id}/{repair.target.path_key}</span>
                </div>
              ) : null}
              {repair.quarantine_path ? (
                <div className="muted" style={{ marginTop: 6, fontSize: 'var(--text-xs)' }}>
                  隔离路径：<span className="mono">{repair.quarantine_path}</span>
                </div>
              ) : null}
              {repair.error ? (
                <div className="alert alert-danger" style={{ marginTop: 8 }}>
                  {repair.error}
                </div>
              ) : null}
              {!repairTerminal ? (
                <div className="toolbar" style={{ marginTop: 10 }}>
                  <button className="btn btn-danger" type="button" onClick={() => void cancelRepair()}>
                    取消修复
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}

export default function IssuesPage() {
  useDocumentTitle('异常');
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();

  const statusParam = params.get('status');
  const status: IssueStatusKey = isIssueStatus(statusParam) ? statusParam : 'open';
  const type = params.get('type') ?? '';
  const machineId = params.get('machine_id') ?? '';
  const q = params.get('q') ?? '';
  const issueParam = Number(params.get('issue'));
  const selectedIssueId =
    params.get('issue') && Number.isInteger(issueParam) && issueParam > 0 ? issueParam : null;

  const [searchInput, setSearchInput] = useState(q);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const machinesState = usePolling(
    async (signal) => api<Machine[]>('/api/v1/machines', { signal }),
    { intervalMs: 0 },
  );

  const summaryState = usePolling(
    async (signal) => api<IssueSummary>('/api/v1/issues/summary', { signal }),
    { intervalMs: 15_000 },
  );

  const listState = usePolling(
    async (signal) => {
      const query = new URLSearchParams();
      query.set('status', status);
      if (type) query.set('type', type);
      if (machineId) query.set('machine_id', machineId);
      if (q) query.set('q', q);
      const items = await api<Issue[]>(`/api/v1/issues?${query.toString()}`, { signal });
      return items.filter(
        (issue) =>
          issue.status === status &&
          (!type || issue.type === type) &&
          (!machineId || issue.machine_id === machineId) &&
          (!q || issue.path_key.toLowerCase().includes(q.toLowerCase())),
      );
    },
    { intervalMs: 0, deps: [status, type, machineId, q] },
  );

  useEffect(() => {
    setSelected(new Set());
  }, [status, type, machineId, q]);

  useEffect(() => {
    if (debouncedSearch === q) return;
    const next = new URLSearchParams(params);
    if (debouncedSearch) next.set('q', debouncedSearch);
    else next.delete('q');
    next.delete('page');
    setParams(next, { replace: true });
  }, [debouncedSearch, q, params, setParams]);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  const patch = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    merged.delete('issue');
    setParams(merged, { replace: true });
  };

  const openIssue = (issueId: number) => {
    const next = new URLSearchParams(params);
    next.set('issue', String(issueId));
    setParams(next);
  };

  const closeIssue = () => {
    const next = new URLSearchParams(params);
    next.delete('issue');
    setParams(next, { replace: true });
  };

  const issues = useMemo(() => listState.data ?? [], [listState.data]);
  const selectable = issues.filter((issue) => issue.status === 'open' || issue.status === 'acked');
  const allSelected = selectable.length > 0 && selectable.every((issue) => selected.has(issue.id));

  const toggleOne = (issueId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectable.map((issue) => issue.id)));
  };

  const applyAction = async (id: number, action: 'ack' | 'ignore') => {
    setPendingId(id);
    try {
      await api(`/api/v1/issues/${id}/${action}`, { method: 'POST' });
      toast.success(action === 'ack' ? '已确认异常' : '已忽略异常');
      listState.reload();
      summaryState.reload();
    } catch (err) {
      toast.error(action === 'ack' ? '确认失败' : '忽略失败', (err as Error).message);
    } finally {
      setPendingId(null);
    }
  };

  const applyBulk = async (action: 'ack' | 'ignore') => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (action === 'ignore') {
      const ok = await confirm({
        title: `忽略选中的 ${ids.length} 条异常？`,
        description: '忽略后这些异常不再出现在待确认列表；后续巡检复核一致时会自动解决。',
        confirmText: '批量忽略',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setBulkBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) => api(`/api/v1/issues/${id}/${action}`, { method: 'POST' })),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    const succeeded = ids.length - failed;
    if (failed === 0) {
      toast.success(action === 'ack' ? `已确认 ${succeeded} 条异常` : `已忽略 ${succeeded} 条异常`);
    } else {
      toast.warn('部分异常处理失败', `成功 ${succeeded} 条，失败 ${failed} 条，请刷新后重试。`);
    }
    setSelected(new Set());
    listState.reload();
    summaryState.reload();
    setBulkBusy(false);
  };

  const summaryCounts = summaryState.data?.status;
  const tabItems = STATUS_TABS.map((tab) => ({
    ...tab,
    count: summaryCounts ? summaryCounts[tab.key] : undefined,
  }));

  return (
    <>
      <PageHeader
        title="异常"
        subtitle={
          listState.lastUpdatedAt
            ? `当前筛选 ${formatCount(issues.length)} 条 · 更新于 ${formatTime(listState.lastUpdatedAt)}`
            : '按类型、机器与路径检索异常'
        }
        actions={
          <button className="btn" type="button" onClick={() => listState.reload()}>
            刷新
          </button>
        }
      />

      <Tabs items={tabItems} value={status} onChange={(key) => patch({ status: key })} label="异常状态" />

      <div className="panel">
        <div className="filter-grid">
          <label className="field">
            <span className="field-label">类型</span>
            <select className="select" value={type} onChange={(event) => patch({ type: event.target.value })}>
              <option value="">全部类型</option>
              {Object.entries(issueType).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">机器</span>
            <select
              className="select"
              value={machineId}
              onChange={(event) => patch({ machine_id: event.target.value })}
            >
              <option value="">全部机器</option>
              {(machinesState.data ?? []).map((machine) => (
                <option key={machine.machine_id} value={machine.machine_id}>
                  {machine.label ?? machine.machine_id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">搜索路径</span>
            <input
              className="input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="路径关键字"
            />
          </label>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setSearchInput('');
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            重置筛选
          </button>
        </div>

        {status === 'resolved' ? (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            {RESOLVE_HINT}
          </div>
        ) : null}

        {selected.size > 0 ? (
          <div className="toolbar" style={{ marginTop: 12 }}>
            <span className="muted">已选 {selected.size} 条</span>
            <button
              className="btn btn-primary"
              type="button"
              disabled={bulkBusy}
              onClick={() => void applyBulk('ack')}
            >
              {bulkBusy ? '处理中…' : '批量确认'}
            </button>
            <button
              className="btn btn-danger"
              type="button"
              disabled={bulkBusy}
              onClick={() => void applyBulk('ignore')}
            >
              批量忽略
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={bulkBusy}
              onClick={() => setSelected(new Set())}
            >
              清除选择
            </button>
          </div>
        ) : null}

        {listState.error ? (
          <div className="alert alert-danger" role="alert" style={{ marginTop: 12 }}>
            加载异常失败：{listState.error.message}
          </div>
        ) : null}

        {!listState.data && !listState.error ? <PageLoading /> : null}

        {listState.data && issues.length === 0 ? (
          <EmptyState
            title={
              status === 'open'
                ? '没有待确认的异常'
                : `没有${issueStatus[status]?.label ?? status}的异常`
            }
            description={
              status === 'open'
                ? '所有文件都与基线一致。继续保持巡检即可。'
                : '换一个状态或筛选条件看看。'
            }
          />
        ) : null}

        {issues.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="全选可操作异常"
                      disabled={selectable.length === 0}
                    />
                  </th>
                  <th scope="col">类型</th>
                  <th scope="col">文件</th>
                  <th scope="col">置信度</th>
                  <th scope="col" className="num">
                    次数
                  </th>
                  <th scope="col">最近出现</th>
                  <th scope="col">状态</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => {
                  const actionable = issue.status === 'open' || issue.status === 'acked';
                  return (
                    <tr key={issue.id} className={selectedIssueId === issue.id ? 'is-selected' : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(issue.id)}
                          onChange={() => toggleOne(issue.id)}
                          disabled={!actionable}
                          aria-label={`选择异常 ${issue.id}`}
                        />
                      </td>
                      <td>
                        <StatusBadge value={issue.type} map={issueType} />
                      </td>
                      <td>
                        <Link
                          to={`/files?machine_id=${encodeURIComponent(issue.machine_id)}&q=${encodeURIComponent(issue.path_key)}`}
                        >
                          <span className="mono">{decodePath(issue.path_display_b64)}</span>
                        </Link>
                        <div className="cell-sub">
                          {issue.machine_id} / {issue.mount_id}
                        </div>
                      </td>
                      <td>
                        <StatusBadge value={issue.confidence} map={confidence} dot={false} />
                      </td>
                      <td className="num">{formatCount(issue.occurrences)}</td>
                      <td title={formatTime(issue.last_seen_at)}>
                        {formatRelative(issue.last_seen_at)}
                      </td>
                      <td>
                        <StatusBadge value={issue.status} map={issueStatus} />
                      </td>
                      <td>
                        <div className="row-actions">
                          {issue.status === 'open' ? (
                            <button
                              className="btn btn-sm"
                              type="button"
                              disabled={pendingId === issue.id}
                              onClick={() => void applyAction(issue.id, 'ack')}
                            >
                              确认
                            </button>
                          ) : null}
                          {actionable ? (
                            <button
                              className="btn btn-sm"
                              type="button"
                              disabled={pendingId === issue.id}
                              onClick={() => void applyAction(issue.id, 'ignore')}
                            >
                              忽略
                            </button>
                          ) : null}
                          <button className="btn btn-sm" type="button" onClick={() => openIssue(issue.id)}>
                            详情 / 修复
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {issues.length >= 500 ? (
          <div className="muted" style={{ marginTop: 8, fontSize: 'var(--text-xs)' }}>
            最多展示最近 500 条异常；用筛选缩小范围。
          </div>
        ) : null}
      </div>

      {selectedIssueId !== null ? (
        <IssueDrawer
          issueId={selectedIssueId}
          onClose={closeIssue}
          onChanged={() => {
            listState.reload();
            summaryState.reload();
          }}
        />
      ) : null}
    </>
  );
}
