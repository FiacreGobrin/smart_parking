import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Receipt, Undo2 } from 'lucide-react';
import { Button } from '../components/ui/Button.jsx';
import { Card, PageHeader, Tabs } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { SimulatedBadge, StatusBadge } from '../components/ui/Badge.jsx';
import { Textarea } from '../components/ui/Fields.jsx';
import { FacilityFilter, FilterBar, FilterSelect, SearchBox } from '../components/ui/Filters.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { ErrorState, Skeleton } from '../components/ui/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { ReceiptModal } from '../features/ReceiptModal.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { useSocketEvent } from '../hooks/useSocketEvent.js';
import { download, get, parseError, post } from '../services/api.js';
import { dateTime, displayPlate, money, titleCase } from '../utils/format.js';

function PaymentDetail({ id, onClose, onChanged }) {
  const { can } = useAuth();
  const { toast } = useUi();
  const { data: p, loading, error, reload } = useFetch(() => get(`/payments/${id}`), [id]);
  const [receipt, setReceipt] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (fn, okMsg) => {
    setBusy(true);
    try { await fn(); toast(okMsg); setRefundOpen(false); onChanged(); reload(); } catch (e) { toast(parseError(e).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="Payment" size="md">
      {loading ? <Skeleton className="h-40" /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <div className="space-y-4 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div><p className="text-2xl font-semibold text-ink">{money(p.amount, p.currency)}</p><p className="font-mono text-xs text-muted">{p.reference}</p></div>
            <div className="flex flex-col items-end gap-1"><StatusBadge status={p.status} />{p.isSimulated && <SimulatedBadge />}</div>
          </div>
          <dl className="divide-y divide-line rounded-xl border border-line">
            {[
              ['Method', titleCase(p.method)], ['Provider', p.provider || '-'], ['Provider reference', p.providerReference || '-'], ['Payer phone', p.payerPhone || '-'],
              ['Vehicle', p.session ? `${displayPlate(p.session.plate)} · ${p.session.ticketNo}` : '-'], ['Created', dateTime(p.createdAt)], ['Paid', dateTime(p.paidAt)],
              ['Reconciled', p.reconciledAt ? dateTime(p.reconciledAt) : 'No'], ...(p.failureReason ? [['Failure', p.failureReason]] : []), ...(p.refundedAt ? [['Refunded', `${dateTime(p.refundedAt)} · ${p.refundReason}`]] : []),
            ].map(([k, v]) => <div key={k} className="flex justify-between gap-3 px-3 py-2"><dt className="text-muted">{k}</dt><dd className="text-right font-medium text-ink">{v}</dd></div>)}
          </dl>
          <div className="flex flex-wrap gap-2">
            {p.receipt && can('receipts.read') && <Button variant="secondary" icon={Receipt} onClick={() => setReceipt(true)}>View receipt</Button>}
            {p.status === 'SUCCESS' && can('payments.refund') && <Button variant="danger" icon={Undo2} onClick={() => setRefundOpen(true)}>Refund</Button>}
            {p.status === 'PENDING' && p.isSimulated && can('payments.create') && (
              <>
                <Button loading={busy} onClick={() => act(() => post(`/payments/${p.id}/simulate-callback`, { status: 'SUCCESS' }), 'Simulated approval processed')}>Simulate approval</Button>
                <Button variant="secondary" loading={busy} onClick={() => act(() => post(`/payments/${p.id}/simulate-callback`, { status: 'FAILED' }), 'Simulated decline processed')}>Simulate decline</Button>
              </>
            )}
          </div>
        </div>
      )}
      <Modal open={refundOpen} onClose={() => setRefundOpen(false)} title="Refund payment" size="sm"
        footer={<><Button variant="ghost" onClick={() => setRefundOpen(false)}>Back</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={() => act(() => post(`/payments/${id}/refund`, { reason: reason.trim() }), 'Payment refunded')}>Refund</Button></>}>
        <p className="mb-3 text-sm text-muted">The refund is recorded with your name. Mobile money refunds may also need to be completed with the provider.</p>
        <Textarea label="Reason (min. 5 characters)" required value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
      {receipt && <ReceiptModal paymentId={id} onClose={() => setReceipt(false)} />}
    </Modal>
  );
}

function Transactions() {
  const { can } = useAuth();
  const { toast } = useUi();
  const [sp] = useSearchParams();
  const [q, setQ] = useState({ page: 1, search: '', status: sp.get('status') || '', method: '', facilityId: '', from: '', to: '' });
  const [open, setOpen] = useState(null);
  const params = useMemo(() => Object.fromEntries(Object.entries({ ...q, limit: 15 }).filter(([, v]) => v !== '')), [q]);
  const { data, meta, loading, error, reload } = useFetch(() => get('/payments', params), [JSON.stringify(params)]);
  useSocketEvent('payment:update', () => reload(true));
  const set = (p) => setQ((s) => ({ ...s, page: 1, ...p }));
  const exportCsv = async () => { try { await download('/payments', { ...params, format: 'csv', page: undefined, limit: undefined }, 'payments.csv'); } catch (e) { toast(parseError(e).message, 'error'); } };

  return (
    <>
      <Card padded={false}>
        <FilterBar>
          <SearchBox value={q.search} onChange={(search) => set({ search })} placeholder="Reference or plate..." className="min-w-[200px] flex-1 sm:max-w-xs" />
          <FacilityFilter value={q.facilityId} onChange={(facilityId) => set({ facilityId })} />
          <FilterSelect label="Status" value={q.status} onChange={(status) => set({ status })} placeholder="All statuses" options={['PENDING', 'SUCCESS', 'FAILED', 'REFUNDED'].map((v) => ({ value: v, label: titleCase(v) }))} />
          <FilterSelect label="Method" value={q.method} onChange={(method) => set({ method })} placeholder="All methods" options={[{ value: 'CASH', label: 'Cash' }, { value: 'MOBILE_MONEY', label: 'Mobile money' }, { value: 'BANK', label: 'Bank' }]} />
          <input type="date" aria-label="From date" value={q.from} onChange={(e) => set({ from: e.target.value })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
          <input type="date" aria-label="To date" value={q.to} onChange={(e) => set({ to: e.target.value })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
          {can('export') && <Button variant="secondary" icon={Download} onClick={exportCsv} className="ml-auto">Export CSV</Button>}
        </FilterBar>
        <DataTable loading={loading} error={error} onRetry={reload} rows={data} meta={meta} onPage={(page) => setQ((s) => ({ ...s, page }))} onRowClick={(r) => setOpen(r.id)}
          columns={[
            { key: 'reference', label: 'Reference', render: (r) => <span className="font-mono text-xs">{r.reference}</span> },
            { key: 'plate', label: 'Vehicle', render: (r) => (r.session ? displayPlate(r.session.plate) : '-') },
            { key: 'method', label: 'Method', render: (r) => <span>{titleCase(r.method)}{r.isSimulated && <> <SimulatedBadge /></>}</span> },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => <b className="text-ink">{money(r.amount, r.currency)}</b> },
            { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'createdAt', label: 'Created', render: (r) => dateTime(r.createdAt) },
          ]} />
      </Card>
      {open && <PaymentDetail id={open} onClose={() => setOpen(null)} onChanged={() => reload(true)} />}
    </>
  );
}

function Reconciliation() {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [facilityId, setFacilityId] = useState('');
  const { data, loading, error, reload } = useFetch(() => get('/payments/reconciliation/summary', { date, facilityId: facilityId || undefined }), [date, facilityId]);

  const close = async () => {
    if (!(await confirm({ title: `Close ${date}?`, message: 'All successful payments of the day are marked reconciled. Pending payments must be resolved first.', confirmLabel: 'Mark reconciled' }))) return;
    try { const { data: r } = await post('/payments/reconciliation/close', { date, facilityId: facilityId || undefined }); toast(`${r.reconciled} payments reconciled`); reload(); }
    catch (e) { toast(parseError(e).message, 'error'); }
  };
  const total = (data?.rows || []).filter((r) => r.status === 'SUCCESS').reduce((a, r) => a + Number(r.amount), 0);

  return (
    <Card title="Daily reconciliation" subtitle="Compare what the system recorded with cash counted and provider statements."
      actions={<><input type="date" aria-label="Date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" /><FacilityFilter value={facilityId} onChange={setFacilityId} /></>}>
      {loading && !data ? <Skeleton className="h-32" /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <div className="space-y-4">
          <DataTable dense rows={data.rows.map((r, i) => ({ ...r, id: i }))}
            columns={[
              { key: 'method', label: 'Method', render: (r) => titleCase(r.method) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'count', label: 'Payments', align: 'right' }, { key: 'amount', label: 'Amount', align: 'right', render: (r) => <b>{money(r.amount)}</b> },
            ]} />
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted">Successful total <b className="text-ink">{money(total)}</b> · {data.unreconciled} not yet reconciled · {data.pending} pending</p>
            {can('payments.reconcile') && <Button disabled={!data.unreconciled} onClick={close}>Mark day reconciled</Button>}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function PaymentsPage() {
  const [tab, setTab] = useState('transactions');
  return (
    <>
      <PageHeader title="Finance" description="Payments, refunds, receipts and daily reconciliation. Electronic payments are confirmed only by the provider's verified callback." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'transactions', label: 'Transactions' }, { value: 'reconciliation', label: 'Daily reconciliation' }]} />
      {tab === 'transactions' ? <Transactions /> : <Reconciliation />}
    </>
  );
}
