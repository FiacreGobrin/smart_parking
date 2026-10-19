import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, CircleCheck, Loader2, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { Input, Select } from '../components/ui/Fields.jsx';
import { LinkAction } from '../components/ui/PillTabs.jsx';
import { SimulatedBadge } from '../components/ui/Badge.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { useSocketEvent } from '../hooks/useSocketEvent.js';
import { get, http, parseError, post } from '../services/api.js';
import { dateOnly, displayPlate, duration, minutesSince, money, titleCase } from '../utils/format.js';

const SERVICES = [{ value: 'PARKING', label: 'Parking' }, { value: 'GARAGE', label: 'Garage' }, { value: 'CAR_WASH', label: 'Car wash' }];
const SERVICE_LABEL = { PARKING: 'Parking', GARAGE: 'Garage', CAR_WASH: 'Car wash' };
const GARAGE_UNITS = [{ value: 'DAY', label: 'Per day' }, { value: 'WEEK', label: 'Per week' }, { value: 'MONTH', label: 'Per month' }];
const VEHICLES = [{ value: 'CAR', label: 'Car' }, { value: 'MOTORCYCLE', label: 'Motorbike' }, { value: 'BUS', label: 'Bus' }, { value: 'TRUCK', label: 'Truck' }];

// Payment choices from the design. Colours are the brand dots shown next to each provider.
const METHODS = [
  { id: 'mtn-momo', label: 'MTN MoMo', method: 'MOBILE_MONEY', dot: '#ffcc00', phone: 'MoMo phone number' },
  { id: 'airtel-money', label: 'Airtel Money', method: 'MOBILE_MONEY', dot: '#e4132b', phone: 'Airtel Money phone number' },
  { id: 'equity-bank', label: 'Equity Bank', method: 'BANK', dot: '#8b1a35', phone: 'Equity phone number' },
  { id: 'cash', label: 'Cash', method: 'CASH', dot: '#8d97ad', phone: null },
];

/** The phone-style card used by every step: blue title band, light body. */
function PhoneCard({ title, children }) {
  return (
    <div className="mx-auto w-full max-w-[420px] overflow-hidden rounded-[32px] border border-line bg-bg shadow-card">
      <div className="bg-primary px-7 pb-6 pt-8"><h2 className="text-2xl font-bold text-white">{title}</h2></div>
      <div className="space-y-4 px-5 py-5">{children}</div>
    </div>
  );
}

const BigButton = ({ variant = 'primary', className, ...rest }) => <Button variant={variant} size="lg" className={clsx('h-[52px] w-full rounded-2xl text-base', className)} {...rest} />;

// ---------------------------------------------------------------- Step 1: scan the plate
function ScanStep({ facilityId, onPlate }) {
  const { toast } = useUi();
  const [mode, setMode] = useState('camera');
  const [plate, setPlate] = useState('');
  const [camError, setCamError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState('');
  const video = useRef(null);
  const stream = useRef(null);

  useEffect(() => {
    if (mode !== 'camera') return undefined;
    let cancelled = false;
    setCamError('');
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser or connection (HTTPS is required) cannot open the camera.');
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) video.current.srcObject = s;
      } catch (e) {
        setCamError(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser or write the plate manually.' : e.message || 'The camera is not available.');
      }
    })();
    return () => { cancelled = true; stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  }, [mode]);

  const take = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) { toast('The camera is not ready yet', 'warning'); return; }
    setScanning(true); setNote('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      canvas.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      const form = new FormData();
      form.append('image', blob, 'plate.jpg');
      if (facilityId) form.append('facilityId', facilityId);
      const { data, meta } = await http.post('/anpr/scan', form).then((r) => r.data);
      if (data.event.plate) {
        setPlate(displayPlate(data.event.plate));
        setNote(`Read ${displayPlate(data.event.plate)}${data.event.confidence != null ? ` (${Math.round(data.event.confidence * 100)}% sure)` : ''}. Check it, then confirm.`);
      } else {
        setNote(meta?.simulated ? 'Simulation mode: the server does not read photos, so type the plate below.' : 'The plate could not be read. Try again or type it below.');
      }
    } catch (e) {
      setNote(parseError(e).message);
    } finally { setScanning(false); }
  };

  const confirm = () => {
    if (plate.replace(/[^a-z0-9]/gi, '').length < 3) { setNote('Enter at least 3 letters or digits.'); return; }
    onPlate(plate.trim());
  };

  return (
    <PhoneCard title="Scan Plate">
      <div className="flex gap-3" role="tablist" aria-label="How to enter the plate">
        {[['camera', 'Phone camera'], ['manual', 'Write manually']].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={mode === id} onClick={() => setMode(id)}
            className={clsx('flex-1 rounded-full border px-4 py-3 text-sm font-bold transition-colors', mode === id ? 'border-primary bg-primary text-white' : 'border-line bg-surface text-ink')}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'camera' && (
        <>
          <div className="relative flex h-[230px] items-center justify-center overflow-hidden rounded-3xl bg-[#171d33]">
            <video ref={video} autoPlay playsInline muted className={clsx('absolute inset-0 h-full w-full object-cover', camError && 'hidden')} />
            <div className="relative z-10 flex h-[110px] w-[230px] items-center justify-center rounded-md border border-white/70 bg-black/30">
              {camError || scanning ? <Loader2 className={clsx('h-7 w-7 text-white', scanning && 'animate-spin')} aria-hidden /> : <span className="text-[40px] font-bold tracking-wide text-white/90">{plate ? '' : 'AB123'}</span>}
            </div>
          </div>
          {camError ? <p role="alert" className="text-center text-sm text-danger">{camError}</p> : <p className="text-center text-sm text-muted">Point the camera at the plate</p>}
          <BigButton icon={Camera} loading={scanning} disabled={!!camError} onClick={take}>Take photo</BigButton>
          <p className="text-center text-sm text-muted">or enter the plate manually</p>
        </>
      )}

      <Input label="Plate number" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="AB123" autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && confirm()} />
      {note && <p role="status" className="text-sm text-muted">{note}</p>}
      <BigButton variant="success" onClick={confirm}>Confirm plate</BigButton>
    </PhoneCard>
  );
}

