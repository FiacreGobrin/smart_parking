import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { getSetting } from './settings.js';
import { notify } from './notify.js';

// Housekeeping that must happen without a user request. Runs every minute from server.js and can be
// triggered manually through POST /api/v1/system/maintenance.
export async function runMaintenance(now = new Date()) {
  const summary = {};
  const graceMin = (await getSetting('reservation.noShowGraceMinutes')) ?? 30;
  const warnDays = (await getSetting('permit.expiryWarningDays')) ?? 7;

  summary.reservationsExpired = (await prisma.reservation.updateMany({
    where: { status: 'PENDING', endAt: { lt: now } }, data: { status: 'EXPIRED' },
  })).count;

  summary.noShows = (await prisma.reservation.updateMany({
    where: { status: { in: ['CONFIRMED', 'PENDING'] }, startAt: { lt: new Date(now.getTime() - graceMin * 60000) } },
    data: { status: 'NO_SHOW' },
  })).count;

  summary.permitsExpired = (await prisma.parkingPermit.updateMany({
    where: { status: 'ACTIVE', endsAt: { lt: now } }, data: { status: 'EXPIRED' },
  })).count;

  const soonRes = await prisma.reservation.findMany({
    where: { status: { in: ['CONFIRMED', 'CHECKED_IN'] }, endAt: { gte: now, lte: new Date(now.getTime() + 30 * 60000) } },
  });
  for (const r of soonRes) {
    await notify({ type: 'EXPIRING_RESERVATION', severity: 'INFO', title: 'Reservation ending soon', message: `${r.code} (${r.plate}) ends at ${r.endAt.toISOString()}`, facilityId: r.facilityId, dedupeKey: `res:${r.id}`, dedupeMinutes: 120 });
  }

  const soonPermits = await prisma.parkingPermit.findMany({
    where: { status: 'ACTIVE', endsAt: { gte: now, lte: new Date(now.getTime() + warnDays * 86400000) } },
  });
  for (const p of soonPermits) {
    await notify({ type: 'EXPIRING_PERMIT', severity: 'INFO', title: 'Permit expiring soon', message: `Permit ${p.number} (${p.plate}) expires ${p.endsAt.toISOString().slice(0, 10)}`, facilityId: p.facilityId, dedupeKey: `permit:${p.id}`, dedupeMinutes: 1440 });
  }

  const downGates = await prisma.gate.findMany({ where: { status: { in: ['OFFLINE', 'ERROR'] } } });
  for (const g of downGates) {
    await notify({ type: 'DEVICE_OFFLINE', severity: 'CRITICAL', title: `Gate ${g.name} is ${g.status.toLowerCase()}`, message: 'Vehicles cannot be admitted automatically until the gate is restored.', facilityId: g.facilityId, dedupeKey: `gate:${g.id}`, dedupeMinutes: 60 });
  }
  const downCams = await prisma.camera.findMany({ where: { status: { in: ['OFFLINE', 'ERROR'] } } });
  for (const c of downCams) {
    await notify({ type: 'DEVICE_OFFLINE', severity: 'WARNING', title: `Camera ${c.name} is ${c.status.toLowerCase()}`, message: 'Plate recognition is unavailable on this camera.', facilityId: c.facilityId, dedupeKey: `cam:${c.id}`, dedupeMinutes: 60 });
  }

  logger.debug('maintenance complete', summary);
  return summary;
}
