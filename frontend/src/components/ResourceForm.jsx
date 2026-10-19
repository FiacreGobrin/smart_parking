import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { get, parseError } from '../services/api.js';
import { Button } from './ui/Button.jsx';
import { Checkbox, Input, Select, Textarea } from './ui/Fields.jsx';

function useOptions(field) {
  const [options, setOptions] = useState(field.options || []);
  useEffect(() => {
    if (!field.optionsFrom) return undefined;
    let alive = true;
    const { endpoint, label = 'name', value = 'id', params } = field.optionsFrom;
    get(endpoint, { limit: 500, ...params }).then((r) => {
      if (alive) setOptions(r.data.map((x) => ({ value: x[value], label: typeof label === 'function' ? label(x) : x[label], raw: x })));
    }).catch(() => {});
    return () => { alive = false; };
  }, [field.optionsFrom?.endpoint, JSON.stringify(field.optionsFrom?.params)]); // eslint-disable-line react-hooks/exhaustive-deps
  return options;
}

function FieldControl({ field, register, error, watch }) {
  const options = useOptions(field);
  const common = { label: field.label, error, help: field.help, required: field.required, disabled: field.disabled?.(watch()) };
  if (field.show && !field.show(watch())) return null;
  switch (field.type) {
    case 'select':
      return <Select {...common} placeholder={field.required ? 'Select...' : field.placeholder ?? 'None'} options={options} {...register(field.name)} />;
    case 'checkbox':
      return <Checkbox label={field.label} help={field.help} error={error} {...register(field.name)} />;
    case 'textarea':
      return <Textarea {...common} {...register(field.name)} />;
    case 'number':
      return <Input {...common} type="number" step={field.step ?? 'any'} inputMode="decimal" {...register(field.name)} />;
    case 'datetime':
      return <Input {...common} type="datetime-local" {...register(field.name)} />;
    case 'password':
      return <Input {...common} type="password" autoComplete="new-password" {...register(field.name)} />;
    default:
      return <Input {...common} type={field.type || 'text'} placeholder={field.placeholder} {...register(field.name)} />;
  }
}

/** Form generated from a field list; validated with the supplied zod schema before it ever reaches the API. */
export function ResourceForm({ fields, schema, defaults, onSubmit, onCancel, submitLabel = 'Save', formId }) {
  const { register, handleSubmit, setError, watch, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });
  const [rootError, setRootError] = useState('');

  const submit = handleSubmit(async (values) => {
    setRootError('');
    try {
      await onSubmit(values);
    } catch (err) {
      const e = parseError(err);
      let placed = false;
      for (const [name, message] of Object.entries(e.fields)) {
        if (fields.some((f) => f.name === name)) { setError(name, { message }); placed = true; }
      }
      if (!placed || e.status !== 400) setRootError(e.message);
    }
  });

  return (
    <form id={formId} onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={f.wide || f.type === 'textarea' ? 'sm:col-span-2' : undefined}>
            <FieldControl field={f} register={register} watch={watch} error={errors[f.name]?.message} />
          </div>
        ))}
      </div>
      {rootError && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{rootError}</p>}
      {!formId && (
        <div className="flex justify-end gap-2 pt-2">
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" loading={isSubmitting}>{submitLabel}</Button>
        </div>
      )}
    </form>
  );
}
