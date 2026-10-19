import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { AppError, badRequest } from '../utils/errors.js';

const PERIODS = { day: 'day', week: 'week', month: 'month' };
const n = (v) => Number(v ?? 0);

// Each report returns { columns, rows, summary } so the UI table, chart and CSV export share one source.
// `permission` is checked by the route; finance reports need reports.finance.
export const REPORTS = {
  revenue: {
    title: 'Revenue', permission: 'reports.finance',
    async run({ from, to, facilityId, period = 'day' }) {
      const unit = PERIODS[period];
      if (!unit) throw badRequest('period must be day, week or month');
      const rows = await prisma.$queryRaw`
        SELECT to_char(date_trunc(${unit}, ("paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Kigali'), 'YYYY-MM-DD') AS period,
               SUM(amount) AS revenue, COUNT(*)::int AS payments,
               SUM(amount) FILTER (WHERE method = 'CASH') AS cash,
               SUM(amount) FILTER (WHERE method = 'MOBILE_MONEY') AS mobile_money
        FROM "Payment"
        WHERE status = 'SUCCESS' AND "paidAt" BETWEEN ${from} AND ${to}
        ${facilityId ? Prisma.sql`AND "facilityId" = ${facilityId}` : Prisma.empty}
        GROUP BY 1 ORDER BY 1`;
      const data = rows.map((r) => ({ period: r.period, revenue: n(r.revenue), payments: r.payments, cash: n(r.cash), mobile_money: n(r.mobile_money) }));
      return {
        columns: ['period', 'revenue', 'payments', 'cash', 'mobile_money'], rows: data,
        summary: { totalRevenue: data.reduce((a, r) => a + r.revenue, 0), payments: data.reduce((a, r) => a + r.payments, 0) },
        chart: { type: 'bar', x: 'period', series: ['revenue'] },
      };
    },
  },

  occupancy: {
    title: 'Occupancy', permission: 'reports.read',
    async run({ facilityId }) {
      const spaces = await prisma.parkingSpace.groupBy({ by: ['facilityId', 'status'], where: { archivedAt: null, ...(facilityId ? { facilityId } : {}) }, _count: true });
      const facilities = await prisma.parkingFacility.findMany({ where: facilityId ? { id: facilityId } : {}, select: { id: true, name: true } });
      const rows = facilities.map((f) => {
        const c = Object.fromEntries(spaces.filter((s) => s.facilityId === f.id).map((s) => [s.status, s._count]));
        const total = Object.values(c).reduce((a, b) => a + b, 0);
        const usable = total - (c.OUT_OF_SERVICE || 0);
        return { facility: f.name, total, occupied: c.OCCUPIED || 0, available: c.AVAILABLE || 0, reserved: c.RESERVED || 0, out_of_service: c.OUT_OF_SERVICE || 0, occupancy_pct: usable ? Math.round(((c.OCCUPIED || 0) / usable) * 100) : 0 };
      });
      return { columns: ['facility', 'total', 'occupied', 'available', 'reserved', 'out_of_service', 'occupancy_pct'], rows, summary: {}, chart: { type: 'bar', x: 'facility', series: ['occupied', 'available'] } };
    },
  },

  'entry-exit-log': {
    title: 'Vehicle entry and exit log', permission: 'reports.read',
    async run({ from, to, facilityId }) {
      const sessions = await prisma.parkingSession.findMany({
        where: { entryAt: { gte: from, lte: to }, ...(facilityId ? { facilityId } : {}) },
        orderBy: { entryAt: 'desc' }, take: 5000, include: { facility: { select: { name: true } }, space: { select: { code: true } } },
      });
      const rows = sessions.map((s) => ({ ticket: s.ticketNo, plate: s.plate, facility: s.facility.name, space: s.space?.code ?? '', vehicle_type: s.vehicleType, entry_at: s.entryAt, exit_at: s.exitAt ?? '', status: s.status, minutes: s.durationMinutes ?? '' }));
      return { columns: ['ticket', 'plate', 'facility', 'space', 'vehicle_type', 'entry_at', 'exit_at', 'status', 'minutes'], rows, summary: { sessions: rows.length } };
    },
  },

  duration: {
    title: 'Parking duration', permission: 'reports.read',
    async run({ from, to, facilityId }) {
      const rows = await prisma.$queryRaw`
        SELECT CASE WHEN "durationMinutes" < 60 THEN '< 1 hour'
                    WHEN "durationMinutes" < 180 THEN '1-3 hours'
                    WHEN "durationMinutes" < 480 THEN '3-8 hours'
                    WHEN "durationMinutes" < 1440 THEN '8-24 hours'
                    ELSE '> 24 hours' END AS bucket,
               COUNT(*)::int AS sessions, ROUND(AVG("durationMinutes"))::int AS avg_minutes
        FROM "ParkingSession"
        WHERE status = 'COMPLETED' AND "exitAt" BETWEEN ${from} AND ${to} AND "durationMinutes" IS NOT NULL
        ${facilityId ? Prisma.sql`AND "facilityId" = ${facilityId}` : Prisma.empty}
        GROUP BY 1 ORDER BY MIN("durationMinutes")`;
      const total = rows.reduce((a, r) => a + r.sessions, 0);
      return { columns: ['bucket', 'sessions', 'avg_minutes'], rows, summary: { completedSessions: total }, chart: { type: 'bar', x: 'bucket', series: ['sessions'] } };
    },
  },

  payments: {
    title: 'Payment methods and status', permission: 'reports.finance',
    async run({ from, to, facilityId }) {
      const groups = await prisma.payment.groupBy({
        by: ['method', 'status'], where: { createdAt: { gte: from, lte: to }, ...(facilityId ? { facilityId } : {}) },
        _sum: { amount: true }, _count: true,
      });
      const rows = groups.map((g) => ({ method: g.method, status: g.status, count: g._count, amount: n(g._sum.amount) }));
      return { columns: ['method', 'status', 'count', 'amount'], rows, summary: {} };
    },
  },

  outstanding: {
    title: 'Outstanding balances', permission: 'reports.finance',
    async run({ facilityId }) {
      const rows = await prisma.$queryRaw`
        SELECT "ticketNo" AS ticket, plate, status::text AS status, "exitAt" AS exit_at,
               total, "amountPaid" AS paid, (total - "amountPaid") AS balance
        FROM "ParkingSession"
        WHERE status = 'COMPLETED' AND total > "amountPaid"
        ${facilityId ? Prisma.sql`AND "facilityId" = ${facilityId}` : Prisma.empty}
        ORDER BY "exitAt" DESC LIMIT 2000`;
      const data = rows.map((r) => ({ ...r, total: n(r.total), paid: n(r.paid), balance: n(r.balance) }));
      return { columns: ['ticket', 'plate', 'status', 'exit_at', 'total', 'paid', 'balance'], rows: data, summary: { totalOutstanding: data.reduce((a, r) => a + r.balance, 0), sessions: data.length } };
    },
  },

  gates: {
    title: 'Gate and camera performance', permission: 'reports.read',
    async run({ from, to, facilityId }) {
      const events = await prisma.gateEvent.groupBy({
        by: ['gateId', 'outcome'], where: { createdAt: { gte: from, lte: to }, ...(facilityId ? { gate: { facilityId } } : {}) }, _count: true,
      });
      const gates = await prisma.gate.findMany({ where: facilityId ? { facilityId } : {}, include: { facility: { select: { name: true } } } });
      const rows = gates.map((g) => {
        const c = (o) => events.find((e) => e.gateId === g.id && e.outcome === o)?._count ?? 0;
        return { gate: g.name, facility: g.facility.name, direction: g.direction, status: g.status, granted: c('GRANTED'), denied: c('DENIED'), acknowledged: c('ACKNOWLEDGED'), failed: c('FAILED') };
      });
      const rec = await prisma.recognitionEvent.groupBy({ by: ['status'], where: { createdAt: { gte: from, lte: to }, ...(facilityId ? { facilityId } : {}) }, _count: true });
      return { columns: ['gate', 'facility', 'direction', 'status', 'granted', 'denied', 'acknowledged', 'failed'], rows, summary: { recognition: Object.fromEntries(rec.map((r) => [r.status, r._count])) } };
    },
  },

  reservations: {
    title: 'Reservations and permits', permission: 'reports.read',
    async run({ from, to, facilityId }) {
      const [res, perm] = await Promise.all([
        prisma.reservation.groupBy({ by: ['status'], where: { startAt: { gte: from, lte: to }, ...(facilityId ? { facilityId } : {}) }, _count: true }),
        prisma.parkingPermit.groupBy({ by: ['status'], where: { ...(facilityId ? { facilityId } : {}) }, _count: true }),
      ]);
      const rows = [
        ...res.map((r) => ({ kind: 'Reservation', status: r.status, count: r._count })),
        ...perm.map((r) => ({ kind: 'Permit', status: r.status, count: r._count })),
      ];
      return { columns: ['kind', 'status', 'count'], rows, summary: {} };
    },
  },

  staff: {
    title: 'Staff activity', permission: 'audit.read',
    async run({ from, to }) {
      const groups = await prisma.auditLog.groupBy({
        by: ['actorEmail', 'action'], where: { createdAt: { gte: from, lte: to }, actorId: { not: null } }, _count: true, orderBy: { _count: { action: 'desc' } }, take: 500,
      });
      return { columns: ['staff', 'action', 'count'], rows: groups.map((g) => ({ staff: g.actorEmail, action: g.action, count: g._count })), summary: {} };
    },
  },
};

export async function runReport(type, params) {
  const def = REPORTS[type];
  if (!def) throw new AppError(404, 'NOT_FOUND', `Unknown report "${type}"`);
  return { type, title: def.title, ...(await def.run(params)) };
}
