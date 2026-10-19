import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../components/ui/Button.jsx';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { StatusBadge } from '../components/ui/Badge.jsx';
import { Input, Select } from '../components/ui/Fields.jsx';
import { LinkAction } from '../components/ui/PillTabs.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { del, get, parseError, patch, post } from '../services/api.js';
import { num, titleCase } from '../utils/format.js';
import { zNum, zOptNum } from '../utils/zod.js';

const SERVICES = [{ value: 'PARKING', label: 'Parking' }, { value: 'GARAGE', label: 'Garage' }, { value: 'CAR_WASH', label: 'Car Wash' }];
const VEHICLES = [{ value: 'CAR', label: 'Car' }, { value: 'MOTORCYCLE', label: 'Motorbike' }, { value: 'BUS', label: 'Bus' }, { value: 'TRUCK', label: 'Truck' }];
// Parking is billed per hour, garage per day/week/month, car wash per visit.
const UNITS_BY_SERVICE = {
  PARKING: [{ value: 'HOUR', label: 'Per hour' }],
  GARAGE: [{ value: 'DAY', label: 'Per day' }, { value: 'WEEK', label: 'Per week' }, { value: 'MONTH', label: 'Per month' }],
  CAR_WASH: [{ value: 'VISIT', label: 'Per visit' }],
};
const UNIT_LABEL = { HOUR: 'Hour', DAY: 'Day', WEEK: 'Week', MONTH: 'Month', VISIT: 'Visit' };
const SERVICE_LABEL = Object.fromEntries(SERVICES.map((s) => [s.value, s.label]));
const VEHICLE_LABEL = Object.fromEntries(VEHICLES.map((v) => [v.value, v.label]));
const PREVIEW_STAYS = { HOUR: 195, DAY: 2 * 1440 + 60, WEEK: 8 * 1440, MONTH: 40 * 1440, VISIT: 45 }; // example durations: 3h15, 3 days, 2 weeks, 2 months, one visit
const PREVIEW_TEXT = { HOUR: '3h 15m', DAY: '2 days 1h', WEEK: '8 days', MONTH: '40 days', VISIT: 'one visit' };
const UNIT_NOUN = { HOUR: 'hours', DAY: 'days', WEEK: 'weeks', MONTH: 'months', VISIT: 'visit' };

const schema = z.object({
  service: z.enum(['PARKING', 'GARAGE', 'CAR_WASH']),
  vehicleType: z.string().min(1, 'Choose a vehicle type'),
  unit: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'VISIT']),
  startPrice: zNum('Start price', { min: 100 }),
  increment: zNum('Increase', { min: 0 }),
  cap: zOptNum('Daily cap', { min: 0 }),
  validFrom: z.string().optional(),
  isActive: z.boolean(),
}).refine((v) => v.cap == null || v.cap >= v.startPrice, { path: ['cap'], message: 'The cap cannot be below the start price' });

const today = () => new Date().toISOString().slice(0, 10);
const blank = { service: 'PARKING', vehicleType: 'CAR', unit: 'HOUR', startPrice: 100, increment: 100, cap: 2000, validFrom: today(), isActive: true };

// Pending = switched on but not effective yet.
const statusOf = (r) => (r.validFrom && new Date(r.validFrom) > new Date() ? 'PENDING' : 'ACTIVE');

