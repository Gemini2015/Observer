import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  downloadFile,
  type FileDetail,
  type FileItem,
  type FileList,
  type Machine,
} from '../api';
import { EmptyState } from '../components/EmptyState';
import { Drawer } from '../components/Drawer';
import { JsonDetails, KeyValue } from '../components/KeyValue';
import { Pagination } from '../components/Pagination';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { copyText } from '../lib/clipboard';
import {
  decodePath,
  formatBytes,
  formatCount,
  formatNs,
  formatRelative,
  formatTime,
  joinMountPath,
  shortHash,
} from '../lib/format';
import { useDebouncedValue, useDocumentTitle, usePolling } from '../lib/hooks';
import { confidence, fileState, hashKind, issueStatus, issueType, labelOf, observationKind } from '../lib/labels';

interface Filters {
  q: string;
  machineId: string;
  mountPk: string;
  state: string;
  issue: string;
  hash: string;
  sizeMin: string;
  sizeMax: string;
  sort: string;
  order: string;
  page: number;
  pageSize: number;
}

const PAGE_SIZES = [25, 50, 100];
const SORT_OPTIONS = [
  { value: 'path', label: '路径' },
  { value: 'size', label: '大小' },
  { value: 'last_seen', label: '最后发现' },
  { value: 'last_hashed', label: '最后哈希' },
  { value: 'state', label: '状态' },
];

const DEFAULT_FILTERS: Filters = {
  q: '',
  machineId: '',
  mountPk: '',
  state: '',
  issue: '',
  hash: '',
  sizeMin: '',
  sizeMax: '',
  sort: 'path',
  order: 'asc',
  page: 1,
  pageSize: 50,
};

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page') ?? '1');
  const pageSize = Number(params.get('page_size') ?? '50');
  return {
    q: params.get('q') ?? '',
    machineId: params.get('machine_id') ?? '',
    mountPk: params.get('mount_pk') ?? '',
    state: params.get('state') ?? '',
    issue: params.get('issue') ?? '',
    hash: params.get('hash') ?? '',
    sizeMin: params.get('size_min') ?? '',
    sizeMax: params.get('size_max') ?? '',
    sort: params.get('sort') ?? 'path',
    order: params.get('order') ?? 'asc',
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
}

function toParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.machineId) params.set('machine_id', filters.machineId);
  if (filters.mountPk) params.set('mount_pk', filters.mountPk);
  if (filters.state) params.set('state', filters.state);
  if (filters.issue) params.set('issue', filters.issue);
  if (filters.hash) params.set('hash', filters.hash);
  if (filters.sizeMin) params.set('size_min', filters.sizeMin);
  if (filters.sizeMax) params.set('size_max', filters.sizeMax);
  if (filters.sort !== 'path') params.set('sort', filters.sort);
  if (filters.order !== 'asc') params.set('order', filters.order);
  if (filters.page > 1) params.set('page', String(filters.page));
  if (filters.pageSize !== 50) params.set('page_size', String(filters.pageSize));
  return params;
}

function toApiParams(filters: Filters, overrideLimit?: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.machineId) params.set('machine_id', filters.machineId);
  if (filters.mountPk) params.set('mount_pk', filters.mountPk);
  if (filters.state) params.set('state', filters.state);
  if (filters.issue) params.set('issue', filters.issue);
  if (filters.hash) params.set('hash', filters.hash);
  if (filters.sizeMin) params.set('size_min', filters.sizeMin);
  if (filters.sizeMax) params.set('size_max', filters.sizeMax);
  params.set('sort', filters.sort);
  params.set('order', filters.order);
  params.set('limit', String(overrideLimit ?? filters.pageSize));
  params.set('offset', overrideLimit ? '0' : String((filters.page - 1) * filters.pageSize));
  return params;
}

function hasActiveFilters(filters: Filters): boolean {
  return Boolean(
    filters.q ||
      filters.machineId ||
      filters.mountPk ||
      filters.state ||
      filters.issue ||
      filters.hash ||
      filters.sizeMin ||
      filters.sizeMax,
  );
}

