import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { num } from '../../utils/format.js';

// Validated categorical pair (light and dark): blue = first series, amber = second. Never reused for status.
export const SERIES = ['#2f5fe8', '#d97706'];

const axis = { stroke: 'var(--ink-muted)', fontSize: 11, tickLine: false, axisLine: false };

function TooltipBox({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-card">
      <p className="mb-1 font-medium text-ink">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-muted">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color || p.fill }} aria-hidden />
          {p.name}: <span className="font-medium text-ink">{format ? format(p.value) : num(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

const legend = { iconType: 'circle', iconSize: 8, wrapperStyle: { fontSize: 12, color: 'var(--ink-muted)' } };

/** Bars for one or two series. `series`: [{ key, name }]. Table fallback below for screen readers. */
export function BarsChart({ data, xKey, series, height = 260, format, stacked = false }) {
  return (
    <>
      <div style={{ height }} role="img" aria-label={`Bar chart of ${series.map((s) => s.name).join(' and ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} barGap={2}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} {...axis} interval="preserveStartEnd" />
            <YAxis {...axis} width={48} tickFormatter={(v) => (format ? format(v) : num(v))} allowDecimals={false} />
            <Tooltip content={<TooltipBox format={format} />} cursor={{ fill: 'var(--surface-2)' }} />
            {series.length > 1 && <Legend {...legend} />}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.name} fill={SERIES[i]} radius={[4, 4, 0, 0]} maxBarSize={28}
                stackId={stacked ? 'a' : undefined} stroke="var(--surface)" strokeWidth={stacked ? 2 : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <DataTableFallback data={data} xKey={xKey} series={series} format={format} />
    </>
  );
}

export function LinesChart({ data, xKey, series, height = 260, format }) {
  return (
    <>
      <div style={{ height }} role="img" aria-label={`Line chart of ${series.map((s) => s.name).join(' and ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} {...axis} interval="preserveStartEnd" />
            <YAxis {...axis} width={48} tickFormatter={(v) => (format ? format(v) : num(v))} allowDecimals={false} />
            <Tooltip content={<TooltipBox format={format} />} />
            {series.length > 1 && <Legend {...legend} />}
            {series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i]} strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <DataTableFallback data={data} xKey={xKey} series={series} format={format} />
    </>
  );
}

// Charts are never the only way to read the numbers.
function DataTableFallback({ data, xKey, series, format }) {
  return (
    <details className="mt-2 text-xs text-muted no-print">
      <summary className="cursor-pointer select-none hover:text-ink">View as table</summary>
      <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-line">
        <table className="w-full text-left">
          <thead className="bg-surface-2"><tr><th className="px-3 py-1.5 font-medium">{xKey}</th>{series.map((s) => <th key={s.key} className="px-3 py-1.5 font-medium">{s.name}</th>)}</tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r[xKey]} className="border-t border-line">
                <td className="px-3 py-1">{r[xKey]}</td>
                {series.map((s) => <td key={s.key} className="px-3 py-1">{format ? format(r[s.key]) : num(r[s.key])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Horizontal progress bar for occupancy; colour shifts only at meaningful thresholds. */
export function OccupancyBar({ pct }) {
  const tone = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Occupancy">
      <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}
