import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  decodePath,
  fileStateLabel,
  formatBytes,
  formatNs,
  formatTime,
  type FileDetail,
  type FileItem,
  type FileList,
  type Machine,
} from '../api';

interface Filters {  q: string;
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

const PAGE_SIZES = [50, 100];

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

function toSearchParams(filters: Filters): URLSearchParams {
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

function fullPath(detail: FileDetail): string {
  const base = detail.mount.physical_path.replace(/[\\/]+$/, '');
  const relative = detail.file.path_key.replace(/\//g, '\\');
  return base ? `${base}\\${relative}` : relative;
}

function stateClass(state: string): string {
  if (state === 'active') return 'badge ok';
  if (state === 'missing') return 'badge danger';
  return 'badge warn';
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // 剪贴板不可用时用户可手动选中
  }
}

export default function FilesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => readFilters(searchParams));
  const [searchInput, setSearchInput] = useState(filters.q);
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [data, setData] = useState<FileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const mountOptions = useMemo(() => {
    const machineList = machines ?? [];
    if (filters.machineId) {
      const machine = machineList.find((item) => item.machine_id === filters.machineId);
      return (machine?.mounts ?? []).map((mount) => ({ machine, mount }));
    }
    return machineList.flatMap((machine) =>
      machine.mounts.map((mount) => ({ machine, mount })),
    );
  }, [machines, filters.machineId]);

