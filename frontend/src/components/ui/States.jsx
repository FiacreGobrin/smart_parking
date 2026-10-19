import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { Button } from './Button.jsx';

export const Skeleton = ({ className = 'h-4 w-full' }) => <div className={`skeleton ${className}`} aria-hidden />;

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}...
    </div>
  );
}

export function EmptyState({ title = 'Nothing here yet', description, action, icon: Icon = Inbox }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted"><Icon className="h-6 w-6" aria-hidden /></span>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-danger"><AlertTriangle className="h-6 w-6" aria-hidden /></span>
      <h3 className="text-sm font-semibold text-ink">Could not load this data</h3>
      <p className="max-w-md text-sm text-muted">{error?.message || 'Unexpected error'}</p>
      {error?.requestId && <p className="text-xs text-muted">Reference: {error.requestId}</p>}
      {onRetry && <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => onRetry()}>Try again</Button>}
    </div>
  );
}

/** Honest notice shown wherever a feature runs in simulation. */
export function SimulationBanner({ children }) {
  return (
    <div role="note" className="mb-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
