import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { EmptyState, ErrorState, Skeleton } from './States.jsx';

/**
 * columns: [{ key, label, render?(row), sortable?, className?, align? }]
 * sort: { sortBy, order } with onSort(key)
 */
export function DataTable({ columns, rows, loading, error, onRetry, meta, onPage, sort, onSort, empty, onRowClick, rowKey = 'id', dense }) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-left text-sm">
          <thead>
            <tr className="bg-surface-2 text-xs text-muted">
              {columns.map((c) => {
                const active = sort?.sortBy === c.key;
                return (
                  <th key={c.key} scope="col" className={clsx('px-3 py-3 font-medium first:rounded-l-xl last:rounded-r-xl', c.align === 'right' && 'text-right', c.className)}
                    aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sortable && onSort ? (
                      <button onClick={() => onSort(c.key)} className="inline-flex items-center gap-1 hover:text-ink">
                        {c.label}
                        {active && (sort.order === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                      </button>
                    ) : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && !rows?.length
              ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-line">
                  {columns.map((c) => <td key={c.key} className="px-3 py-3"><Skeleton className="h-4 w-full max-w-[140px]" /></td>)}
                </tr>
              ))
              : rows?.map((row) => (
                <tr key={row[rowKey]} onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={clsx('border-b border-line last:border-0 transition-colors', onRowClick && 'cursor-pointer hover:bg-surface-2', loading && 'opacity-60')}>
                  {columns.map((c) => (
                    <td key={c.key} className={clsx('px-3', dense ? 'py-2.5' : 'py-4', c.align === 'right' && 'text-right', c.className)}>
                      {c.render ? c.render(row) : (row[c.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && !rows?.length && (empty || <EmptyState title="No records found" description="Try changing your filters or add a new record." />)}
      {meta && meta.totalPages > 0 && rows?.length > 0 && <Pagination meta={meta} onPage={onPage} />}
    </div>
  );
}

export function Pagination({ meta, onPage }) {
  const { page, totalPages, total, limit } = meta;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-xs text-muted no-print">
      <span>Showing {from}-{to} of {total}</span>
      <div className="flex items-center gap-1">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"
          className="rounded-md border border-line p-1.5 hover:bg-surface-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
        <span className="px-2">Page {page} of {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page"
          className="rounded-md border border-line p-1.5 hover:bg-surface-2 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </nav>
  );
}