  useEffect(() => {
    api<Machine[]>('/api/v1/machines')
      .then(setMachines)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((prev) =>
        prev.q === searchInput ? prev : { ...prev, q: searchInput, page: 1 },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setSearchParams(toSearchParams(filters), { replace: true });
  }, [filters, setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = toApiParams(filters);
    api<FileList>(`/api/v1/files?${params.toString()}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    api<FileDetail>(`/api/v1/files/${selectedId}`)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setDetailError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const update = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch, page: patch.page ?? 1 }));
    setSelectedId(null);
  };

  const selectMachine = (machineId: string) => {
    update({ machineId, mountPk: '' });
  };

  const selectMount = (mountPk: string) => {
    const entry = mountOptions.find((item) => String(item.mount.id) === mountPk);
    update({
      mountPk,
      machineId: entry?.machine?.machine_id ?? filters.machineId,
    });
  };

  const exportCsv = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const params = toApiParams(filters, 5000);
      const response = await fetch(`/api/v1/files/export?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`导出失败: HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'observer-files.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(response.headers.get('x-observer-truncated') === 'true' ? '已导出前 5000 行' : '已导出 CSV');
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / filters.pageSize));
  const summary = data?.summary;
  const issues = detail?.issues ?? [];
  const observations = detail?.observations ?? [];

  return (
    <>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <h1>文件</h1>
        <div className="toolbar">
          <button className="ghost" type="button" disabled={exporting} onClick={() => void exportCsv()}>
            {exporting ? '导出中…' : '导出 CSV'}
          </button>
          <button className="ghost" type="button" onClick={() => setFilters((prev) => ({ ...prev }))}>
            刷新
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="filter-grid">
          <label>
            机器
            <select value={filters.machineId} onChange={(event) => selectMachine(event.target.value)}>
              <option value="">全部机器</option>
              {(machines ?? []).map((machine) => (
                <option key={machine.machine_id} value={machine.machine_id}>
                  {machine.label ?? machine.machine_id}
                </option>
              ))}
            </select>
          </label>
          <label>
            挂载点
            <select value={filters.mountPk} onChange={(event) => selectMount(event.target.value)}>
              <option value="">全部挂载点</option>
              {mountOptions.map(({ machine, mount }) => (
                <option key={mount.id} value={String(mount.id)}>
                  {filters.machineId
                    ? mount.label ?? mount.mount_id
                    : `${machine?.label ?? machine?.machine_id ?? '-'} / ${mount.label ?? mount.mount_id}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            搜索路径 / SHA-256
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="路径关键字；恰好 64 位 hex 时按哈希精确搜索"
            />
          </label>
          <label>
            状态
            <select value={filters.state} onChange={(event) => update({ state: event.target.value })}>
              <option value="">全部</option>
              <option value="active">正常</option>
              <option value="missing">缺失</option>
              <option value="out_of_scope">已移出规则</option>
            </select>
          </label>
          <label>
            异常
            <select value={filters.issue} onChange={(event) => update({ issue: event.target.value })}>
              <option value="">全部</option>
              <option value="open">有未处理异常</option>
              <option value="none">无未处理异常</option>
            </select>
          </label>
          <label>
            哈希
            <select value={filters.hash} onChange={(event) => update({ hash: event.target.value })}>
              <option value="">全部</option>
              <option value="hashed">已哈希</option>
              <option value="unhashed">未哈希</option>
            </select>
          </label>
          <label>
            最小字节
            <input
              type="number"
              min={0}
              value={filters.sizeMin}
              onChange={(event) => update({ sizeMin: event.target.value })}
            />
          </label>
          <label>
            最大字节
            <input
              type="number"
              min={0}
              value={filters.sizeMax}
              onChange={(event) => update({ sizeMax: event.target.value })}
            />
          </label>
          <label>
            排序
            <select value={filters.sort} onChange={(event) => update({ sort: event.target.value })}>
              <option value="path">路径</option>
              <option value="size">大小</option>
              <option value="last_seen">最后发现</option>
              <option value="last_hashed">最后哈希</option>
              <option value="state">状态</option>
            </select>
          </label>
          <label>
            顺序
            <select value={filters.order} onChange={(event) => update({ order: event.target.value })}>
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
          </label>
          <label>
            每页
            <select
              value={String(filters.pageSize)}
              onChange={(event) => update({ pageSize: Number(event.target.value) })}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={String(size)}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost"
            type="button"
            onClick={() => {
              setSearchInput('');
              setFilters({
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
              });
              setSelectedId(null);
            }}
          >
            重置
          </button>
        </div>

        {summary ? (
          <div className="toolbar chips">
            <span className="chip">共 {summary.total}</span>
            <button className="chip" type="button" onClick={() => update({ state: 'active' })}>
              正常 {summary.active}
            </button>
            <button className="chip" type="button" onClick={() => update({ state: 'missing' })}>
              缺失 {summary.missing}
            </button>
            <button className="chip" type="button" onClick={() => update({ state: 'out_of_scope' })}>
              移出规则 {summary.out_of_scope}
            </button>
            <button className="chip" type="button" onClick={() => update({ issue: 'open' })}>
              有异常 {summary.open_issue_paths}
            </button>
            <button className="chip" type="button" onClick={() => update({ hash: 'hashed' })}>
              已哈希 {summary.hashed}
            </button>
            <button className="chip" type="button" onClick={() => update({ hash: 'unhashed' })}>
              未哈希 {summary.unhashed}
            </button>
          </div>
        ) : null}

        {notice ? <div className="muted">{notice}</div> : null}
        {error ? <div className="error">{error}</div> : null}
        {loading ? <div className="muted">加载中…</div> : null}

        {!loading && data && data.items.length === 0 ? (
          <div className="muted">当前筛选没有文件；如果还没巡检过，请先对挂载点触发一次 baseline 或 full 巡检。</div>
        ) : null}

        {data && data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="files-table">
              <thead>
                <tr>
                  <th>路径</th>
                  <th>机器</th>
                  <th>挂载点</th>
                  <th>状态</th>
                  <th>大小</th>
                  <th>最后发现</th>
                  <th>最后哈希</th>
                  <th>哈希</th>
                  <th>异常</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item: FileItem) => (
                  <tr
                    key={item.id}
                    className={selectedId === item.id ? 'selected' : undefined}
                    onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}
                  >
                    <td className="file-path">{decodePath(item.path_display_b64)}</td>
                    <td>{item.machine_label ?? item.machine_id}</td>
                    <td>{item.mount_label ?? item.mount_id}</td>
                    <td>
                      <span className={stateClass(item.state)}>{fileStateLabel(item.state)}</span>
                    </td>
                    <td>{formatBytes(item.size)}</td>
                    <td>{formatTime(item.last_seen_at)}</td>
                    <td>{formatTime(item.last_hashed_at)}</td>
                    <td
                      className="file-path"
                      title={item.content_hash ?? undefined}
                    >
                      {item.content_hash ? `${item.content_hash.slice(0, 12)}…` : '-'}
                    </td>
                    <td>{item.open_issue_count > 0 ? item.open_issue_count : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="toolbar" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span className="muted">
            共 {data?.total ?? 0} 条 · 第 {filters.page}/{totalPages} 页
          </span>
          <div className="toolbar">
            <button
              className="ghost"
              type="button"
              disabled={filters.page <= 1}
              onClick={() => update({ page: filters.page - 1 })}
            >
              上一页
            </button>
            <button
              className="ghost"
              type="button"
              disabled={filters.page >= totalPages}
              onClick={() => update({ page: filters.page + 1 })}
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      {selectedId !== null ? (
        <div className="panel file-detail">
          <div className="toolbar" style={{ justifyContent: 'space-between' }}>
            <h2>文件详情</h2>
            <button className="ghost" type="button" onClick={() => setSelectedId(null)}>
              关闭
            </button>
          </div>
          {detailError ? <div className="error">{detailError}</div> : null}
          {detail === null && detailError === null ? <div className="muted">加载中…</div> : null}
          {detail ? (
            <>
              <p className="file-path">{fullPath(detail)}</p>
              <p className="muted">
                {detail.machine.machine_id} / {detail.mount.mount_id} ·{' '}
                <span className={stateClass(detail.file.state)}>{fileStateLabel(detail.file.state)}</span> ·{' '}
                {formatBytes(detail.file.size)} · mtime {formatNs(detail.file.mtime_ns)} · 最后发现{' '}
                {formatTime(detail.file.last_seen_at)} · 最后哈希 {formatTime(detail.file.last_hashed_at)}
              </p>
              <p className="muted file-path">
                SHA-256: {detail.file.content_hash ?? '-'} · last_hash_kind:{' '}
                {detail.file.last_hash_kind ?? '-'}
              </p>
              <div className="toolbar">
                <button className="ghost" type="button" onClick={() => void copyText(fullPath(detail))}>
                  复制完整路径
                </button>
                {detail.file.content_hash ? (
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => void copyText(detail.file.content_hash ?? '')}
                  >
                    复制哈希
                  </button>
                ) : null}
                <Link className="ghost" to={`/mounts/${detail.mount.id}`}>
                  挂载点详情
                </Link>
              </div>

              <h2>异常（{issues.length}）</h2>
              {issues.length === 0 ? (
                <div className="muted">无异常记录</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>状态</th>
                      <th>置信度</th>
                      <th>次数</th>
                      <th>最近</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((issue) => (
                      <tr key={issue.id}>
                        <td>{issue.type}</td>
                        <td>{issue.status}</td>
                        <td>{issue.confidence}</td>
                        <td>{issue.occurrences}</td>
                        <td>{formatTime(issue.last_seen_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h2>最近观测（{observations.length}）</h2>
              {observations.length === 0 ? (
                <div className="muted">暂无观测记录</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>哈希</th>
                      <th>类型</th>
                      <th>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observations.map((observation, index) => (
                      <tr key={`${observation.hash}-${index}`}>
                        <td className="file-path">{observation.hash}</td>
                        <td>{observation.kind}</td>
                        <td>{formatTime(observation.observed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