// ---------------------------------------------------------------- Entry (no open session for this plate)
function EntryStep({ plate, facilityId, facilities, onDone, onBack }) {
  const { toast } = useUi();
  const [service, setService] = useState('PARKING');
  const [unit, setUnit] = useState('DAY');
  const [type, setType] = useState('CAR');
  const [fid, setFid] = useState(facilityId || '');
  // Use the user's facility, or the first one; the choice is only shown when several facilities exist.
  useEffect(() => { if (!fid && facilities?.length) setFid(facilities[0].id); }, [facilities]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await post('/parking/entry', { plate, vehicleType: type, service, facilityId: fid || undefined, billingUnit: service === 'GARAGE' ? unit : undefined });
      setResult(data);
      toast(`${displayPlate(data.plate)} registered`);
    } catch (e) { setError(parseError(e).message); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <PhoneCard title="Entry registered">
        <div className="rounded-3xl border border-line bg-surface p-5 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-solid text-white"><Check className="h-9 w-9" strokeWidth={3} aria-hidden /></span>
          <p className="mt-3 text-xl font-bold text-ink">{displayPlate(result.plate)}</p>
          <p className="text-sm text-muted">{SERVICE_LABEL[result.service]} · Ticket {result.ticketNo}{result.space ? ` · Space ${result.space.code}` : ''}</p>
        </div>
        <BigButton onClick={onDone}>Done</BigButton>
      </PhoneCard>
    );
  }
  return (
    <PhoneCard title="New vehicle">
      <div className="rounded-3xl border border-line bg-surface p-5">
        <p className="text-sm text-muted">No open session for this plate</p>
        <p className="mt-1 text-2xl font-bold text-ink">{displayPlate(plate)}</p>
      </div>
      <Select label="Service" options={SERVICES} value={service} onChange={(e) => setService(e.target.value)} />
      {service === 'GARAGE' && <Select label="Billing unit" options={GARAGE_UNITS} value={unit} onChange={(e) => setUnit(e.target.value)} />}
      <Select label="Vehicle type" options={VEHICLES} value={type} onChange={(e) => setType(e.target.value)} />
      {!facilityId && (facilities?.length ?? 0) > 1 && <Select label="Facility" options={facilities.map((f) => ({ value: f.id, label: f.name }))} value={fid} onChange={(e) => setFid(e.target.value)} />}
      {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      <BigButton variant="success" loading={busy} onClick={submit}>Register entry</BigButton>
      <BigButton variant="outline" onClick={onBack}>Back</BigButton>
    </PhoneCard>
  );
}

