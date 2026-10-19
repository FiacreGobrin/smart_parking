import { prisma } from '../config/db.js';
import { emit } from '../sockets/index.js';
import { logger } from '../config/logger.js';

// Creates an in-app notification and pushes it over Socket.IO.
// `dedupeKey` suppresses a repeat of the same alert within `dedupeMinutes`.
export async function notify({ type, severity = 'INFO', title, message, facilityId, metadata, dedupeKey, dedupeMinutes = 30 }) {
  try {
    if (dedupeKey) {
      const since = new Date(Date.now() - dedupeMinutes * 60000);
      const existing = await prisma.notification.findFirst({ where: { dedupeKey, createdAt: { gte: since } } });
      if (existing) return existing;
    }
    const n = await prisma.notification.create({
      data: { type, severity, title, message, facilityId, metadata, dedupeKey },
    });
    emit('notification:new', n, facilityId);
    return n;
  } catch (err) {
    logger.error('notify failed', { error: err.message });
    return null;
  }
}

// Emits an occupancy update and raises a low-availability alert when needed.
export async function refreshOccupancy(facilityId) {
  const [facility, groups] = await Promise.all([
    prisma.parkingFacility.findUnique({ where: { id: facilityId } }),
    prisma.parkingSpace.groupBy({ by: ['status'], where: { facilityId, archivedAt: null }, _count: true }),
  ]);
  if (!facility) return null;
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const usable = total - (counts.OUT_OF_SERVICE || 0);
  const available = counts.AVAILABLE || 0;
  const snapshot = {
    facilityId, total, available, occupied: counts.OCCUPIED || 0, reserved: counts.RESERVED || 0,
    outOfService: counts.OUT_OF_SERVICE || 0,
  };
  emit('occupancy:update', snapshot, facilityId);
  if (usable > 0 && (available / usable) * 100 <= facility.lowAvailabilityThreshold) {
    await notify({
      type: 'LOW_AVAILABILITY', severity: available === 0 ? 'CRITICAL' : 'WARNING',
      title: `Low availability at ${facility.name}`,
      message: `${available} of ${usable} usable spaces are free.`,
      facilityId, dedupeKey: `low:${facilityId}`, dedupeMinutes: 60,
    });
  }
  return snapshot;
}