export default function PricesPage() {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const writable = can('pricing.write');
  const [editing, setEditing] = useState(null);
  const [page, setPage] = useState(1);
  const list = useFetch(() => get('/rates', { limit: 50, sortBy: 'service', order: 'asc' }), []);

  const { register, handleSubmit, reset, watch, control, setValue, setError, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema), defaultValues: blank });
  const v = watch();

  // Keep the billing unit valid for the chosen service.
  useEffect(() => {
    const units = UNITS_BY_SERVICE[v.service].map((u) => u.value);
    if (!units.includes(v.unit)) setValue('unit', units[0]);
  }, [v.service]); // eslint-disable-line react-hooks/exhaustive-deps

  const startNew = () => { setEditing(null); reset(blank); };
  const edit = (r) => {
    setEditing(r);
    reset({ service: r.service, vehicleType: r.vehicleType || 'CAR', unit: r.unit, startPrice: Number(r.startPrice), increment: Number(r.increment), cap: r.cap != null ? Number(r.cap) : '', validFrom: r.validFrom ? r.validFrom.slice(0, 10) : today(), isActive: r.isActive });
  };

  const save = handleSubmit(async (f) => {
    const body = { service: f.service, vehicleType: f.vehicleType, unit: f.unit, startPrice: f.startPrice, increment: f.increment, cap: f.cap ?? null, validFrom: f.validFrom || null, isActive: f.isActive };
    try {
      if (editing) await patch(`/rates/${editing.id}`, body); else await post('/rates', body);
      toast('Price saved');
      startNew(); list.reload(true);
    } catch (err) {
      const e = parseError(err);
      for (const [field, message] of Object.entries(e.fields)) setError(field, { message });
      toast(e.message, 'error');
    }
  });

  const remove = async (r) => {
    if (!(await confirm({ title: 'Delete this price?', message: 'Sessions already charged keep their recorded fee. New charges need another matching price.', confirmLabel: 'Delete', danger: true }))) return;
    try { await del(`/rates/${r.id}`); toast('Price deleted'); if (editing?.id === r.id) startNew(); list.reload(true); } catch (err) { toast(parseError(err).message, 'error'); }
  };

  // The preview calls the same pricing engine used for real charges (debounced).
  const [preview, setPreview] = useState(null);
  const previewKey = JSON.stringify([v.unit, v.startPrice, v.increment, v.cap]);
  useEffect(() => {
    const start = Number(v.startPrice);
    if (!Number.isFinite(start) || start < 0) { setPreview(null); return undefined; }
    const t = setTimeout(() => {
      post('/rates/preview', { unit: v.unit, startPrice: start, increment: Number(v.increment) || 0, cap: v.cap === '' || v.cap == null || Number.isNaN(Number(v.cap)) ? null : Number(v.cap), minutes: PREVIEW_STAYS[v.unit] })
        .then((r) => setPreview(r.data)).catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [previewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const formula = useMemo(() => {
    if (!preview) return null;
    const n = preview.units;
    const start = Number(v.startPrice); const inc = Number(v.increment) || 0;
    const raw = start + (n - 1) * inc;
    const capped = v.cap !== '' && v.cap != null && Number(v.cap) < raw;
    const text = v.unit === 'VISIT' || n === 1 ? `${num(start)}` : `${num(start)} + ${n - 1} × ${num(inc)}`;
    return { text: `${text} = ${num(preview.total)} RWF`, capped };
  }, [preview, v.startPrice, v.increment, v.cap, v.unit]);

  const columns = [
    { key: 'service', label: 'Service', render: (r) => <span className="font-semibold text-ink">{SERVICE_LABEL[r.service]}</span> },
    { key: 'vehicleType', label: 'Vehicle', render: (r) => (r.vehicleType ? VEHICLE_LABEL[r.vehicleType] : 'All') },
    { key: 'unit', label: 'Unit', render: (r) => UNIT_LABEL[r.unit] },
    { key: 'startPrice', label: 'Start', render: (r) => num(r.startPrice) },
    { key: 'increment', label: 'Increase', render: (r) => (Number(r.increment) ? `+${num(r.increment)}` : '-') },
    { key: 'cap', label: 'Cap', render: (r) => (r.cap != null ? num(r.cap) : '-') },
    { key: 'status', label: 'Status', render: (r) => (r.isActive ? <StatusBadge status={statusOf(r)} /> : <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-semibold text-muted">Inactive</span>) },
    ...(writable ? [{ key: '_a', label: 'Actions', render: (r) => <div className="flex gap-3"><LinkAction onClick={() => edit(r)}>Edit</LinkAction><LinkAction onClick={() => remove(r)}>Delete</LinkAction></div> }] : []),
  ];

  return (
    <>
      <PageHeader title="Price / Cost (CRUD)" description="Prices start from 100 RWF and increase by rule. Every operation uses these values" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card title={editing ? 'Edit price / cost' : 'Add price / cost'} className="self-start">
          <form onSubmit={save} noValidate className="space-y-4">
            <Select label="Service" options={SERVICES} disabled={!writable} {...register('service')} />
            <Select label="Vehicle type" options={VEHICLES} disabled={!writable} error={errors.vehicleType?.message} {...register('vehicleType')} />
            <Select label="Billing unit" options={UNITS_BY_SERVICE[v.service]} disabled={!writable} {...register('unit')} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Start price (minimum 100)" type="number" inputMode="numeric" disabled={!writable} error={errors.startPrice?.message} {...register('startPrice')} />
              <Input label={`Increase per extra ${v.unit === 'VISIT' ? 'unit' : UNIT_LABEL[v.unit].toLowerCase()}`} type="number" inputMode="numeric" disabled={!writable} error={errors.increment?.message} {...register('increment')} />
              <Input label={v.unit === 'HOUR' ? 'Daily cap (maximum)' : 'Cap (maximum)'} type="number" inputMode="numeric" disabled={!writable} error={errors.cap?.message} {...register('cap')} />
              <Input label="Effective from" type="date" disabled={!writable} {...register('validFrom')} />
            </div>
            <Controller name="isActive" control={control} render={({ field }) => (
              <div>
                <p className="mb-1.5 text-xs text-muted">Status</p>
                <button type="button" role="switch" aria-checked={!!field.value} disabled={!writable} onClick={() => field.onChange(!field.value)} className="flex items-center gap-3 disabled:opacity-60">
                  <span className={`relative h-7 w-12 rounded-full transition-colors ${field.value ? 'bg-success-solid' : 'bg-line'}`}>
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${field.value ? 'left-[22px]' : 'left-0.5'}`} />
                  </span>
                  <span className="text-sm font-semibold text-ink">{field.value ? 'Active' : 'Inactive'}</span>
                </button>
              </div>
            )} />
            {writable && (
              <div className="flex gap-3 pt-2">
                <Button type="submit" variant="success" size="lg" className="flex-1" loading={isSubmitting}>Save price</Button>
                <Button variant="outline" size="lg" className="w-32" onClick={startNew}>Cancel</Button>
              </div>
            )}
            <p className="text-xs text-muted">Every change is saved in the audit log.</p>
          </form>
        </Card>

        <div className="space-y-6">
          <Card title="Price list">
            <DataTable columns={columns} rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload} meta={null} onPage={setPage} />
          </Card>
          <Card title="Fee preview">
            <p className="text-sm text-muted">{VEHICLE_LABEL[v.vehicleType] || 'Car'}, {SERVICE_LABEL[v.service]}, {PREVIEW_TEXT[v.unit]}{preview && v.unit !== 'VISIT' ? ` (${preview.units} ${UNIT_NOUN[v.unit]} started)` : ''}</p>
            <p className="mt-3 text-[32px] font-bold leading-tight text-primary" aria-live="polite">{formula ? formula.text : 'Enter a start price'}</p>
            {formula?.capped && <p className="mt-1 text-xs text-warning">Limited by the cap.</p>}
            <p className="mt-3 text-sm text-muted">Formula: Start price + ({v.unit === 'VISIT' ? 'units' : UNIT_NOUN[v.unit]} started - 1) x increase, never above the {v.unit === 'HOUR' ? 'daily ' : ''}cap.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