// ---------------------------------------------------------------- Step 2: payment
function PaymentStep({ quote, onPaid, onBack, onExit }) {
  const { toast } = useUi();
  const { can } = useAuth();
  const [methodId, setMethodId] = useState('mtn-momo');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const key = useRef(null);
  const method = METHODS.find((m) => m.id === methodId);
  const due = Number(quote.balanceDue);
  const s = quote.session;

  const finish = useCallback((paymentId) => onPaid(paymentId), [onPaid]);

  // Poll while waiting for the provider; the socket event below makes it instant when available.
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(async () => {
      try { const { data } = await get(`/payments/${pending.id}`); if (data.status === 'SUCCESS') finish(data.id); else if (data.status === 'FAILED') { setPending(null); toast(`Payment failed${data.failureReason ? `: ${data.failureReason}` : ''}`, 'error'); } } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent('payment:update', async (p) => {
    if (!pending || p.id !== pending.id) return;
    if (p.status === 'SUCCESS') finish(p.id); else if (p.status === 'FAILED') { setPending(null); toast('Payment failed', 'error'); }
  });

  const pay = async () => {
    if (method.method !== 'CASH' && !/^(250)?0?7\d{8}$/.test(phone.replace(/\D/g, ''))) { setPhoneError('Enter a valid phone number, e.g. +250 788 123 456'); return; }
    setPhoneError(''); setBusy(true);
    key.current ||= crypto.randomUUID(); // one key per attempt: a double tap can never charge twice
    try {
      const { data } = await post('/payments', {
        sessionId: s.id, method: method.method, provider: method.method === 'CASH' ? undefined : method.id,
        payerPhone: method.method === 'CASH' ? undefined : phone.replace(/\s/g, ''), idempotencyKey: key.current,
      });
      key.current = null;
      if (data.status === 'SUCCESS') finish(data.id); else setPending(data);
    } catch (e) { toast(parseError(e).message, 'error'); } finally { setBusy(false); }
  };

  const simulate = async (status) => {
    try { await post(`/payments/${pending.id}/simulate-callback`, { status }); } catch (e) { toast(parseError(e).message, 'error'); }
  };

  return (
    <PhoneCard title="Payment">
      <div className="rounded-3xl border border-line bg-surface p-5">
        <p className="text-sm text-muted">{displayPlate(s.plate)} · {SERVICE_LABEL[s.service]} · {duration(quote.fee.durationMinutes ?? minutesSince(s.entryAt))}</p>
        <p className="mt-1 text-[32px] font-bold leading-tight text-ink">{money(due || quote.total, quote.currency)}</p>
        {due === 0 && <p className="mt-1 text-sm text-success">Nothing left to pay.</p>}
      </div>

      {due === 0 ? (
        <BigButton variant="success" icon={LogOut} onClick={onExit}>Complete exit</BigButton>
      ) : pending ? (
        <div className="space-y-3 rounded-3xl border border-warning/40 bg-warning-soft p-5 text-sm text-warning" role="status">
          <p className="flex items-center gap-2 font-semibold"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Waiting for confirmation on the phone</p>
          <p>Reference {pending.reference}. It becomes paid only when {method.label} confirms it.</p>
          {pending.isSimulated && (
            <div className="space-y-2">
              <SimulatedBadge />
              <p className="text-xs">No real money moves. Use these to test the callback:</p>
              <div className="flex gap-2"><Button size="sm" onClick={() => simulate('SUCCESS')}>Simulate approval</Button><Button size="sm" variant="outline" onClick={() => simulate('FAILED')}>Simulate decline</Button></div>
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel and choose again</Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">Choose payment method</p>
          <div role="radiogroup" aria-label="Payment method" className="space-y-3">
            {METHODS.filter((m) => m.method !== 'CASH' || can('payments.create')).map((m) => (
              <button key={m.id} role="radio" aria-checked={methodId === m.id} onClick={() => setMethodId(m.id)}
                className={clsx('flex w-full items-center gap-4 rounded-2xl border bg-surface px-4 py-4 text-left transition-colors', methodId === m.id ? 'border-primary' : 'border-line')}>
                <span className="h-9 w-9 shrink-0 rounded-full" style={{ background: m.dot }} aria-hidden />
                <span className="flex-1 text-base font-semibold text-ink">{m.label}</span>
                <span className={clsx('flex h-6 w-6 items-center justify-center rounded-full border', methodId === m.id ? 'border-primary bg-primary' : 'border-line')}>{methodId === m.id && <span className="h-2 w-2 rounded-full bg-white" />}</span>
              </button>
            ))}
          </div>
          {method.phone && (
            <>
              <Input label={method.phone} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+250 78X XXX XXX" inputMode="tel" error={phoneError} autoComplete="off" />
              <p className="text-sm text-muted">You will confirm with your PIN on the phone.</p>
            </>
          )}
          <BigButton loading={busy} onClick={pay}>Pay {money(due, quote.currency)}</BigButton>
        </>
      )}
      <BigButton variant="outline" onClick={onBack}>Back</BigButton>
    </PhoneCard>
  );
}

// ---------------------------------------------------------------- Step 3: receipt
function ReceiptStep({ paymentId, sessionId, onDone }) {
  const { toast } = useUi();
  const { data: receipt, loading, error } = useFetch(() => get(`/payments/${paymentId}/receipt`), [paymentId]);
  const [busy, setBusy] = useState(false);
  const snap = receipt?.snapshot;

  // "Done" releases the vehicle: the paid session is closed and the space is freed.
  const done = async () => {
    setBusy(true);
    try { await post('/parking/exit', { sessionId }); toast('Vehicle released'); onDone(); }
    catch (e) { toast(parseError(e).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <PhoneCard title="Receipt">
      <div className="flex flex-col items-center pt-2">
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-success-solid text-white"><Check className="h-11 w-11" strokeWidth={3.5} aria-hidden /></span>
        <h3 className="mt-4 text-xl font-bold text-ink">Payment successful</h3>
        {snap?.simulated && <div className="mt-2"><SimulatedBadge /></div>}
      </div>
      {loading ? <div className="skeleton h-48 rounded-3xl" /> : error ? <p role="alert" className="text-center text-sm text-danger">{error.message}</p> : (
        <div className="print-area rounded-3xl border border-line bg-surface p-5">
          <dl className="space-y-3 text-[15px]">
            {[['Plate', displayPlate(snap.plate)], ['Service', SERVICE_LABEL[snap.service] || 'Parking'], ['Method', snap.methodLabel || titleCase(snap.method)], ['Reference', snap.reference], ['Date', dateOnly(snap.paidAt)]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{k}</dt><dd className="text-right font-bold text-ink">{v}</dd></div>
            ))}
            <div className="flex justify-between gap-4 pt-2"><dt className="text-muted">Amount</dt><dd className="text-right font-bold text-primary">{money(snap.amount, snap.currency)}</dd></div>
          </dl>
        </div>
      )}
      <BigButton loading={busy} onClick={done}>Done</BigButton>
      <button onClick={() => window.print()} className="mx-auto block text-sm font-semibold text-primary hover:underline no-print">Print receipt</button>
    </PhoneCard>
  );
}

// ---------------------------------------------------------------- the page
export default function OperationsPage() {
  const { user } = useAuth();
  const { toast } = useUi();
  const [step, setStep] = useState('scan');
  const [plate, setPlate] = useState('');
  const [quote, setQuote] = useState(null);
  const [paymentId, setPaymentId] = useState(null);
  const facilities = useFetch(() => get('/facilities', { limit: 50 }), []);
  const facilityId = user.facilityId || (facilities.data?.length === 1 ? facilities.data[0].id : '');
  const inside = useFetch(() => get('/parking/sessions', { status: 'ACTIVE', limit: 8, sortBy: 'entryAt', order: 'desc' }), [], { pollMs: 20000 });
  useSocketEvent('session:entry', () => inside.reload(true));
  useSocketEvent('session:exit', () => inside.reload(true));

  const reset = () => { setStep('scan'); setPlate(''); setQuote(null); setPaymentId(null); inside.reload(true); };

  const lookup = useCallback(async (p) => {
    setPlate(p);
    try {
      const { data } = await get('/parking/exit-preview', { plate: p });
      setQuote(data); setStep('pay');
    } catch (e) {
      const err = parseError(e);
      if (err.status === 404) setStep('entry'); else toast(err.message, 'error');
    }
  }, [toast]);

  const reload = async () => { if (quote) { const { data } = await get('/parking/exit-preview', { sessionId: quote.session.id }); setQuote(data); } };
  const completeExit = async () => {
    try { await post('/parking/exit', { sessionId: quote.session.id }); toast('Vehicle released'); reset(); } catch (e) { toast(parseError(e).message, 'error'); }
  };

  return (
    <>
      <PageHeader title="Operations" description="Scan or type a plate. New vehicles are registered; vehicles inside go to payment and receipt." />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        <div>
          {step === 'scan' && <ScanStep facilityId={facilityId} onPlate={lookup} />}
          {step === 'entry' && <EntryStep plate={plate} facilityId={facilityId} facilities={facilities.data} onDone={reset} onBack={reset} />}
          {step === 'pay' && quote && <PaymentStep quote={quote} onPaid={(id) => { setPaymentId(id); setStep('receipt'); }} onBack={reset} onExit={completeExit} key={quote.session.id + quote.balanceDue} />}
          {step === 'receipt' && <ReceiptStep paymentId={paymentId} sessionId={quote.session.id} onDone={reset} />}
        </div>
        <Card title="Vehicles inside" subtitle="Tap Pay to take a payment" className="self-start">
          <DataTable dense loading={inside.loading} error={inside.error} onRetry={inside.reload} rows={inside.data}
            columns={[
              { key: 'plate', label: 'Plate', render: (r) => <span className="font-mono font-semibold text-ink">{displayPlate(r.plate)}</span> },
              { key: 'service', label: 'Service', render: (r) => SERVICE_LABEL[r.service] },
              { key: 'entryAt', label: 'Inside', render: (r) => duration(minutesSince(r.entryAt)) },
              { key: '_a', label: '', render: (r) => <LinkAction onClick={() => { reset(); setTimeout(() => lookup(r.plate), 0); }}>Pay</LinkAction> },
            ]} />
        </Card>
      </div>
    </>
  );
}
