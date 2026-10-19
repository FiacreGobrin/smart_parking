import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus } from 'lucide-react';
import { Button } from '../components/ui/Button.jsx';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { StatusBadge } from '../components/ui/Badge.jsx';
import { Input, Select } from '../components/ui/Fields.jsx';
import { SearchBox } from '../components/ui/Filters.jsx';
import { LinkAction, PillTabs } from '../components/ui/PillTabs.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { del, get, parseError, patch, post } from '../services/api.js';
import { localPhone } from '../utils/format.js';

const ALL_ROLES = [
  { value: 'USER', label: 'User' }, { value: 'ATTENDANT', label: 'Attendant' }, { value: 'PARKING_ADMIN', label: 'Parking admin' },
  { value: 'FINANCE_OFFICER', label: 'Finance officer' }, { value: 'VIEWER', label: 'Viewer' }, { value: 'SUPER_ADMIN', label: 'Admin' },
];
const NEEDS_FACILITY = ['PARKING_ADMIN', 'ATTENDANT', 'USER'];

const schema = z.object({
  name: z.string().trim().min(2, 'Enter the full name'),
  phone: z.string().trim().min(1, 'Phone number is required').refine((v) => /^(250)?0?7\d{8}$/.test(v.replace(/\D/g, '')), 'Use a Rwandan number like 0788 123 456'),
  nationalId: z.string().trim().regex(/^\d{16}$/, 'National ID must be 16 digits'),
  role: z.string().min(1),
  facilityId: z.string().optional(),
});
const blank = { name: '', phone: '', nationalId: '', role: 'USER', facilityId: '' };

function CredentialsBox({ creds, sms }) {
  return (
    <div className="rounded-2xl bg-primary-soft p-4" aria-live="polite">
      <p className="text-xs text-muted">Generated (sent by SMS)</p>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
        <div><p className="text-xs text-muted">Code</p><p className="text-2xl font-semibold tracking-wide text-primary">{creds.code}</p></div>
        <div><p className="text-xs text-muted">Username</p><p className="text-lg font-semibold text-ink">{creds.username}</p></div>
        <div className="col-span-2"><p className="text-xs text-muted">Password</p><p className="select-all font-mono text-lg font-semibold text-ink">{creds.password}</p></div>
      </div>
      {sms && !sms.sent && (
        <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
          {sms.simulated ? 'No SMS gateway is connected, so nothing was sent. Give these details to the user yourself.' : `SMS not delivered: ${sms.detail}. Give these details to the user yourself.`}
        </p>
      )}
      {sms?.sent && <p className="mt-3 text-xs text-success">SMS delivered to the user.</p>}
    </div>
  );
}

