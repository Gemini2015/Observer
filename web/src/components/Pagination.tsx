import { formatCount } from '../lib/format';

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
  pageSizes,
  onPageSize,
  itemLabel = '条',
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize?: number;
  onPage: (page: number) => void;
  pageSizes?: number[];
  onPageSize?: (size: number) => void;
  itemLabel?: string;
}) {
  const safeTotalPages = Math.max(1, totalPages);
  return (
    <div className="pagination">
      <span>
        共 {formatCount(total)} {itemLabel} · 第 {page}/{safeTotalPages} 页
      </span>
      <div className="pagination-actions">
        {pageSizes && onPageSize && pageSize ? (
          <label className="row">
            <span>每页</span>
            <select
              className="select"
              style={{ width: 84 }}
              value={String(pageSize)}
              onChange={(event) => onPageSize(Number(event.target.value))}
              aria-label="每页条数"
            >
              {pageSizes.map((size) => (
                <option key={size} value={String(size)}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className="btn btn-sm"
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <button
          className="btn btn-sm"
          type="button"
          disabled={page >= safeTotalPages}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
