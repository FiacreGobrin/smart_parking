import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import clsx from 'clsx';
import { Accessibility, Bike, Car, Crown, Lock, Plus, PlugZap, Rows3 } from 'lucide-react';
import { OccupancyBar } from '../components/charts/Charts.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { StatusBadge } from '../components/ui/Badge.jsx';
import { Input, Select } from '../components/ui/Fields.jsx';
import { FilterSelect } from '../components/ui/Filters.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { useSocketEvent } from '../hooks/useSocketEvent.js';
import { del, get, parseError, patch, post } from '../services/api.js';
import { dateTime, displayPlate, duration, minutesSince, titleCase } from '../utils/format.js';
import { zNum, zStr } from '../utils/zod.js';

const TYPE_ICON = { STANDARD: Car, MOTORCYCLE: Bike, ACCESSIBLE: Accessibility, EV: PlugZap, RESERVED: Lock, VIP: Crown };
const TYPES = Object.keys(TYPE_ICON);
// Status carries both colour and a text/icon cue (tile label), so it is never colour-only.
const TILE = {
  AVAILABLE: 'border-success/40 bg-success-soft text-success hover:border-success',
  OCCUPIED: 'border-accent/40 bg-accent-soft text-accent hover:border-accent',
  RESERVED: 'border-warning/40 bg-warning-soft text-warning hover:border-warning',
  OUT_OF_SERVICE: 'border-danger/40 bg-danger-soft text-danger hover:border-danger',
};

const spaceSchema = z.object({ code: zStr('Code', 1, 20), type: z.enum(TYPES), zoneId: z.string().optional(), notes: z.string().max(300).optional() });
const bulkSchema = z.object({ prefix: z.string().max(10).optional(), from: zNum('From', { min: 1 }), to: zNum('To', { min: 1 }), type: z.enum(TYPES), zoneId: z.string().optional() })
  .refine((v) => v.to >= v.from && v.to - v.from < 500, { path: ['to'], message: 'Range must be 1-500 spaces' });

function SpaceModal({ facilityId, zones, space, bulk, onClose, onSaved }) {
  const { toast } = useUi();
  const isBulk = !!bulk;
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(isBulk ? bulkSchema : spaceSchema),
    defaultValues: isBulk ? { prefix: '', from: 1, to: 10, type: 'STANDARD', zoneId: '' } : { code: space?.code ?? '', type: space?.type ?? 'STANDARD', zoneId: space?.zoneId ?? '', notes: space?.notes ?? '' },
  });
  const [err, setErr] = useState('');
  const submit = handleSubmit(async (v) => {
    setErr('');
    try {
      if (isBulk) {
        const { data } = await post('/spaces/bulk', { ...v, facilityId, zoneId: v.zoneId || null, prefix: v.prefix || '' });
        toast(`${data.created} spaces created${data.skipped ? `, ${data.skipped} already existed` : ''}`);
      } else if (space) {
        await patch(`/spaces/${space.id}`, { ...v, zoneId: v.zoneId || null, notes: v.notes || null });
        toast('Space updated');
      } else {
        await post('/spaces', { ...v, facilityId, zoneId: v.zoneId || null, notes: v.notes || undefined });
        toast('Space created');
      }
      onSaved();
    } catch (e) { setErr(parseError(e).message); }
  });
  const zoneOptions = zones.map((z2) => ({ value: z2.id, label: `${z2.name}${z2.floor ? ` (${z2.floor})` : ''}` }));
  return (
    <Modal open onClose={onClose} size="sm" title={isBulk ? 'Add a range of spaces' : space ? `Edit space ${space.code}` : 'Add space'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="space-form" loading={isSubmitting}>Save</Button></>}>
      <form id="space-form" onSubmit={submit} noValidate className="space-y-3">
        {isBulk ? (
          <>
            <Input label="Prefix" placeholder="A" help="Spaces become A01, A02, ..." {...register('prefix')} />
            <div className="grid grid-cols-2 gap-3"><Input label="From" type="number" error={errors.from?.message} {...register('from')} /><Input label="To" type="number" error={errors.to?.message} {...register('to')} /></div>
          </>
        ) : <Input label="Space code" required error={errors.code?.message} {...register('code')} />}
        <Select label="Category" options={TYPES.map((t) => ({ value: t, label: titleCase(t) }))} {...register('type')} />
        <Select label="Zone / floor" placeholder="No zone" options={zoneOptions} {...register('zoneId')} />
        {!isBulk && <Input label="Notes" {...register('notes')} />}
        {err && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}
      </form>
    </Modal>
  );
}

