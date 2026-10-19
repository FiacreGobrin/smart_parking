import { Printer } from 'lucide-react';
import { Button } from '../components/ui/Button.jsx';
import { SimulatedBadge } from '../components/ui/Badge.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { ErrorState, Skeleton } from '../components/ui/States.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { get } from '../services/api.js';
import { dateTime, displayPlate, duration, money, titleCase } from '../utils/format.js';

function Row({ label, children }) {
  return <div className="flex justify-between gap-4 py-1"><dt className="text-muted">{label}</dt><dd className="text-right font-medium text-ink">{children}</dd></div>;
}

/** Printable receipt for a successful payment. */
export function ReceiptModal({ paymentId, onClose }) {
  const { data: receipt, loading, error, reload } = useFetch(() => get(`/payments/${paymentId}/receipt`), [paymentId]);
  const s = receipt?.snapshot;
  return (
    <Modal open onClose={onClose} title="Receipt" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button icon={Printer} onClick={() => window.print()} disabled={!s}>Print</Button></>}>
      {loading ? <div className="space-y-2"><Skeleton className="h-6" /><Skeleton className="h-32" /></div>
        : error ? <ErrorState error={error} onRetry={reload} />
          : (
            <div className="print-area font-mono text-xs">
              <div className="text-center">
                <p className="text-base font-bold text-ink">{s.organization || 'Smart Parking'}</p>
                {s.facility && <p className="text-muted">{s.facility}</p>}
                <p className="mt-1 text-muted">Receipt {receipt.number}</p>
                {s.simulated && <p className="mt-1"><SimulatedBadge /></p>}
              </div>
              <hr className="my-3 border-dashed border-line" />
              <dl>
                {s.plate && <Row label="Plate">{displayPlate(s.plate)}</Row>}
                {s.ticketNo && <Row label="Ticket">{s.ticketNo}</Row>}
                {s.permitNumber && <Row label="Permit">{s.permitNumber}</Row>}
                {s.space && <Row label="Space">{s.space}</Row>}
                {s.entryAt && <Row label="Entry">{dateTime(s.entryAt)}</Row>}
                {s.exitAt && <Row label="Exit">{dateTime(s.exitAt)}</Row>}
                {s.durationMinutes != null && <Row label="Duration">{duration(s.durationMinutes)}</Row>}
              </dl>
              {s.breakdown?.lines?.length > 0 && (
                <>
                  <hr className="my-3 border-dashed border-line" />
                  <ul className="space-y-1">
                    {s.breakdown.lines.map((l, i) => <li key={i} className="flex justify-between gap-3"><span className="text-muted">{l.label}</span><span className="text-ink">{money(l.amount, s.currency)}</span></li>)}
                  </ul>
                </>
              )}
              <hr className="my-3 border-dashed border-line" />
              <div className="flex justify-between text-sm font-bold text-ink"><span>PAID</span><span>{money(s.amount, s.currency)}</span></div>
              <dl className="mt-2">
                <Row label="Method">{titleCase(s.method)}</Row>
                <Row label="Reference">{s.reference}</Row>
                <Row label="Paid at">{dateTime(s.paidAt)}</Row>
                {s.cashier && <Row label="Served by">{s.cashier}</Row>}
              </dl>
              {s.footer && <p className="mt-4 text-center text-muted">{s.footer}</p>}
            </div>
          )}
    </Modal>
  );
}
