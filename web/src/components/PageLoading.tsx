export function PageLoading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      {label}
    </div>
  );
}
