import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

const VARIANTS = {
  primary: 'bg-primary text-primary-ink hover:bg-primary-hover',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
  danger: 'bg-danger text-white hover:opacity-90',
  soft: 'bg-primary-soft text-primary hover:opacity-80',
  success: 'bg-success-solid text-white hover:bg-success-solid-hover',
  dangerOutline: 'border border-danger text-danger bg-surface hover:bg-danger-soft',
  outline: 'border border-line text-ink bg-surface hover:bg-surface-2',
};
const SIZES = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-sm' };

export function Button({ variant = 'primary', size = 'md', loading, icon: Icon, className, children, disabled, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant], SIZES[size], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx('inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink', className)}
      {...rest}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}
