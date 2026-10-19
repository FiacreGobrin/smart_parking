import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { daysAgo, startOfToday } from '../utils/dates.js';

const num = (v) => Number(v ?? 0);

export async function getSummary(facilityId) {
  const today = startOfToday();
  const fWhere = facilityId ? { facilityId } : {};

  const [spaceGroups, activeSessions, entriesToday, exitsToday, revenueToday, pendingPayments, failedToday, outstanding, facilities] = await Promise.all([
    prisma.parkingSpace.groupBy({ by: ['status'], where: { ...fWhere, archivedAt: null }, _count: true }),
    prisma.parkingSession.count({ where: { ...fWhere, status: 'ACTIVE' } }),
    prisma.parkingSession.count({ where: { ...fWhere, entryAt: { gte: today } } }),
    prisma.parkingSession.count({ where: { ...fWhere, status: 'COMPLETED', exitAt: { gte: today } } }),
    prisma.payment.aggregate({ where: { ...fWhere, status: 'SUCCESS', paidAt: { gte: today } }, _sum: { amount: true }, _count: true }),
    prisma.payment.count({ where: { ...fWhere, status: 'PENDING' } }),
    prisma.payment.count({ where: { ...fWhere, status: 'FAILED', createdAt: { gte: today } } }),
    // Completed sessions whose fee was never fully paid.
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(total - "amountPaid"), 0) AS amount
      FROM "ParkingSession"
      WHERE status = 'COMPLETED' AND total > "amountPaid"
      ${facilityId ? Prisma.sql`AND "facilityId" = ${facilityId}` : Prisma.empty}`,
    prisma.parkingFacility.findMany({ where: { archivedAt: null, ...(facilityId ? { id: facilityId } : {}) }, select: { id: true, name: true, code: true, currency: true } }),
  ]);

  const counts = Object.fromEntries(spaceGroups.map((g) => [g.status, g._count]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const occupied = counts.OCCUPIED || 0;
  const usable = total - (counts.OUT_OF_SERVICE || 0);

  const perFacilityGroups = await prisma.parkingSpace.groupBy({ by: ['facilityId', 'status'], where: { ...fWhere, archivedAt: null }, _count: true });
  const byFacility = facilities.map((f) => {
    const c = Object.fromEntries(perFacilityGroups.filter((g) => g.facilityId === f.id).map((g) => [g.status, g._count]));
    const t = Object.values(c).reduce((a, b) => a + b, 0);
    const u = t - (c.OUT_OF_SERVICE || 0);
    return { ...f, total: t, occupied: c.OCCUPIED || 0, available: c.AVAILABLE || 0, reserved: c.RESERVED || 0, outOfService: c.OUT_OF_SERVICE || 0, occupancyPct: u ? Math.round(((c.OCCUPIED || 0) / u) * 100) : 0 };
  });

  return {
    spaces: { total, occupied, available: counts.AVAILABLE || 0, reserved: counts.RESERVED || 0, outOfService: counts.OUT_OF_SERVICE || 0 },
    occupancyPct: usable ? Math.round((occupied / usable) * 100) : 0,
    vehiclesParked: activeSessions,
    entriesToday,
    exitsToday,
    revenueToday: String(revenueToday._sum.amount ?? 0),
    paymentsToday: revenueToday._count,
    pendingPayments,
    failedPaymentsToday: failedToday,
    outstanding: { count: outstanding[0].count, amount: String(outstanding[0].amount) },
    byFacility,
    generatedAt: new Date().toISOString(),
  };
}

export async function getRevenueTrend(facilityId, days = 14) {
  const from = daysAgo(days - 1);
  const rows = await prisma.$queryRaw`
    SELECT to_char(("paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Kigali', 'YYYY-MM-DD') AS day,
           SUM(amount) AS revenue, COUNT(*)::int AS payments
    FROM "Payment"
    WHERE status = 'SUCCESS' AND "paidAt" >= ${from}
    ${facilityId ? Prisma.sql`AND "facilityId" = ${facilityId}` : Prisma.empty}
    GROUP BY 1 ORDER BY 1`;
  // Fill days with no payments so the chart axis is continuous.
  const map = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(daysAgo(i).getTime() + 2 * 3600000).toISOString().slice(0, 10);
    out.push({ day: d, revenue: num(map.get(d)?.revenue), payments: map.get(d)?.payments ?? 0 });
  }
  return out;
}

// Entries and exits per hour for the last 24 hours, plus current occupancy by facility.
export async function getOccupancy(facilityId) {
  const since = new Date(Date.now() - 24 * 3600000);
  const f = facilityId ? Prisma.sql`AND "facilityId" = ${facilityId}` : Prisma.empty;
  const [entries, exits] = await Promise.all([
    prisma.$queryRaw`SELECT to_char(date_trunc('hour', ("entryAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Kigali'), 'HH24:00') AS hour, COUNT(*)::int AS count FROM "ParkingSession" WHERE "entryAt" >= ${since} ${f} GROUP BY 1`,
    prisma.$queryRaw`SELECT to_char(date_trunc('hour', ("exitAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Kigali'), 'HH24:00') AS hour, COUNT(*)::int AS count FROM "ParkingSession" WHERE "exitAt" >= ${since} AND status = 'COMPLETED' ${f} GROUP BY 1`,
  ]);
  const hours = [];
  for (let i = 23; i >= 0; i--) {
    const h = new Date(Date.now() - i * 3600000 + 2 * 3600000);
    hours.push(`${String(h.getUTCHours()).padStart(2, '0')}:00`);
  }
  const e = new Map(entries.map((r) => [r.hour, r.count]));
  const x = new Map(exits.map((r) => [r.hour, r.count]));
  return {
    hourly: hours.map((hour) => ({ hour, entries: e.get(hour) ?? 0, exits: x.get(hour) ?? 0 })),
    ...(await getSummary(facilityId).then((s) => ({ byFacility: s.byFacility, spaces: s.spaces, occupancyPct: s.occupancyPct }))),
  };
}

export async function getRecentActivity(facilityId, limit = 15) {
  const sessions = await prisma.parkingSession.findMany({
    where: facilityId ? { facilityId } : {},
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: { space: { select: { code: true } }, facility: { select: { name: true } } },
  });
  return sessions.map((s) => ({
    id: s.id,
    type: s.status === 'ACTIVE' ? 'ENTRY' : s.status === 'COMPLETED' ? 'EXIT' : 'CANCELLED',
    plate: s.plate,
    facility: s.facility.name,
    space: s.space?.code ?? null,
    total: s.total.toString(),
    at: s.status === 'ACTIVE' ? s.entryAt : s.exitAt ?? s.updatedAt,
  }));
}
