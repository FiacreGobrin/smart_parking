import { useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Banknote, Car, CircleParking, Clock, ShieldAlert } from 'lucide-react';
import { BarsChart, OccupancyBar } from '../components/charts/Charts.jsx';
import { Card, PageHeader, StatCard } from '../components/ui/Card.jsx';
import { StatusBadge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States.jsx';
import { FacilityFilter } from '../components/ui/Filters.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { useSocketEvent } from '../hooks/useSocketEvent.js';
import { get } from '../services/api.js';
import { displayPlate, money, num, timeAgo } from '../utils/format.js';

export default function Dashboard() {
  const { can, user } = useAuth();
  const [facilityId, setFacilityId] = useState('');
  const params = facilityId ? { facilityId } : {};
  const finance = can('reports.finance');

  // 30 s polling is the fallback; Socket.IO events trigger an immediate silent refresh.
  const summary = useFetch(() => get('/dashboard/summary', params), [facilityId], { pollMs: 30000 });
  const occupancy = useFetch(() => get('/dashboard/occupancy', params), [facilityId], { pollMs: 60000 });
  const revenue = useFetch(() => (finance ? get('/dashboard/revenue', { ...params, days: 14 }) : Promise.resolve({ data: [] })), [facilityId, finance]);
  const activity = useFetch(() => get('/dashboard/recent-activity', params), [facilityId], { pollMs: 30000 });

  const refreshAll = () => { summary.reload(true); occupancy.reload(true); activity.reload(true); };
  useSocketEvent('occupancy:update', refreshAll);
  useSocketEvent('session:entry', refreshAll);
  useSocketEvent('session:exit', refreshAll);
  useSocketEvent('payment:update', () => { summary.reload(true); revenue.reload(true); });

  const s = summary.data;
  const sp = s?.spaces;
  const loading = summary.loading && !s;

  return (
    <>
      <PageHeader title="Dashboard" description={`Welcome back, ${user.name.split(' ')[0]}. Live occupancy, traffic and revenue from the database.`}
        actions={<FacilityFilter value={facilityId} onChange={setFacilityId} />} />

      {summary.error && <Card><ErrorState error={summary.error} onRetry={summary.reload} /></Card>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total spaces" value={num(sp?.total)} hint={sp ? `${sp.outOfService} out of service` : ''} icon={CircleParking} tone="blue" loading={loading} />
        <StatCard label="Occupied" value={num(sp?.occupied)} hint={s ? `${s.occupancyPct}% occupancy` : ''} icon={Car} tone="teal" loading={loading} />
        <StatCard label="Available" value={num(sp?.available)} hint={sp ? `${sp.reserved} reserved` : ''} icon={CircleParking} tone="green" loading={loading} />
        <StatCard label="Vehicles parked" value={num(s?.vehiclesParked)} icon={Clock} tone="blue" loading={loading} />
        <StatCard label="Entries today" value={num(s?.entriesToday)} icon={ArrowDownToLine} tone="teal" loading={loading} />
        <StatCard label="Exits today" value={num(s?.exitsToday)} icon={ArrowUpFromLine} tone="amber" loading={loading} />
        {finance && <StatCard label="Revenue today" value={money(s?.revenueToday)} hint={s ? `${s.paymentsToday} payments` : ''} icon={Banknote} tone="green" loading={loading} to="/finance" />}
        {finance && (
          <StatCard label="Outstanding / failed" value={money(s?.outstanding?.amount)} icon={AlertTriangle} tone={s?.outstanding?.count || s?.failedPaymentsToday ? 'red' : 'green'} loading={loading}
            hint={s ? `${s.outstanding.count} unpaid sessions · ${s.failedPaymentsToday} failed today · ${s.pendingPayments} pending` : ''} to="/finance" />
        )}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card title="Entries and exits" subtitle="Last 24 hours (Kigali time)" className="xl:col-span-2">
          {occupancy.loading && !occupancy.data ? <Skeleton className="h-64 w-full" />
            : occupancy.error ? <ErrorState error={occupancy.error} onRetry={occupancy.reload} />
              : <BarsChart data={occupancy.data.hourly} xKey="hour" series={[{ key: 'entries', name: 'Entries' }, { key: 'exits', name: 'Exits' }]} />}
        </Card>

        <Card title="Occupancy by facility">
          {loading ? <Skeleton className="h-40 w-full" /> : !s?.byFacility?.length ? <EmptyState title="No facilities" description="Create a facility to start tracking occupancy." /> : (
            <ul className="space-y-4">
              {s.byFacility.map((f) => (
                <li key={f.id}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">{f.name}</span>
                    <span className="text-xs text-muted">{f.occupied}/{f.total - f.outOfService} · {f.occupancyPct}%</span>
                  </div>
                  <OccupancyBar pct={f.occupancyPct} />
                  <p className="mt-1 text-xs text-muted">{f.available} available · {f.reserved} reserved{f.outOfService ? ` · ${f.outOfService} out of service` : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {finance && (
          <Card title="Revenue" subtitle="Last 14 days, successful payments" className="xl:col-span-2">
            {revenue.loading && !revenue.data ? <Skeleton className="h-64 w-full" />
              : revenue.error ? <ErrorState error={revenue.error} onRetry={revenue.reload} />
                : <BarsChart data={revenue.data.map((r) => ({ ...r, day: r.day.slice(5) }))} xKey="day" series={[{ key: 'revenue', name: 'Revenue (RWF)' }]} format={(v) => num(v)} />}
          </Card>
        )}
        <Card title="Recent activity" className={finance ? '' : 'xl:col-span-3'} padded={false}>
          {activity.loading && !activity.data ? <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
            : activity.error ? <ErrorState error={activity.error} onRetry={activity.reload} />
              : !activity.data.length ? <EmptyState title="No activity yet" description="Entries and exits will appear here as they happen." icon={ShieldAlert} />
                : (
                  <ul className="divide-y divide-line">
                    {activity.data.map((a) => (
                      <li key={`${a.id}-${a.type}`} className="flex items-center gap-3 px-5 py-2.5">
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${a.type === 'ENTRY' ? 'bg-primary-soft text-primary' : 'bg-warning-soft text-warning'}`}>
                          {a.type === 'ENTRY' ? <ArrowDownToLine className="h-4 w-4" aria-hidden /> : <ArrowUpFromLine className="h-4 w-4" aria-hidden />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">{displayPlate(a.plate)}</p>
                          <p className="truncate text-xs text-muted">{a.facility}{a.space ? ` · ${a.space}` : ''}</p>
                        </div>
                        <div className="text-right">
                          <StatusBadge status={a.type === 'ENTRY' ? 'ACTIVE' : a.type === 'EXIT' ? 'COMPLETED' : 'CANCELLED'} />
                          <p className="mt-0.5 text-[11px] text-muted">{timeAgo(a.at)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
        </Card>
      </div>
    </>
  );
}
