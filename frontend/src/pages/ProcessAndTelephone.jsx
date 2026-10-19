import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '../components/ui/Button.jsx';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { SimulatedBadge } from '../components/ui/Badge.jsx';
import { Input } from '../components/ui/Fields.jsx';
import { SimulationBanner, ErrorState, Skeleton } from '../components/ui/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { get, parseError, put } from '../services/api.js';
import { dateTime, localPhone, num } from '../utils/format.js';

// ---------------------------------------------------------------- Business Process
const STEPS = [
  { title: 'Sign-up', text: 'A person registers with full name, phone and national ID. The request waits as Pending.', stat: (d) => [d.users?.pending, 'waiting for approval'] },
  { title: 'Approval', text: 'An administrator approves. A code, username and password are generated and sent by SMS.', stat: (d) => [d.users?.active, 'active users'] },
  { title: 'Scan plate', text: 'Phone camera or manual entry. New vehicles are registered with their service and space.', stat: (d) => [d.summary?.entriesToday, 'entries today'] },
  { title: 'Fee', text: 'Start price + (units started - 1) x increase, never above the cap. Rules live in Price / Cost.', stat: (d) => [d.summary?.vehiclesParked, 'vehicles inside now'] },
  { title: 'Payment', text: 'MTN MoMo, Airtel Money, Equity Bank or cash. Electronic payments are confirmed by the provider.', stat: (d) => [d.summary?.paymentsToday, 'payments today'] },
  { title: 'Receipt', text: 'A receipt with a reference is issued and the vehicle is released.', stat: (d) => [d.summary?.exitsToday, 'exits today'] },
];

export function BusinessProcessPage() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useFetch(async () => {
    const [summary, users] = await Promise.all([get('/dashboard/summary'), can('users.read') ? get('/users/stats') : Promise.resolve({ data: null })]);
    return { data: { summary: summary.data, users: users.data } };
  }, [], { pollMs: 30000 });

  return (
    <>
      <PageHeader title="Business Process" description="How a person and a vehicle move through the system, with live counts from the database." />
      {error ? <Card><ErrorState error={error} onRetry={reload} /></Card> : (
        <ol className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {STEPS.map((s, i) => {
            const [n, label] = loading || !data ? [null, ''] : s.stat(data);
            return (
              <li key={s.title} className="relative rounded-[20px] border border-line bg-surface p-6 shadow-card">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">{i + 1}</span>
                  <h2 className="text-lg font-bold text-ink">{s.title}</h2>
                  {i < STEPS.length - 1 && <ArrowRight className="ml-auto hidden h-5 w-5 text-muted xl:block" aria-hidden />}
                </div>
                <p className="mt-3 min-h-[60px] text-sm text-muted">{s.text}</p>
                <div className="mt-4 border-t border-line pt-4">
                  {loading && !data ? <Skeleton className="h-8 w-24" /> : n == null ? <p className="text-sm text-muted">No access to this figure</p> : (
                    <p><span className="text-3xl font-bold text-primary">{num(n)}</span> <span className="text-sm text-muted">{label}</span></p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

// ---------------------------------------------------------------- System Telephone
const NUMBER_SETTINGS = [
  ['telephone.sms_sender', 'SMS sender name', 'Shown as the sender of SMS messages (max 11 characters).'],
  ['telephone.support_line', 'Support line', 'Printed on receipts and in SMS.'],
  ['telephone.mtn_momo', 'MTN MoMo merchant number', 'Where MTN MoMo payments are collected.'],
  ['telephone.airtel_money', 'Airtel Money merchant number', 'Where Airtel Money payments are collected.'],
  ['telephone.equity_bank', 'Equity Bank account / short code', 'Where Equity Bank payments are collected.'],
];

export function TelephonePage() {
  const { can } = useAuth();
  const { toast } = useUi();
  const settings = useFetch(() => get('/settings'), []);
  const sms = useFetch(() => (can('users.read') ? get('/sms-messages', { limit: 15 }) : Promise.resolve({ data: [] })), []);
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const writable = can('settings.write');
  const current = (key) => values[key] ?? settings.data?.find((s) => s.key === key)?.value ?? '';
  const dirty = Object.keys(values).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      for (const [k, v] of Object.entries(values)) await put(`/settings/${k}`, { value: v });
      toast('Telephone settings saved'); setValues({}); settings.reload(true);
    } catch (e) { toast(parseError(e).message, 'error'); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader title="System Telephone" description="Numbers the system uses to collect payments and to send SMS, and a log of the messages it prepared." />
      {sms.meta && !sms.meta.configured && (
        <SimulationBanner><b>SMS gateway not connected.</b> Messages are recorded below but not delivered. Set SMS_MODE=africastalking with AT_USERNAME and AT_API_KEY in the server settings to send real SMS. Passwords are never stored in this log.</SimulationBanner>
      )}
      {sms.meta?.configured && <p className="mb-4 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">SMS gateway connected ({sms.meta.mode}). Credentials are sent to the user's phone; passwords are never stored in the log.</p>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
        <Card title="Telephone numbers" className="self-start">
          {settings.error ? <ErrorState error={settings.error} onRetry={settings.reload} /> : settings.loading ? <Skeleton className="h-64" /> : (
            <div className="space-y-4">
              {NUMBER_SETTINGS.map(([key, label, help]) => (
                <Input key={key} label={label} help={help} value={current(key)} disabled={!writable} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} placeholder={key.includes('sender') ? 'SmartParking' : '+250 788 000 000'} />
              ))}
              {writable ? <Button variant="success" size="lg" className="w-full" disabled={!dirty} loading={saving} onClick={save}>Save numbers</Button> : <p className="text-xs text-muted">Only an administrator can change these numbers.</p>}
            </div>
          )}
        </Card>
        <Card title="SMS log" subtitle="Latest messages prepared by the system">
          <DataTable dense loading={sms.loading} error={sms.error} onRetry={sms.reload} rows={sms.data} meta={sms.meta}
            columns={[
              { key: 'createdAt', label: 'Time', render: (r) => dateTime(r.createdAt) },
              { key: 'toPhone', label: 'To', render: (r) => localPhone(r.toPhone) },
              { key: 'body', label: 'Message', render: (r) => <span className="text-xs text-muted">{r.body}</span> },
              { key: 'status', label: 'Status', render: (r) => (r.status === 'SENT' ? <span className="text-xs font-semibold text-success">Sent</span> : r.status === 'SIMULATED' ? <SimulatedBadge /> : <span className="text-xs font-semibold text-danger">Failed</span>) },
            ]} />
        </Card>
      </div>
    </>
  );
}
