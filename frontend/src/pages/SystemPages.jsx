import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Bell, CheckCheck, Download, ShieldAlert, ShieldX } from 'lucide-react';
import { Button } from '../components/ui/Button.jsx';
import { Badge, StatusBadge } from '../components/ui/Badge.jsx';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { Checkbox, Input, Textarea } from '../components/ui/Fields.jsx';
import { FilterBar, FilterSelect, SearchBox } from '../components/ui/Filters.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { useSocketEvent } from '../hooks/useSocketEvent.js';
import { download, get, parseError, patch, post, put } from '../services/api.js';
import { dateTime, localPhone, timeAgo, titleCase } from '../utils/format.js';
import { zPassword, zStr } from '../utils/zod.js';

// ------------------------------------------------------------ Notifications
const SEV_ICON = { CRITICAL: 'text-danger bg-danger-soft', WARNING: 'text-warning bg-warning-soft', INFO: 'text-accent bg-accent-soft' };

export function NotificationsPage() {
  const { toast } = useUi();
  const [q, setQ] = useState({ page: 1, unread: '', type: '', severity: '' });
  const params = Object.fromEntries(Object.entries({ ...q, limit: 15 }).filter(([, v]) => v !== ''));
  const { data, meta, loading, error, reload } = useFetch(() => get('/notifications', params), [JSON.stringify(params)], { pollMs: 45000 });
  useSocketEvent('notification:new', () => reload(true));
  const set = (p) => setQ((s) => ({ ...s, page: 1, ...p }));

  const markAll = async () => { try { const { data: r } = await post('/notifications/read-all'); toast(`${r.marked} marked as read`); reload(true); } catch (e) { toast(parseError(e).message, 'error'); } };
  const markOne = async (n) => { if (n.read) return; try { await post(`/notifications/${n.id}/read`); reload(true); } catch { /* non-critical */ } };

  return (
    <>
      <PageHeader title="Notifications" description={`${meta?.unread ?? 0} unread. Alerts for availability, devices, payments and recognition problems.`}
        actions={<Button variant="secondary" icon={CheckCheck} onClick={markAll} disabled={!meta?.unread}>Mark all as read</Button>} />
      <Card padded={false}>
        <FilterBar>
          <FilterSelect label="Read state" value={q.unread} onChange={(unread) => set({ unread })} placeholder="All" options={[{ value: 'true', label: 'Unread only' }]} />
          <FilterSelect label="Severity" value={q.severity} onChange={(severity) => set({ severity })} placeholder="Any severity" options={['CRITICAL', 'WARNING', 'INFO'].map((v) => ({ value: v, label: titleCase(v) }))} />
          <FilterSelect label="Type" value={q.type} onChange={(type) => set({ type })} placeholder="Any type" options={['LOW_AVAILABILITY', 'PAYMENT_FAILED', 'DEVICE_OFFLINE', 'UNUSUAL_ACCESS', 'RECOGNITION_FAILED', 'EXPIRING_RESERVATION', 'EXPIRING_PERMIT', 'SYSTEM_ERROR', 'INFO'].map((v) => ({ value: v, label: titleCase(v) }))} />
        </FilterBar>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          : !data.length ? <EmptyState icon={Bell} title="You are all caught up" description="New alerts will appear here as they happen." />
            : (
              <ul className="divide-y divide-line">
                {data.map((n) => (
                  <li key={n.id}>
                    <button onClick={() => markOne(n)} className={`flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-surface-2 ${n.read ? 'opacity-70' : ''}`}>
                      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${SEV_ICON[n.severity]}`}><ShieldAlert className="h-4 w-4" aria-hidden /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2"><span className={`text-sm ${n.read ? 'text-ink' : 'font-semibold text-ink'}`}>{n.title}</span><StatusBadge status={n.severity} />{!n.read && <Badge tone="blue">New</Badge>}</span>
                        <span className="block text-sm text-muted">{n.message}</span>
                        <span className="block text-xs text-muted">{titleCase(n.type)} · {timeAgo(n.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        {meta && data?.length > 0 && meta.totalPages > 1 && (
          <div className="flex justify-between border-t border-line px-5 py-3 text-xs text-muted"><span>Page {meta.page} of {meta.totalPages}</span>
            <span className="flex gap-2"><Button size="sm" variant="secondary" disabled={meta.page <= 1} onClick={() => setQ((s) => ({ ...s, page: s.page - 1 }))}>Previous</Button><Button size="sm" variant="secondary" disabled={meta.page >= meta.totalPages} onClick={() => setQ((s) => ({ ...s, page: s.page + 1 }))}>Next</Button></span></div>
        )}
      </Card>
    </>
  );
}

// ------------------------------------------------------------ Audit logs
export function AuditPage() {
  const { can } = useAuth();
  const { toast } = useUi();
  const [q, setQ] = useState({ page: 1, action: '', actor: '', result: '', from: '', to: '' });
  const [open, setOpen] = useState(null);
  const params = Object.fromEntries(Object.entries({ ...q, limit: 25 }).filter(([, v]) => v !== ''));
  const { data, meta, loading, error, reload } = useFetch(() => get('/audit-logs', params), [JSON.stringify(params)]);
  const set = (p) => setQ((s) => ({ ...s, page: 1, ...p }));
  const exportCsv = async () => { try { await download('/audit-logs', { ...params, format: 'csv', page: undefined, limit: undefined }, 'audit-log.csv'); } catch (e) { toast(parseError(e).message, 'error'); } };
  return (
    <>
      <PageHeader title="Audit Logs" description="Append-only record of sign-ins, configuration changes, access decisions, payments and overrides. Records cannot be edited or deleted."
        actions={can('export') && <Button variant="secondary" icon={Download} onClick={exportCsv}>Export CSV</Button>} />
      <Card padded={false}>
        <FilterBar>
          <SearchBox value={q.action} onChange={(action) => set({ action })} placeholder="Action, e.g. PAYMENT" className="min-w-[180px] flex-1 sm:max-w-[240px]" />
          <SearchBox value={q.actor} onChange={(actor) => set({ actor })} placeholder="User e-mail" className="min-w-[180px] flex-1 sm:max-w-[240px]" />
          <FilterSelect label="Result" value={q.result} onChange={(result) => set({ result })} placeholder="Any result" options={['SUCCESS', 'DENIED', 'FAILED'].map((v) => ({ value: v, label: titleCase(v) }))} />
          <input type="date" aria-label="From date" value={q.from} onChange={(e) => set({ from: e.target.value })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
          <input type="date" aria-label="To date" value={q.to} onChange={(e) => set({ to: e.target.value })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
        </FilterBar>
        <DataTable dense loading={loading} error={error} onRetry={reload} rows={data} meta={meta} onPage={(page) => setQ((s) => ({ ...s, page }))} onRowClick={setOpen}
          columns={[
            { key: 'createdAt', label: 'Time', render: (r) => dateTime(r.createdAt) },
            { key: 'actorEmail', label: 'Actor', render: (r) => r.actorEmail || 'System' },
            { key: 'action', label: 'Action', render: (r) => <span className="font-mono text-xs">{r.action}</span> },
            { key: 'entity', label: 'Record', render: (r) => (r.entity ? `${r.entity}${r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ''}` : '-') },
            { key: 'result', label: 'Result', render: (r) => <StatusBadge status={r.result === 'SUCCESS' ? 'SUCCESS' : r.result === 'DENIED' ? 'DENIED' : 'FAILED'} /> },
            { key: 'ip', label: 'IP', render: (r) => r.ip || '-' },
          ]} />
      </Card>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div role="dialog" aria-modal="true" aria-label="Audit event" className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-2xl border border-line bg-surface p-5 shadow-card">
            <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-ink">{open.action}</h2><Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button></div>
            <p className="mb-2 text-xs text-muted">{dateTime(open.createdAt)} · {open.actorEmail || 'System'} · request {open.requestId || '-'}</p>
            <pre className="overflow-auto rounded-lg bg-surface-2 p-3 text-xs text-ink">{JSON.stringify(open.metadata ?? {}, null, 2)}</pre>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------ Settings
function SettingEditor({ setting, onSaved }) {
  const { toast } = useUi();
  const v = setting.value;
  const kind = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : Array.isArray(v) ? 'json' : 'text';
  const [value, setValue] = useState(kind === 'json' ? JSON.stringify(v, null, 2) : v);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(kind === 'json' ? safeParse(value) : value) !== JSON.stringify(v);

  const save = async () => {
    setError('');
    let out = value;
    if (kind === 'json') { out = safeParse(value); if (out === undefined) { setError('Invalid JSON'); return; } }
    if (kind === 'number') out = Number(value);
    setSaving(true);
    try { await put(`/settings/${setting.key}`, { value: out }); toast(`${setting.key} saved`); onSaved(); }
    catch (e) { const pe = parseError(e); setError(pe.details?.[0]?.message || pe.message); } finally { setSaving(false); }
  };
  return (
    <div className="grid gap-3 border-b border-line py-4 last:border-0 md:grid-cols-[1fr_1.4fr]">
      <div><p className="font-mono text-sm font-medium text-ink">{setting.key}</p><p className="text-xs text-muted">{setting.description}</p>{setting.isDefault && <Badge className="mt-1">Default</Badge>}</div>
      <div className="space-y-2">
        {kind === 'boolean' ? <Checkbox label={value ? 'Enabled' : 'Disabled'} checked={!!value} onChange={(e) => setValue(e.target.checked)} />
          : kind === 'json' ? <Textarea aria-label={setting.key} rows={7} className="font-mono text-xs" value={value} onChange={(e) => setValue(e.target.value)} />
            : <Input aria-label={setting.key} type={kind === 'number' ? 'number' : 'text'} step="any" value={value} onChange={(e) => setValue(e.target.value)} />}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
      </div>
    </div>
  );
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

export function SettingsPage() {
  const { data, loading, error, reload } = useFetch(() => get('/settings'), []);
  return (
    <>
      <PageHeader title="System Settings" description="Operational configuration. Every change is audited with its previous and new value." />
      <Card>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading ? <Skeleton className="h-48" /> : data.filter((s) => !s.key.startsWith('telephone.')).map((s) => <SettingEditor key={`${s.key}-${s.updatedAt}`} setting={s} onSaved={reload} />)}
      </Card>
    </>
  );
}

// ------------------------------------------------------------ Profile
const pwSchema = z.object({ currentPassword: zStr('Current password'), newPassword: zPassword, confirm: z.string() }).refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
const profileSchema = z.object({ name: zStr('Name', 2, 100) });

export function ProfilePage() {
  const { user, refreshUser, logout, can } = useAuth();
  const { toast } = useUi();
  const navigate = useNavigate();
  const history = useFetch(() => get('/auth/login-history'), []);
  const [pwError, setPwError] = useState('');
  const pf = useForm({ resolver: zodResolver(profileSchema), defaultValues: { name: user.name } });
  const pw = useForm({ resolver: zodResolver(pwSchema) });

  const saveProfile = pf.handleSubmit(async (v) => {
    try { await patch('/auth/profile', { name: v.name }); await refreshUser(); toast('Profile updated'); } catch (e) { toast(parseError(e).message, 'error'); }
  });
  const savePw = pw.handleSubmit(async (v) => {
    setPwError('');
    try { await post('/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword }); toast('Password changed. Please sign in again.'); await logout(); navigate('/login'); }
    catch (e) { setPwError(parseError(e).message); }
  });

  return (
    <>
      <PageHeader title="My Profile" description={`${titleCase(user.role)} - ${user.username}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <form onSubmit={saveProfile} noValidate className="space-y-3">
            <Input label="Full name" required error={pf.formState.errors.name?.message} {...pf.register('name')} />
            <Input label="Phone" value={user.phone ? localPhone(user.phone) : ''} disabled readOnly help="Ask an administrator to change your phone number." />
            <Input label="Username" value={user.username} disabled readOnly />
            <Button type="submit" loading={pf.formState.isSubmitting}>Save changes</Button>
          </form>
        </Card>
        <Card title="Change password" subtitle="You will be signed out everywhere afterwards.">
          <form onSubmit={savePw} noValidate className="space-y-3">
            <Input label="Current password" type="password" autoComplete="current-password" error={pw.formState.errors.currentPassword?.message} {...pw.register('currentPassword')} />
            <Input label="New password" type="password" autoComplete="new-password" error={pw.formState.errors.newPassword?.message} {...pw.register('newPassword')} />
            <Input label="Confirm new password" type="password" autoComplete="new-password" error={pw.formState.errors.confirm?.message} {...pw.register('confirm')} />
            {pwError && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{pwError}</p>}
            <Button type="submit" loading={pw.formState.isSubmitting}>Update password</Button>
          </form>
        </Card>
        <Card title="Your permissions" subtitle="Granted by your role">
          <div className="flex flex-wrap gap-1.5">{user.permissions.includes('*') ? <Badge tone="teal">Full access</Badge> : user.permissions.map((p) => <Badge key={p}>{p}</Badge>)}</div>
          {!can('settings.write') && <p className="mt-3 text-xs text-muted">Need more access? Ask a super administrator to change your role.</p>}
        </Card>
        <Card title="Recent sign-in activity" padded={false}>
          <DataTable dense loading={history.loading} error={history.error} rows={history.data}
            columns={[{ key: 'createdAt', label: 'Time', render: (r) => dateTime(r.createdAt) }, { key: 'success', label: 'Result', render: (r) => <StatusBadge status={r.success ? 'SUCCESS' : 'FAILED'} /> }, { key: 'ip', label: 'IP', render: (r) => r.ip || '-' }]} />
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------ Misc
export function ForbiddenPage() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft text-danger"><ShieldX className="h-7 w-7" aria-hidden /></span>
      <h1 className="mt-4 text-xl font-semibold text-ink">Access denied</h1>
      <p className="mt-1 text-sm text-muted">Your role does not include permission for this page. If you think this is a mistake, ask an administrator.</p>
      <Link to="/" className="mt-5 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-ink hover:bg-primary-hover">Back to dashboard</Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <p className="text-5xl font-semibold text-primary">404</p>
      <h1 className="mt-2 text-xl font-semibold text-ink">Page not found</h1>
      <p className="mt-1 text-sm text-muted">The page you are looking for does not exist or has moved.</p>
      <Link to="/" className="mt-5 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-ink hover:bg-primary-hover">Back to dashboard</Link>
    </div>
  );
}