function FileDetailDrawer({
  detail,
  error,
  onClose,
}: {
  detail: FileDetail | null;
  error: Error | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const copyValue = async (value: string, label: string) => {
    const ok = await copyText(value);
    if (ok) toast.success(`已复制${label}`);
    else toast.error('复制失败', '浏览器不允许访问剪贴板，请手动选中复制。');
  };

  const file = detail?.file;
  const fullPath = detail && file ? joinMountPath(detail.machine.platform, detail.mount.physical_path, file.path_key) : '';

  return (
    <Drawer
      open
      title={file ? decodePath(file.path_display_b64) : '文件详情'}
      subtitle={detail ? `${detail.machine.machine_id} / ${detail.mount.mount_id}` : undefined}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            关闭
          </button>
          {fullPath ? (
            <button className="btn btn-primary" type="button" onClick={() => void copyValue(fullPath, '完整路径')}>
              复制完整路径
            </button>
          ) : null}
        </>
      }
    >
      {error ? <div className="alert alert-danger">{error.message}</div> : null}
      {!detail && !error ? <PageLoading /> : null}
      {detail && file ? (
        <>
          <section>
            <div className="panel-title" style={{ marginBottom: 8 }}>
              位置
            </div>
            <KeyValue
              items={[
                {
                  label: '完整路径',
                  value: (
                    <div className="row">
                      <span className="mono">{fullPath}</span>
                      <button
                        className="btn btn-sm"
                        type="button"
                        onClick={() => void copyValue(fullPath, '完整路径')}
                      >
                        复制
                      </button>
                    </div>
                  ),
                },
                {
                  label: '相对路径',
                  value: <span className="mono">{file.path_key}</span>,
                },
                { label: '机器', value: <Link to="/machines">{detail.machine.machine_id}</Link> },
                { label: '挂载点', value: <Link to={`/mounts/${detail.mount.id}`}>{detail.mount.label ?? detail.mount.mount_id}</Link> },
              ]}
            />
          </section>

          <section>
            <div className="panel-title" style={{ marginBottom: 8 }}>
              状态
            </div>
            <KeyValue
              items={[
                { label: '文件状态', value: <StatusBadge value={file.state} map={fileState} /> },
                { label: '大小', value: formatBytes(file.size) },
                { label: 'mtime', value: formatNs(file.mtime_ns) },
                { label: '最后发现', value: formatTime(file.last_seen_at) },
                { label: '最后哈希', value: formatTime(file.last_hashed_at) },
                {
                  label: '哈希类型',
                  value: file.last_hash_kind ? (
                    <StatusBadge value={file.last_hash_kind} map={hashKind} dot={false} />
                  ) : (
                    '—'
                  ),
                },
              ]}
            />
          </section>

          <section>
            <div className="section-title">
              <h3>SHA-256</h3>
              {file.content_hash ? (
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => void copyValue(file.content_hash ?? '', '哈希')}
                >
                  复制哈希
                </button>
              ) : null}
            </div>
            <div className="mono">{file.content_hash ?? '尚未计算哈希'}</div>
          </section>

          <section>
            <div className="section-title">
              <h3>异常（{detail.issues.length}）</h3>
              <Link
                className="btn btn-sm"
                to={`/issues?machine_id=${encodeURIComponent(detail.machine.machine_id)}&q=${encodeURIComponent(file.path_key)}`}
              >
                在异常页查看
              </Link>
            </div>
            {detail.issues.length === 0 ? (
              <div className="muted">没有异常记录。</div>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th scope="col">类型</th>
                      <th scope="col">状态</th>
                      <th scope="col">置信度</th>
                      <th scope="col" className="num">
                        次数
                      </th>
                      <th scope="col">最近</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.issues.map((issue) => (
                      <tr key={issue.id}>
                        <td>
                          <StatusBadge value={issue.type} map={issueType} />
                        </td>
                        <td>
                          <StatusBadge value={issue.status} map={issueStatus} />
                        </td>
                        <td>
                          <StatusBadge value={issue.confidence} map={confidence} dot={false} />
                        </td>
                        <td className="num">{formatCount(issue.occurrences)}</td>
                        <td title={formatTime(issue.last_seen_at)}>
                          {formatRelative(issue.last_seen_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {detail.issues.some((issue) => issue.evidence) ? (
              <JsonDetails
                value={detail.issues.map((issue) => ({ id: issue.id, evidence: issue.evidence }))}
                summary="查看异常证据（原始 JSON）"
              />
            ) : null}
          </section>

          <section>
            <div className="panel-title" style={{ marginBottom: 8 }}>
              最近观测（{detail.observations.length}）
            </div>
            {detail.observations.length === 0 ? (
              <div className="muted">暂无观测记录。</div>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th scope="col">哈希</th>
                      <th scope="col">类型</th>
                      <th scope="col">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.observations.map((observation, index) => (
                      <tr key={`${observation.hash}-${index}`}>
                        <td className="mono" title={observation.hash}>
                          {shortHash(observation.hash, 16)}
                        </td>
                        <td>{labelOf(observationKind, observation.kind).label}</td>
                        <td>{formatTime(observation.observed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </Drawer>
  );
}

export default function FilesPage() {
  useDocumentTitle('文件');
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const filters = useMemo(() => readFilters(params), [params]);
  const selectedId = useMemo(() => {
    const raw = params.get('file');
    const value = Number(raw);
    return raw && Number.isInteger(value) && value > 0 ? value : null;
  }, [params]);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [exporting, setExporting] = useState(false);
  const debouncedSearch = useDebouncedValue(searchInput, 300);

  const { data: machines } = usePolling(
    async (signal) => api<Machine[]>('/api/v1/machines', { signal }),
    { intervalMs: 0 },
  );

  const apiParams = toApiParams(filters).toString();
  const sizeRangeInvalid =
    filters.sizeMin !== '' &&
    filters.sizeMax !== '' &&
    Number(filters.sizeMin) > Number(filters.sizeMax);
  const list = usePolling(
    async (signal) => api<FileList>(`/api/v1/files?${apiParams}`, { signal }),
    { intervalMs: 0, deps: [apiParams], enabled: !sizeRangeInvalid },
  );

  const detail = usePolling(
    async (signal) => {
      if (selectedId === null) throw new Error('没有选中的文件');
      return api<FileDetail>(`/api/v1/files/${selectedId}`, { signal });
    },
    { enabled: selectedId !== null, intervalMs: 0, deps: [selectedId] },
  );

  // URL 是唯一数据源：输入框防抖后写回 URL。
  useEffect(() => {
    if (debouncedSearch === filters.q) return;
    const next = { ...filters, q: debouncedSearch, page: 1 };
    setParams(toParams(next), { replace: true });
  }, [debouncedSearch, filters, setParams]);

  // 外部链接修改筛选条件时，同步搜索框。
  useEffect(() => {
    setSearchInput(filters.q);
  }, [filters.q]);

  const applyFilters = (patch: Partial<Filters>) => {
    const next: Filters = { ...filters, ...patch };
    if (patch.page === undefined) next.page = 1;
    setParams(toParams(next), { replace: true });
  };

  const openFile = (fileId: number) => {
    const next = new URLSearchParams(params);
    next.set('file', String(fileId));
    setParams(next);
  };

  const closeFile = () => {
    const next = new URLSearchParams(params);
    next.delete('file');
    setParams(next, { replace: true });
  };

  const resetFilters = () => {
    setSearchInput('');
    setParams(new URLSearchParams(), { replace: true });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { truncated } = await downloadFile(
        `/api/v1/files/export?${toApiParams(filters, 5000).toString()}`,
        'observer-files.csv',
      );
      toast.success('已导出 CSV', truncated ? '数据超过 5000 行，只导出了前 5000 行。' : undefined);
    } catch (err) {
      toast.error('导出失败', (err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const mountOptions = useMemo(() => {
    const machineList = machines ?? [];
    if (filters.machineId) {
      const machine = machineList.find((item) => item.machine_id === filters.machineId);
      return (machine?.mounts ?? []).map((mount) => ({ machine, mount }));
    }
    return machineList.flatMap((machine) => machine.mounts.map((mount) => ({ machine, mount })));
  }, [machines, filters.machineId]);

  const summary = list.data?.summary;
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const items: FileItem[] = list.data?.items ?? [];
  const activeFilters = hasActiveFilters(filters);
  const selectedDetail = detail.data && detail.data.file.id === selectedId ? detail.data : null;

  return (
    <>
      <PageHeader
        title="文件"
        subtitle={
          list.lastUpdatedAt
            ? `共 ${formatCount(total)} 条 · 更新于 ${formatTime(list.lastUpdatedAt)}`
            : '按机器、挂载点、状态与哈希检索已入库文件'
        }
        actions={
          <>
            <button
              className="btn"
              type="button"
              disabled={exporting}
              onClick={() => void exportCsv()}
            >
              {exporting ? '导出中…' : '导出 CSV'}
            </button>
            <button className="btn" type="button" onClick={() => list.reload()}>
              刷新
            </button>
          </>
        }
      />

      <div className="panel">
        <div className="filter-grid">
          <label className="field">
            <span className="field-label">机器</span>
            <select
              className="select"
              value={filters.machineId}
              onChange={(event) => applyFilters({ machineId: event.target.value, mountPk: '' })}
            >
              <option value="">全部机器</option>
              {(machines ?? []).map((machine) => (
                <option key={machine.machine_id} value={machine.machine_id}>
                  {machine.label ?? machine.machine_id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">挂载点</span>
            <select
              className="select"
              value={filters.mountPk}
              onChange={(event) => {
                const entry = mountOptions.find((item) => String(item.mount.id) === event.target.value);
                applyFilters({
                  mountPk: event.target.value,
                  machineId: entry?.machine?.machine_id ?? filters.machineId,
                });
              }}
            >
              <option value="">全部挂载点</option>
              {mountOptions.map(({ machine, mount }) => (
                <option key={mount.id} value={String(mount.id)}>
                  {filters.machineId
                    ? mount.label ?? mount.mount_id
                    : `${machine?.label ?? machine?.machine_id ?? '—'} / ${mount.label ?? mount.mount_id}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">搜索路径 / SHA-256</span>
            <input
              className="input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="路径关键字；64 位十六进制按哈希精确搜索"
            />
          </label>
          <label className="field">
            <span className="field-label">状态</span>
            <select
              className="select"
              value={filters.state}
              onChange={(event) => applyFilters({ state: event.target.value })}
            >
              <option value="">全部</option>
              <option value="active">正常</option>
              <option value="missing">缺失</option>
              <option value="out_of_scope">已移出规则</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">异常</span>
            <select
              className="select"
              value={filters.issue}
              onChange={(event) => applyFilters({ issue: event.target.value })}
            >
              <option value="">全部</option>
              <option value="open">有未处理异常</option>
              <option value="none">无未处理异常</option>
            </select>
          </label>
        </div>

        <details className="filters-more">
          <summary className="muted" style={{ fontSize: 'var(--text-xs)', cursor: 'pointer' }}>
            更多筛选
          </summary>
          <div className="filter-grid" style={{ marginTop: 10 }}>
            <label className="field">
              <span className="field-label">哈希</span>
              <select
                className="select"
                value={filters.hash}
                onChange={(event) => applyFilters({ hash: event.target.value })}
              >
                <option value="">全部</option>
                <option value="hashed">已哈希</option>
                <option value="unhashed">未哈希</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">最小字节</span>
              <input
                className="input"
                type="number"
                min={0}
                value={filters.sizeMin}
                onChange={(event) => applyFilters({ sizeMin: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">最大字节（最小字节需 ≤ 最大字节）</span>
              <input
                className="input"
                type="number"
                min={0}
                value={filters.sizeMax}
                onChange={(event) => applyFilters({ sizeMax: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">排序</span>
              <select
                className="select"
                value={filters.sort}
                onChange={(event) => applyFilters({ sort: event.target.value })}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">顺序</span>
              <select
                className="select"
                value={filters.order}
                onChange={(event) => applyFilters({ order: event.target.value })}
              >
                <option value="asc">升序</option>
                <option value="desc">降序</option>
              </select>
            </label>
            <button className="btn" type="button" onClick={resetFilters}>
              重置全部
            </button>
          </div>
        </details>

        {summary ? (
          <div className="chips" style={{ marginTop: 12 }}>
            <span className="chip chip-static">共 {formatCount(summary.total)}</span>
            <button
              className={`chip${filters.state === 'active' ? ' active' : ''}`}
              type="button"
              onClick={() => applyFilters({ state: filters.state === 'active' ? '' : 'active' })}
            >
              正常 {formatCount(summary.active)}
            </button>
            <button
              className={`chip${filters.state === 'missing' ? ' active' : ''}`}
              type="button"
              onClick={() => applyFilters({ state: filters.state === 'missing' ? '' : 'missing' })}
            >
              缺失 {formatCount(summary.missing)}
            </button>
            <button
              className={`chip${filters.state === 'out_of_scope' ? ' active' : ''}`}
              type="button"
              onClick={() =>
                applyFilters({ state: filters.state === 'out_of_scope' ? '' : 'out_of_scope' })
              }
            >
              移出规则 {formatCount(summary.out_of_scope)}
            </button>
            <button
              className={`chip${filters.issue === 'open' ? ' active' : ''}`}
              type="button"
              onClick={() => applyFilters({ issue: filters.issue === 'open' ? '' : 'open' })}
            >
              有异常 {formatCount(summary.open_issue_paths)}
            </button>
            <button
              className={`chip${filters.hash === 'hashed' ? ' active' : ''}`}
              type="button"
              onClick={() => applyFilters({ hash: filters.hash === 'hashed' ? '' : 'hashed' })}
            >
              已哈希 {formatCount(summary.hashed)}
            </button>
            <button
              className={`chip${filters.hash === 'unhashed' ? ' active' : ''}`}
              type="button"
              onClick={() => applyFilters({ hash: filters.hash === 'unhashed' ? '' : 'unhashed' })}
            >
              未哈希 {formatCount(summary.unhashed)}
            </button>
            {activeFilters ? (
              <button className="chip" type="button" onClick={resetFilters}>
                清除筛选
              </button>
            ) : null}
          </div>
        ) : null}

        {sizeRangeInvalid ? (
          <div className="alert alert-warn" role="alert" style={{ marginTop: 12 }}>
            最小字节大于最大字节，已暂停查询。请调整大小范围。
          </div>
        ) : null}

        {list.error ? (
          <div className="alert alert-danger" role="alert" style={{ marginTop: 12 }}>
            加载文件列表失败：{list.error.message}
          </div>
        ) : null}

        {!list.data && !list.error ? <PageLoading /> : null}

        {list.data && items.length === 0 ? (
          <EmptyState
            title={activeFilters ? '当前筛选没有文件' : '还没有入库文件'}
            description={
              activeFilters
                ? '换一组筛选条件，或清除筛选后重试。'
                : '先对挂载点执行一次全量巡检，文件元数据入库后会出现在这里。'
            }
            action={
              activeFilters ? (
                <button className="btn" type="button" onClick={resetFilters}>
                  清除筛选
                </button>
              ) : (
                <Link className="btn btn-primary" to="/machines">
                  去机器页发起巡检
                </Link>
              )
            }
          />
        ) : null}

        {items.length > 0 ? (
          <>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table table-wide">
                <thead>
                  <tr>
                    <th scope="col">路径</th>
                    <th scope="col">位置</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="num">
                      大小
                    </th>
                    <th scope="col">最近活动</th>
                    <th scope="col" className="num">
                      异常
                    </th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      className={selectedId === item.id ? 'is-selected' : undefined}
                      style={{ cursor: 'pointer' }}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest('a,button')) return;
                        openFile(item.id);
                      }}
                    >
                      <td>
                        <div className="mono">{decodePath(item.path_display_b64)}</div>
                        <div className="cell-sub" title={item.content_hash ?? undefined}>
                          SHA-256 {shortHash(item.content_hash, 12)}
                        </div>
                      </td>
                      <td>
                        {item.machine_label ?? item.machine_id}
                        <div className="cell-sub">{item.mount_label ?? item.mount_id}</div>
                      </td>
                      <td>
                        <StatusBadge value={item.state} map={fileState} />
                      </td>
                      <td className="num">{formatBytes(item.size)}</td>
                      <td title={formatTime(item.last_seen_at)}>
                        {formatRelative(item.last_seen_at)}
                        <div className="cell-sub">
                          {item.last_hashed_at
                            ? `校验于 ${formatRelative(item.last_hashed_at)}`
                            : '尚未校验'}
                        </div>
                      </td>
                      <td className="num">
                        {item.open_issue_count > 0 ? (
                          <Link
                            to={`/issues?machine_id=${encodeURIComponent(item.machine_id)}&q=${encodeURIComponent(item.path_key)}`}
                          >
                            {item.open_issue_count}
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => openFile(item.id)}
                          aria-label={`查看 ${item.path_key} 的详情`}
                        >
                          详情
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={filters.page}
              totalPages={totalPages}
              total={total}
              pageSize={filters.pageSize}
              pageSizes={PAGE_SIZES}
              itemLabel="个文件"
              onPage={(page) => applyFilters({ page })}
              onPageSize={(pageSize) => applyFilters({ pageSize })}
            />
          </>
        ) : null}
      </div>

      {selectedId !== null ? (
        <FileDetailDrawer
          detail={selectedDetail}
          error={selectedDetail ? null : detail.error}
          onClose={closeFile}
        />
      ) : null}
    </>
  );
}