function SpaceDetail({ space, session, zones, onClose, onChanged }) {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState(false);
  const history = useFetch(() => get(`/spaces/${space.id}/history`, { limit: 8 }), [space.id, space.status]);
  const write = can('spaces.write');

  const setStatus = async (status) => {
    try { await patch(`/spaces/${space.id}`, { status }); toast(`Space ${space.code} is now ${titleCase(status).toLowerCase()}`); onChanged(); onClose(); }
    catch (e) { toast(parseError(e).message, 'error'); }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Archive space ${space.code}?`, message: 'The space disappears from the map; its history is kept.', confirmLabel: 'Archive', danger: true }))) return;
    try { await del(`/spaces/${space.id}`); toast('Space archived'); onChanged(); onClose(); } catch (e) { toast(parseError(e).message, 'error'); }
  };

  if (edit) return <SpaceModal facilityId={space.facilityId} zones={zones} space={space} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); onClose(); }} />;
  return (
    <Modal open onClose={onClose} size="md" title={`Space ${space.code}`}
      footer={write && (
        <>
          <Button variant="ghost" onClick={remove}>Archive</Button>
          <Button variant="secondary" onClick={() => setEdit(true)}>Edit</Button>
          {space.status === 'OUT_OF_SERVICE' ? <Button onClick={() => setStatus('AVAILABLE')}>Return to service</Button>
            : space.status !== 'OCCUPIED' && <Button variant="danger" onClick={() => setStatus('OUT_OF_SERVICE')}>Mark out of service</Button>}
          {space.status === 'AVAILABLE' && <Button variant="secondary" onClick={() => setStatus('RESERVED')}>Reserve</Button>}
          {space.status === 'RESERVED' && <Button variant="secondary" onClick={() => setStatus('AVAILABLE')}>Release</Button>}
        </>
      )}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={space.status} /><span className="text-muted">{titleCase(space.type)}{space.zone ? ` · ${space.zone.name}` : ''}</span></div>
        {session && <div className="rounded-xl border border-line p-3"><p className="font-mono text-lg font-semibold text-ink">{displayPlate(session.plate)}</p><p className="text-xs text-muted">Parked {duration(minutesSince(session.entryAt))} · since {dateTime(session.entryAt)} · ticket {session.ticketNo}</p></div>}
        {space.notes && <p className="text-muted">Note: {space.notes}</p>}
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted">Occupancy history</h3>
          {history.loading ? <Skeleton className="h-16" /> : !history.data?.length ? <p className="text-muted">No changes recorded.</p> : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {history.data.map((h) => <li key={h.id} className="flex justify-between gap-3 px-3 py-1.5 text-xs"><span>{h.fromStatus ? `${titleCase(h.fromStatus)} → ` : ''}<b>{titleCase(h.toStatus)}</b>{h.reason ? ` · ${h.reason}` : ''}</span><span className="text-muted">{dateTime(h.createdAt)}</span></li>)}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function SpaceMap() {
  const { can, user } = useAuth();
  const facilities = useFetch(() => get('/facilities', { limit: 100, sortBy: 'name', order: 'asc' }), []);
  const [facilityId, setFacilityId] = useState(user.facilityId || '');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [modal, setModal] = useState(null); // 'one' | 'bulk'

  useEffect(() => { if (!facilityId && facilities.data?.length) setFacilityId(facilities.data[0].id); }, [facilities.data, facilityId]);

  const spaces = useFetch(() => (facilityId ? get('/spaces', { facilityId, limit: 1000, sortBy: 'code', order: 'asc' }) : Promise.resolve({ data: [] })), [facilityId], { pollMs: 30000 });
  const sessions = useFetch(() => (facilityId && can('sessions.read') ? get('/parking/sessions', { facilityId, status: 'ACTIVE', limit: 100 }) : Promise.resolve({ data: [] })), [facilityId], { pollMs: 30000 });
  const zones = useFetch(() => (facilityId ? get('/zones', { facilityId, limit: 200 }) : Promise.resolve({ data: [] })), [facilityId]);

  const reload = () => { spaces.reload(true); sessions.reload(true); };
  useSocketEvent('occupancy:update', (o) => { if (o.facilityId === facilityId) reload(); });

  const bySpace = useMemo(() => new Map((sessions.data || []).map((s) => [s.spaceId, s])), [sessions.data]);
  const all = spaces.data || [];
  const counts = useMemo(() => all.reduce((a, s) => ({ ...a, [s.status]: (a[s.status] || 0) + 1 }), {}), [all]);
  const usable = all.length - (counts.OUT_OF_SERVICE || 0);
  const pct = usable ? Math.round(((counts.OCCUPIED || 0) / usable) * 100) : 0;
  const shown = all.filter((s) => (!type || s.type === type) && (!status || s.status === status));
  // Group by zone, keeping the zone order the API returned.
  const groups = useMemo(() => {
    const m = new Map();
    for (const s of shown) { const key = s.zone ? `${s.zone.name}${s.zone.floor ? ` · ${s.zone.floor}` : ''}` : 'No zone'; m.set(key, [...(m.get(key) || []), s]); }
    return [...m.entries()];
  }, [shown]);

  return (
    <>
      <PageHeader title="Parking Space Map" description="Live status of every space. Click a space for details, history and actions."
        actions={<>
          <Select aria-label="Facility" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} options={(facilities.data || []).map((f) => ({ value: f.id, label: f.name }))} />
          {can('spaces.write') && facilityId && <><Button variant="secondary" icon={Rows3} onClick={() => setModal('bulk')}>Add range</Button><Button icon={Plus} onClick={() => setModal('one')}>Add space</Button></>}
        </>} />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-[200px] flex-1"><p className="mb-1 text-xs text-muted">{counts.OCCUPIED || 0} of {usable} usable spaces occupied · {pct}%</p><OccupancyBar pct={pct} /></div>
          {['AVAILABLE', 'OCCUPIED', 'RESERVED', 'OUT_OF_SERVICE'].map((s) => (
            <button key={s} onClick={() => setStatus(status === s ? '' : s)} aria-pressed={status === s} className={clsx('flex items-center gap-2 rounded-lg px-2 py-1 text-sm', status === s && 'bg-surface-2 ring-1 ring-line')}>
              <span className={clsx('h-3 w-3 rounded border', TILE[s].split(' ').slice(0, 2).join(' '))} aria-hidden /><span className="text-muted">{titleCase(s)}</span><b className="text-ink">{counts[s] || 0}</b>
            </button>
          ))}
          <FilterSelect label="Category" value={type} onChange={setType} placeholder="All categories" options={TYPES.map((t) => ({ value: t, label: titleCase(t) }))} />
        </div>
      </Card>

      {spaces.error ? <Card><ErrorState error={spaces.error} onRetry={spaces.reload} /></Card>
        : spaces.loading && !spaces.data ? <Card><div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-3">{Array.from({ length: 24 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div></Card>
          : !groups.length ? <Card><EmptyState title="No spaces to show" description={all.length ? 'No spaces match the current filters.' : 'This facility has no spaces yet. Add them one by one or as a range.'} /></Card>
            : groups.map(([zone, list]) => (
              <Card key={zone} title={zone} subtitle={`${list.length} spaces`} className="mb-4">
                <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-3">
                  {list.map((s) => {
                    const Icon = TYPE_ICON[s.type] || Car;
                    const sess = bySpace.get(s.id);
                    return (
                      <button key={s.id} onClick={() => setSelected(s)} className={clsx('flex h-20 flex-col items-center justify-center gap-0.5 rounded-xl border px-1 text-center transition-colors', TILE[s.status])}
                        aria-label={`Space ${s.code}, ${titleCase(s.type)}, ${titleCase(s.status)}${sess ? `, plate ${sess.plate}` : ''}`}>
                        <Icon className="h-4 w-4" aria-hidden />
                        <span className="text-sm font-semibold">{s.code}</span>
                        <span className="max-w-full truncate text-[10px] font-medium">{sess ? displayPlate(sess.plate) : titleCase(s.status)}</span>
                      </button>
                    );
                  })}
                </div>
              </Card>
            ))}

      {selected && <SpaceDetail space={selected} zones={zones.data || []} session={bySpace.get(selected.id)} onClose={() => setSelected(null)} onChanged={reload} />}
      {modal && <SpaceModal facilityId={facilityId} zones={zones.data || []} bulk={modal === 'bulk'} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </>
  );
}
