import { forwardRef, useId } from 'react';
import clsx from 'clsx';

const base = 'w-full rounded-xl border bg-surface px-3.5 text-sm text-ink placeholder:text-muted/70 transition-colors disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70';
const ring = (error) => (error ? 'border-danger' : 'border-line hover:border-muted/50');

export function Field({ label, error, help, required, children, htmlFor, className }) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={htmlFor} className="mb-1.5 block text-xs text-muted">
          {label}{required && <span className="text-danger" aria-hidden> *</span>}
        </label>
      )}
      {children}
      {help && !error && <p className="mt-1 text-xs text-muted">{help}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export const Input = forwardRef(function Input({ label, error, help, required, className, id, ...rest }, ref) {
  const auto = useId();
  const fid = id || auto;
  // Typography utilities belong on the control, not on the wrapper that also holds the label.
  const mono = /font-mono/.test(className || '');
  const wrapper = (className || '').replace(/font-mono/, '').trim() || undefined;
  return (
    <Field label={label} error={error} help={help} required={required} htmlFor={fid} className={wrapper}>
      <input ref={ref} id={fid} aria-invalid={!!error} className={clsx(base, 'h-11', ring(error), mono && 'font-mono')} {...rest} />
    </Field>
  );
});

export const Select = forwardRef(function Select({ label, error, help, required, options = [], placeholder, className, id, children, ...rest }, ref) {
  const auto = useId();
  const fid = id || auto;
  return (
    <Field label={label} error={error} help={help} required={required} htmlFor={fid} className={className}>
      <select ref={ref} id={fid} aria-invalid={!!error} className={clsx(base, 'h-11', ring(error))} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => {
          const opt = typeof o === 'string' ? { value: o, label: o } : o;
          return <option key={opt.value} value={opt.value}>{opt.label}</option>;
        })}
        {children}
      </select>
    </Field>
  );
});

export const Textarea = forwardRef(function Textarea({ label, error, help, required, className, id, ...rest }, ref) {
  const auto = useId();
  const fid = id || auto;
  return (
    <Field label={label} error={error} help={help} required={required} htmlFor={fid} className={className}>
      <textarea ref={ref} id={fid} rows={3} aria-invalid={!!error} className={clsx(base, 'py-2', ring(error))} {...rest} />
    </Field>
  );
});

export const Checkbox = forwardRef(function Checkbox({ label, help, error, className, id, ...rest }, ref) {
  const auto = useId();
  const fid = id || auto;
  return (
    <div className={className}>
      <label htmlFor={fid} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
        <input ref={ref} id={fid} type="checkbox" className="h-4 w-4 rounded border-line accent-[var(--primary)]" {...rest} />
        {label}
      </label>
      {help && <p className="mt-1 text-xs text-muted">{help}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
});
