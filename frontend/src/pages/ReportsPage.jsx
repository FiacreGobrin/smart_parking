import { useEffect, useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { BarsChart } from '../components/charts/Charts.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { Select } from '../components/ui/Fields.jsx';
import { FacilityFilter } from '../components/ui/Filters.jsx';
import { ErrorState, Skeleton } from '../components/ui/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { download, get, parseError } from '../services/api.js';
import { dateTime, money, num, titleCase } from '../utils/format.js';

const iso = (d) => d.toISOString().slice(0, 10);
const MONEY_COLS = new Set(['revenue', 'cash', 'mobile_money', 'amount', 'total', 'paid', 'balance']);
const fmtCell = (col, v) => {
  if (v == null || v === '') return '-';
  if (MONEY_COLS.has(col)) return money(v);
  if (/(_at|^time$)/.test(col) && !Number.isNaN(Date.parse(v))) return dateTime(v);
  return typeof v === 'number' ? num(v) : String(v);
};

export default function ReportsPage() {
  const { can } = useAuth();
  const { toast } = useUi();
  const list = useFetch(() => get('/reports'), []);
  const [type, setType] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [period, setPeriod] = useState('day');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(iso(new Date()));

  useEffect(() => { if (!type && list.data?.length) setType(list.data[0].key); }, [list.data, type]);
  const params = useMemo(() => ({ from, to, facilityId: facilityId || undefined, period: type === 'revenue' ? period : undefined }), [from, to, facilityId, period, type]);
  const report = useFetch(() => (type ? get(`/reports/${type}`, params) : Promise.resolve({ data: null })), [type, JSON.stringify(params)]);
  const r = report.data;

  const exportCsv = async () => { try { await download(`/reports/${type}`, { ...params, format: 'csv' }, `${type}-report.csv`); } catch (e) { toast(parseError(e).message, 'error'); } };
  const rangeless = ['occupancy', 'outstanding'].includes(type);

  const columns = (r?.columns || []).map((c) => ({ key: c, label: titleCase(c), align: MONEY_COLS.has(c) ? 'right' : undefined, render: (row) => fmtCell(c, row[c]) }));
  const rows = (r?.rows || []).map((row, i) => ({ ...row, _id: i }));

  return (
    <>
      <PageHeader title="Statistics" description="Revenue, occupancy, entries and exits for any period. Print or export to CSV. Money reports need finance access."
        actions={<><Button variant="secondary" icon={Printer} onClick={() => window.print()} disabled={!r}>Print</Button>{can('export') && <Button icon={Download} onClick={exportCsv} disabled={!r}>Export CSV</Button>}</>} />

      <Card className="mb-4 no-print">
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Report" value={type} onChange={(e) => setType(e.target.value)} options={(list.data || []).map((x) => ({ value: x.key, label: x.title }))} className="min-w-[220px]" />
          {!rangeless && (
            <>
              <div><label htmlFor="r-from" className="mb-1 block text-xs font-medium text-ink">From</label><input id="r-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" /></div>
              <div><label htmlFor="r-to" className="mb-1 block text-xs font-medium text-ink">To</label><input id="r-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" /></div>
            </>
          )}
          {type === 'revenue' && <Select label="Group by" value={period} onChange={(e) => setPeriod(e.target.value)} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />}
          <div className="pb-0.5"><FacilityFilter value={facilityId} onChange={setFacilityId} /></div>
        </div>
      </Card>

      {report.error ? <Card><ErrorState error={report.error} onRetry={report.reload} /></Card> : report.loading && !r ? <Card><Skeleton className="h-64" /></Card> : r && (
        <div className="space-y-4">
          <div className="hidden print-only"><h2 className="text-lg font-semibold">{r.title}</h2><p className="text-sm">{rangeless ? 'Current position' : `${from} to ${to}`} · generated {dateTime(new Date())}</p></div>
          {Object.keys(r.summary || {}).length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {Object.entries(r.summary).filter(([, v]) => typeof v !== 'object').map(([k, v]) => (
                <div key={k} className="rounded-2xl border border-line bg-surface p-4 shadow-card"><p className="text-xs uppercase tracking-wide text-muted">{titleCase(k.replace(/([A-Z])/g, ' $1'))}</p><p className="mt-1 text-xl font-semibold text-ink">{/revenue|outstanding/i.test(k) ? money(v) : num(v)}</p></div>
              ))}
            </div>
          )}
          {r.chart && rows.length > 0 && (
            <Card title={r.title}><BarsChart data={rows} xKey={r.chart.x} series={r.chart.series.map((k) => ({ key: k, name: titleCase(k) }))} format={r.chart.series.some((k) => MONEY_COLS.has(k)) ? (v) => num(v) : undefined} /></Card>
          )}
          <Card title="Data" subtitle={`${rows.length} rows`} padded={false}>
            <DataTable dense rowKey="_id" columns={columns} rows={rows} />
          </Card>
        </div>
      )}
    </>
  );
}