export default function UsersPage() {
  const { user: me } = useAuth();
  const { toast, confirm } = useUi();
  const isSuper = me.role === 'SUPER_ADMIN';
  const roles = isSuper ? ALL_ROLES : ALL_ROLES.filter((r) => ['USER', 'ATTENDANT', 'VIEWER'].includes(r.value));

  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null); // null = adding
  const [creds, setCreds] = useState(null);
  const [busy, setBusy] = useState('');

  const stats = useFetch(() => get('/users/stats'), []);
  const facilities = useFetch(() => get('/facilities', { limit: 100 }), []);
  const params = useMemo(() => Object.fromEntries(Object.entries({ page, limit: 8, status: tab, search }).filter(([, v]) => v !== '')), [page, tab, search]);
  const list = useFetch(() => get('/users', params), [JSON.stringify(params)]);

  const { register, handleSubmit, reset, watch, trigger, getValues, setError, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(schema), defaultValues: blank });
  const role = watch('role');
  const showFacility = isSuper && NEEDS_FACILITY.includes(role) && (facilities.data?.length ?? 0) > 1;

  const reloadAll = () => { list.reload(true); stats.reload(true); };
  const startNew = () => { setSelected(null); setCreds(null); reset(blank); };
  useEffect(() => { if (!me.facilityId) return; reset({ ...blank, facilityId: me.facilityId }); }, [me.facilityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (u, c = null) => {
    setSelected(u); setCreds(c);
    reset({ name: u.name, phone: localPhone(u.phone) || '', nationalId: u.nationalId || '', role: u.role, facilityId: u.facilityId || '' });
  };

  const fail = (err) => {
    const e = parseError(err);
    for (const [field, message] of Object.entries(e.fields)) setError(field, { message });
    toast(e.message, 'error');
  };

  const generate = async () => {
    if (!(await trigger(['name', 'phone']))) return;
    const { name, phone } = getValues();
    if (selected && selected.status !== 'PENDING') {
      if (!(await confirm({ title: 'Generate new credentials?', message: `${selected.name} gets a new code, username and password. The old password stops working and they are signed out.`, confirmLabel: 'Generate', danger: true }))) return;
      setBusy('generate');
      try { const { data } = await post(`/users/${selected.id}/credentials`, {}); setCreds({ ...data.credentials, sms: data.sms }); setSelected(data); toast('New credentials generated'); reloadAll(); } catch (e) { fail(e); } finally { setBusy(''); }
      return;
    }
    setBusy('generate');
    try { const { data } = await post('/users/generate', { name, phone }); setCreds(data); } catch (e) { fail(e); } finally { setBusy(''); }
  };

  const save = handleSubmit(async (v) => {
    const body = { name: v.name, phone: v.phone, nationalId: v.nationalId, role: v.role, ...(v.facilityId ? { facilityId: v.facilityId } : {}) };
    try {
      if (selected) {
        const { data } = await patch(`/users/${selected.id}`, body);
        setSelected(data);
        toast('User saved');
      } else {
        const { data } = await post('/users', { ...body, ...(creds ? { code: creds.code, username: creds.username, password: creds.password } : {}) });
        setCreds({ ...data.credentials, sms: data.sms });
        setSelected(data);
        toast(data.sms?.sent ? 'User created. Credentials sent by SMS.' : 'User created. SMS not sent (gateway not connected): share the details shown.', data.sms?.sent ? 'success' : 'warning');
      }
      reloadAll();
    } catch (e) { fail(e); }
  });

  const approve = async (u) => {
    if (!(await confirm({ title: `Approve ${u.name}?`, message: 'A code, username and password are generated and sent by SMS. The account becomes active.', confirmLabel: 'Approve' }))) return;
    try {
      const { data } = await post(`/users/${u.id}/approve`);
      pick(data, { ...data.credentials, sms: data.sms });
      toast(`${u.name} approved`);
      reloadAll();
    } catch (err) {
      const e = parseError(err);
      if (e.code === 'FACILITY_REQUIRED') {
        // Load the person into the form so a facility can be chosen and saved, then approved.
        pick(u);
        toast(`Choose a facility for ${u.name}, save, then approve.`, 'warning');
      } else toast(e.message, 'error');
    }
  };
  const setBlocked = async (u, block) => {
    if (block && !(await confirm({ title: `Block ${u.name}?`, message: 'They are signed out immediately and cannot sign in until unblocked.', confirmLabel: 'Block', danger: true }))) return;
    try { await post(`/users/${u.id}/${block ? 'block' : 'unblock'}`); toast(block ? 'User blocked' : 'User unblocked'); if (selected?.id === u.id) setSelected({ ...u, status: block ? 'BLOCKED' : 'ACTIVE' }); reloadAll(); } catch (e) { toast(parseError(e).message, 'error'); }
  };
  const remove = async (u) => {
    if (!(await confirm({ title: `Delete ${u.name}?`, message: 'The account is archived and signed out. Their history stays in the audit log.', confirmLabel: 'Delete', danger: true }))) return;
    try { await del(`/users/${u.id}`); toast('User deleted'); if (selected?.id === u.id) startNew(); reloadAll(); } catch (e) { toast(parseError(e).message, 'error'); }
  };

  const s = stats.data;
  const mayManage = (u) => isSuper || ['USER', 'ATTENDANT', 'VIEWER'].includes(u.role);
  const columns = [
    { key: 'name', label: 'Full name', render: (u) => <span className="font-semibold text-ink">{u.name}</span> },
    { key: 'phone', label: 'Phone', render: (u) => <span className="whitespace-nowrap">{localPhone(u.phone) || '-'}</span> },
    { key: 'nationalId', label: 'National ID', className: 'hidden 2xl:table-cell', render: (u) => u.nationalId || '-' },
    { key: 'username', label: 'Username', render: (u) => (u.status === 'PENDING' ? <span className="text-muted">not yet issued</span> : u.username) },
    { key: 'status', label: 'Status', render: (u) => <StatusBadge status={u.status} /> },
    { key: '_a', label: 'Actions', render: (u) => mayManage(u) && (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {u.status === 'PENDING' && <LinkAction onClick={() => approve(u)}>Approve</LinkAction>}
        {u.status === 'BLOCKED' && <LinkAction onClick={() => setBlocked(u, false)}>Unblock</LinkAction>}
        <LinkAction onClick={() => pick(u)}>Edit</LinkAction>
        {u.status === 'ACTIVE' && u.id !== me.id && <LinkAction onClick={() => setBlocked(u, true)}>Block</LinkAction>}
        {u.id !== me.id && <LinkAction onClick={() => remove(u)}>Delete</LinkAction>}
      </div>
    ) },
  ];

  return (
    <>
      <PageHeader title="Users (CRUD)" description="Create users, approve sign-ups, generate code, username and password"
        actions={<Button size="lg" icon={Plus} onClick={startNew}>Add user</Button>} />

      <PillTabs label="User status" value={tab} onChange={(t) => { setTab(t); setPage(1); }}
        tabs={[{ value: '', label: 'All', count: s?.all }, { value: 'PENDING', label: 'Pending', count: s?.pending }, { value: 'ACTIVE', label: 'Active', count: s?.active }, { value: 'BLOCKED', label: 'Blocked', count: s?.blocked }]} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <div className="mb-4 max-w-xs"><SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name, phone, ID or username" /></div>
          <DataTable columns={columns} rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload} meta={list.meta} onPage={setPage} />
        </Card>

        <Card title={selected ? 'Edit user' : 'Add / edit user'} className="self-start">
          <form onSubmit={save} noValidate className="space-y-4">
            <Input label="Full name" error={errors.name?.message} autoComplete="off" {...register('name')} />
            <Input label="Phone number" placeholder="+250 788 123 456" error={errors.phone?.message} autoComplete="off" {...register('phone')} />
            <Input label="National ID" inputMode="numeric" maxLength={16} error={errors.nationalId?.message} autoComplete="off" {...register('nationalId')} />
            <Select label="Role" options={roles} {...register('role')} />
            {showFacility && <Select label="Facility" placeholder="Choose a facility" options={(facilities.data || []).map((f) => ({ value: f.id, label: f.name }))} {...register('facilityId')} help="Staff and users only see this facility." />}
            <Button size="lg" className="w-full" loading={busy === 'generate'} onClick={generate}>Generate code, username &amp; password</Button>
            {creds && <CredentialsBox creds={creds} sms={creds.sms} />}
            <div className="flex gap-3 pt-1">
              <Button type="submit" variant="success" size="lg" className="flex-1" loading={isSubmitting}>Save user</Button>
              <Button variant="dangerOutline" size="lg" className="w-32" disabled={!selected || selected.id === me.id} onClick={() => selected && remove(selected)}>Delete</Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
