import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RepairView } from '../api';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { JsonDetails, KeyValue } from '../components/KeyValue';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import {
  formatBytes,
  formatCount,
  formatRelative,
  formatTime,
} from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';
import { isRepairTerminal, repairStatus, transferStatus } from '../lib/labels';

const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
];

function matchesFilter(repair: RepairView, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'active') return !isRepairTerminal(repair.status);
  return repair.status === filter;
}

function transferRatio(repair: RepairView): number | null {
  if (repair.transfer.size <= 0) return null;
  return repair.transfer.bytes_received / repair.transfer.size;
}

export default function RepairsPage() {
  useDocumentTitle('修复');
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);

  const state = usePolling(async (signal) => api<RepairView[]>('/api/v1/repairs', { signal }), {
    intervalMs: 5_000,
  });

  const repairs = useMemo(
    () => (state.data ?? []).filter((repair) => matchesFilter(repair, filter)),
    [state.data, filter],
  );
  const selected = state.data?.find((repair) => repair.id === selectedId) ?? null;

  const cancel = async (repair: RepairView) => {
    const ok = await confirm({
      title: `取消修复 #${repair.id}？`,
      description: '已上传的临时传输会被清理，目标端不会修改文件。',
      confirmText: '取消修复',
      tone: 'danger',
    });
    if (!ok) return;
    setCancelling(repair.id);
    try {
      await api(`/api/v1/repairs/${repair.id}/cancel`, { method: 'POST' });
      toast.success('已取消修复');
      state.reload();
    } catch (err) {
      toast.error('取消失败', (err as Error).message);
    } finally {
      setCancelling(null);
    }
  };

  return (
    <>
      <PageHeader
        title="修复"
        subtitle={
          state.lastUpdatedAt
            ? `共 ${formatCount(state.data?.length ?? 0)} 条修复记录 · 更新于 ${formatTime(state.lastUpdatedAt)}`
            : '跨机修复的传输与落地记录'
        }
        actions={
          <button className="btn" type="button" onClick={() => state.reload()}>
            刷新
          </button>
        }
      />

      <div className="panel">
        <div className="filter-grid-compact">
          <label className="field">
            <span className="field-label">状态</span>
            <select className="select" value={filter} onChange={(event) => setFilter(event.target.value)}>
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {state.error ? (
          <div className="alert alert-danger" role="alert" style={{ marginTop: 12 }}>
            加载修复记录失败：{state.error.message}
          </div>
        ) : null}

        {!state.data && !state.error ? <PageLoading /> : null}

        {state.data && repairs.length === 0 ? (
          <EmptyState
            title={filter ? '当前筛选没有修复记录' : '还没有修复记录'}
            description={
              filter
                ? '换一个状态筛选看看。'
                : '在异常详情里选择健康副本并「从副本修复」后，记录会出现在这里。'
            }
            action={
              filter ? (
                <button className="btn" type="button" onClick={() => setFilter('')}>
                  显示全部
                </button>
              ) : (
                <Link className="btn btn-primary" to="/issues?status=open">
                  去处理异常
                </Link>
              )
            }
          />
        ) : null}

        {repairs.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table table-wide">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">异常</th>
                  <th scope="col">源 → 目标</th>
                  <th scope="col">状态</th>
                  <th scope="col">进度</th>
                  <th scope="col">更新</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {repairs.map((repair) => {
                  const ratio = transferRatio(repair);
                  return (
                    <tr key={repair.id} className={selectedId === repair.id ? 'is-selected' : undefined}>
                      <td>{repair.id}</td>
                      <td>
                        <Link to={`/issues?issue=${repair.issue_id}`}>#{repair.issue_id}</Link>
                      </td>
                      <td>
                        <div className="mono">
                          {repair.source.machine_id}:{repair.source.mount_id}/{repair.source.path_key}
                        </div>
                        <div className="cell-sub mono">
                          目标 {repair.target.machine_id}:{repair.target.mount_id}/
                          {repair.target.path_key}
                        </div>
                      </td>
                      <td>
                        <StatusBadge value={repair.status} map={repairStatus} />
                      </td>
                      <td style={{ minWidth: 150 }}>
                        <ProgressBar
                          value={ratio}
                          tone={repair.status === 'failed' ? 'danger' : repair.status === 'completed' ? 'ok' : 'info'}
                          label={`修复 #${repair.id} 进度`}
                          showValue
                        />
                        <div className="cell-sub">
                          {formatBytes(repair.transfer.bytes_received)} /{' '}
                          {formatBytes(repair.transfer.size)}
                        </div>
                      </td>
                      <td title={formatTime(repair.updated_at)}>
                        {formatRelative(repair.updated_at)}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-sm" type="button" onClick={() => setSelectedId(repair.id)}>
                            详情
                          </button>
                          {!isRepairTerminal(repair.status) ? (
                            <button
                              className="btn btn-sm btn-danger"
                              type="button"
                              disabled={cancelling === repair.id}
                              onClick={() => void cancel(repair)}
                            >
                              {cancelling === repair.id ? '取消中…' : '取消'}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <Drawer
        open={selected !== null}
        title={selected ? `修复 #${selected.id}` : '修复详情'}
        subtitle={selected ? `异常 #${selected.issue_id}` : undefined}
        onClose={() => setSelectedId(null)}
        footer={
          <button className="btn" type="button" onClick={() => setSelectedId(null)}>
            关闭
          </button>
        }
      >
        {selected ? (
          <>
            <section>
              <div className="section-title">
                <h3>状态</h3>
                <StatusBadge value={selected.status} map={repairStatus} />
              </div>
              <ProgressBar
                value={transferRatio(selected)}
                tone={selected.status === 'failed' ? 'danger' : selected.status === 'completed' ? 'ok' : 'info'}
                label="修复进度"
                showValue
              />
              <div className="muted" style={{ marginTop: 6, fontSize: 'var(--text-xs)' }}>
                传输 {formatBytes(selected.transfer.bytes_received)} /{' '}
                {formatBytes(selected.transfer.size)} ·{' '}
                <StatusBadge value={selected.transfer.status} map={transferStatus} dot={false} />
              </div>
              {selected.error ? (
                <div className="alert alert-danger" style={{ marginTop: 8 }}>
                  {selected.error}
                </div>
              ) : null}
            </section>

            <section>
              <div className="panel-title" style={{ marginBottom: 8 }}>
                源与目标
              </div>
              <KeyValue
                items={[
                  {
                    label: '源',
                    value: (
                      <span className="mono">
                        {selected.source.machine_id} / {selected.source.mount_id} /{' '}
                        {selected.source.path_key}
                      </span>
                    ),
                  },
                  {
                    label: '目标',
                    value: (
                      <span className="mono">
                        {selected.target.machine_id} / {selected.target.mount_id} /{' '}
                        {selected.target.path_key}
                      </span>
                    ),
                  },
                  { label: '源大小', value: formatBytes(selected.source.size) },
                  { label: '目标大小', value: formatBytes(selected.target.size) },
                  {
                    label: '隔离路径',
                    value: selected.quarantine_path ? (
                      <span className="mono">{selected.quarantine_path}</span>
                    ) : (
                      '—'
                    ),
                  },
                ]}
              />
            </section>

            <section>
              <div className="panel-title" style={{ marginBottom: 8 }}>
                哈希与时间
              </div>
              <KeyValue
                items={[
                  { label: '期望哈希', value: <span className="mono">{selected.expected_hash}</span> },
                  {
                    label: '观测哈希',
                    value: <span className="mono">{selected.observed_hash ?? '—'}</span>,
                  },
                  { label: '创建时间', value: formatTime(selected.created_at) },
                  { label: '更新时间', value: formatTime(selected.updated_at) },
                  { label: '结束时间', value: formatTime(selected.finished_at) },
                  { label: '传输过期', value: formatTime(selected.transfer.expires_at) },
                ]}
              />
            </section>

            <JsonDetails value={selected} />
          </>
        ) : null}
      </Drawer>
    </>
  );
}
