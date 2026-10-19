import clsx from 'clsx';
import { titleCase } from '../../utils/format.js';

const TONE = {
  green: 'bg-success-soft text-success',
  red: 'bg-danger-soft text-danger',
  amber: 'bg-warning-soft text-warning',
  blue: 'bg-accent-soft text-accent',
  teal: 'bg-primary-soft text-primary',
  gray: 'bg-surface-2 text-muted border border-line',
};

// One place to decide which colour every status in the system gets.
const STATUS_TONE = {
  AVAILABLE: 'green', ONLINE: 'green', ACTIVE: 'green', SUCCESS: 'green', COMPLETED: 'green', CONFIRMED: 'green', RECOGNIZED: 'green', GRANTED: 'green', ACKNOWLEDGED: 'green', AUTHORIZED: 'teal', REGISTERED: 'gray',
  OCCUPIED: 'blue', CHECKED_IN: 'blue', CORRECTED: 'blue', INFO: 'blue',
  RESERVED: 'amber', PENDING: 'amber', BLOCKED: 'red', PENDING_CONFIRMATION: 'amber', MAINTENANCE: 'amber', WARNING: 'amber', SUSPENDED: 'amber', DUPLICATE: 'gray',
  OUT_OF_SERVICE: 'red', OFFLINE: 'red', ERROR: 'red', FAILED: 'red', DENIED: 'red', RESTRICTED: 'red', CANCELLED: 'gray', EXPIRED: 'gray', NO_SHOW: 'red', REFUNDED: 'amber', CRITICAL: 'red',
};

export function StatusBadge({ status, className }) {
  if (!status) return null;
  return (
    <span className={clsx('inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold', TONE[STATUS_TONE[status] || 'gray'], className)}>
      {titleCase(status)}
    </span>
  );
}

export function Badge({ tone = 'gray', children, className }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', TONE[tone], className)}>{children}</span>;
}

/** Clear label for anything that is not real: simulated cameras, payments, gate actions. */
export function SimulatedBadge({ className }) {
  return <Badge tone="amber" className={clsx('uppercase tracking-wide', className)}>Simulated</Badge>;
}
