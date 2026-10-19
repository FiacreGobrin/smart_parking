import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export function Card({ title, subtitle, actions, children, className, padded = true }) {
  return (
    <section className={clsx('rounded-[20px] border border-line bg-surface shadow-card print-area', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, breadcrumbs }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        {breadcrumbs && (
          <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-xs text-muted">
            {breadcrumbs.map((b, i) => (
              <span key={b.label} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden />}
                {b.to ? <Link to={b.to} className="hover:text-ink hover:underline">{b.label}</Link> : <span aria-current="page">{b.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div>}
    </div>
  );
}

const TONES = {
  teal: 'bg-primary-soft text-primary',
  blue: 'bg-accent-soft text-accent',
  green: 'bg-success-soft text-success',
  amber: 'bg-warning-soft text-warning',
  red: 'bg-danger-soft text-danger',
};

export function StatCard({ label, value, hint, icon: Icon, tone = 'teal', loading, to }) {
  const body = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        {loading ? <div className="skeleton mt-2 h-8 w-24" /> : <p className="mt-1 truncate text-2xl font-semibold text-ink">{value}</p>}
        {hint && !loading && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {Icon && <span className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', TONES[tone])}><Icon className="h-5 w-5" aria-hidden /></span>}
    </div>
  );
  const cls = 'block rounded-[20px] border border-line bg-surface p-5 shadow-card transition-colors';
  return to ? <Link to={to} className={clsx(cls, 'hover:border-primary')}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={clsx('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors',
            value === t.value ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
