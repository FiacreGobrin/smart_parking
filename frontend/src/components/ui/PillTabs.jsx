import clsx from 'clsx';

/** Rounded filter pills from the Users screen: "All (128)  Pending (9)  Active (112)  Blocked (7)". */
export function PillTabs({ tabs, value, onChange, label = 'Filter' }) {
  return (
    <div role="tablist" aria-label={label} className="mb-5 flex flex-wrap gap-2">
      {tabs.map((t) => {
        const active = value === t.value;
        return (
          <button key={t.value} role="tab" aria-selected={active} onClick={() => onChange(t.value)}
            className={clsx('rounded-full border px-5 py-2 text-sm font-semibold transition-colors',
              active ? 'border-primary bg-primary text-white' : 'border-line bg-surface text-ink hover:bg-surface-2')}>
            {t.label}{t.count != null && ` (${t.count})`}
          </button>
        );
      })}
    </div>
  );
}

/** Blue text links used for row actions ("Approve  Edit  Delete"). */
export function LinkAction({ children, danger, ...rest }) {
  return (
    <button type="button" {...rest} className={clsx('text-sm font-semibold hover:underline', danger ? 'text-danger' : 'text-primary')}>
      {children}
    </button>
  );
}
