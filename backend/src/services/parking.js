import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { isPlausiblePlate, matchPlateFormat, normalizePlate } from '../utils/plate.js';
import { calculateFee, pickRate, serializeFee } from './pricing.js';
import { decideAccess } from './gateDecision.js';
import { getSetting } from './settings.js';
import { audit } from './audit.js';
import { notify, refreshOccupancy } from './notify.js';
import { emit } from '../sockets/index.js';

// A payment stays valid for this long; leaving later may add new billable blocks.
export const EXIT_GRACE_MINUTES = 15;

// Which space categories may host which vehicle, in order of preference.
const SPACE_PREFERENCE = {
  CAR: ['STANDARD'],
  MOTORCYCLE: ['MOTORCYCLE', 'STANDARD'],
  BUS: ['STANDARD'],
  TRUCK: ['STANDARD'],
  OTHER: ['STANDARD'],
};

const newTicketNo = () => {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `T${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

function denial(decision, extra) {
  return new AppError(403, `ACCESS_DENIED_${decision.code}`, decision.reason, { decision, ...extra });
}

async function recordGateEvent(data) {
  if (!data.gateId) return;
  await prisma.gateEvent.create({ data }).catch(() => {});
}

// Picks and row-locks a space. SKIP LOCKED keeps concurrent entries from fighting over the same row.
async function lockSpace(tx, { facilityId, vehicleType, spaceId, reservedSpaceId }) {
  const wanted = spaceId || reservedSpaceId;
  if (wanted) {
    const rows = await tx.$queryRaw`
      SELECT id, code, status, "facilityId", type::text AS type FROM "ParkingSpace"
      WHERE id = ${wanted} AND "archivedAt" IS NULL FOR UPDATE`;
    const space = rows[0];
    if (!space || space.facilityId !== facilityId) throw notFound('Parking space');
    if (space.status === 'OUT_OF_SERVICE') throw badRequest('That space is out of service');
    if (space.status === 'OCCUPIED') throw new AppError(409, 'SPACE_OCCUPIED', 'That space is already occupied');
    if (space.status === 'RESERVED' && !reservedSpaceId) throw new AppError(409, 'SPACE_RESERVED', 'That space is reserved');
    return space;
  }
  const prefs = SPACE_PREFERENCE[vehicleType] || SPACE_PREFERENCE.OTHER;
  const now = new Date();
  const soon = new Date(now.getTime() + 2 * 3600000);
  const rows = await tx.$queryRaw`
    SELECT s.id, s.code, s.status, s."facilityId", s.type::text AS type FROM "ParkingSpace" s
    WHERE s."facilityId" = ${facilityId} AND s.status = 'AVAILABLE' AND s."archivedAt" IS NULL
      AND s.type::text = ANY(${prefs}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM "Reservation" r
        WHERE r."spaceId" = s.id AND r.status IN ('PENDING', 'CONFIRMED')
          AND r."startAt" < ${soon} AND r."endAt" > ${now})
    ORDER BY array_position(${prefs}::text[], s.type::text), s.code
    FOR UPDATE OF s SKIP LOCKED LIMIT 1`;
  return rows[0] || null;
}

async function setSpaceStatus(tx, spaceId, from, to, reason, sessionId) {
  await tx.parkingSpace.update({ where: { id: spaceId }, data: { status: to } });
  await tx.spaceStatusHistory.create({ data: { spaceId, fromStatus: from, toStatus: to, reason, sessionId } });
}

/**
 * Registers a vehicle entry. Returns the new session, or throws ACCESS_DENIED_* (403)
 * after recording the denial. Safe against duplicate requests: the database allows only
 * one ACTIVE session per plate and per space.
 */
const UNITS_FOR = { PARKING: ['HOUR'], GARAGE: ['DAY', 'WEEK', 'MONTH'], CAR_WASH: ['VISIT'] };

export async function registerEntry({ plate: rawPlate, facilityId, vehicleType, spaceId, gateId, recognition, confidence, user, req, notes, service = 'PARKING', billingUnit }) {
  // Parking bills by the hour, car wash per visit, garage by day/week/month (default day).
  const unit = billingUnit || UNITS_FOR[service][0];
  if (!UNITS_FOR[service]?.includes(unit)) throw badRequest(`${service} cannot be billed per ${unit.toLowerCase()}`);
  const needsSpace = service !== 'CAR_WASH';
  const plate = normalizePlate(rawPlate);
  if (!isPlausiblePlate(plate)) throw badRequest('License plate must be 3-12 letters or digits');

  const gate = gateId ? await prisma.gate.findUnique({ where: { id: gateId } }) : null;
  if (gateId && !gate) throw notFound('Gate');
  if (gate && gate.direction !== 'ENTRY') throw badRequest('This gate is configured for exits only');
  const effectiveFacilityId = facilityId || gate?.facilityId;
  if (!effectiveFacilityId) throw badRequest('facilityId or gateId is required');
  if (gate && gate.facilityId !== effectiveFacilityId) throw badRequest('Gate does not belong to this facility');

  const facility = await prisma.parkingFacility.findUnique({ where: { id: effectiveFacilityId } });
  if (!facility || facility.archivedAt) throw notFound('Facility');

  const now = new Date();
  const [vehicle, activeSession, permit, reservation, allowUnregistered, minConfidence] = await Promise.all([
    prisma.vehicle.findUnique({ where: { plate } }),
    prisma.parkingSession.findFirst({ where: { plate, status: 'ACTIVE' } }),
    prisma.parkingPermit.findFirst({
      where: { plate, facilityId: facility.id, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gte: now } },
    }),
    prisma.reservation.findFirst({
      where: {
        plate, facilityId: facility.id, status: { in: ['PENDING', 'CONFIRMED'] },
        startAt: { lte: new Date(now.getTime() + 15 * 60000) }, endAt: { gte: now },
      },
    }),
    getSetting('access.allowUnregistered'),
    getSetting('anpr.minConfidence'),
  ]);

  const type = vehicleType || vehicle?.type || 'CAR';

  let session;
  let decision;
  try {
    session = await prisma.$transaction(async (tx) => {
      let space = null;
      if (needsSpace && !activeSession && vehicle?.status !== 'RESTRICTED') {
        space = await lockSpace(tx, {
          facilityId: facility.id, vehicleType: type, spaceId, reservedSpaceId: reservation?.spaceId,
        });
      }
      decision = decideAccess({
        direction: 'ENTRY', plate, gateStatus: gate?.status, facilityActive: facility.isActive,
        vehicle, hasPermit: !!permit, allowUnregistered: allowUnregistered !== false, activeSession,
        hasCapacity: !needsSpace || !!space || facility.allowUnassignedSpace, hasReservation: !!reservation,
        confidence, minConfidence: minConfidence ?? 0.85,
      });
      if (!decision.allow) throw denial(decision);

      const created = await tx.parkingSession.create({
        data: {
          ticketNo: newTicketNo(), plate, vehicleId: vehicle?.id, vehicleType: type, service, billingUnit: unit,
          facilityId: facility.id, spaceId: space?.id ?? null, entryAt: now, entryGateId: gate?.id,
          entryRecognitionId: recognition?.id, enteredById: user?.id, notes,
        },
      });
      if (space) await setSpaceStatus(tx, space.id, space.status, 'OCCUPIED', 'Vehicle entry', created.id);
      if (reservation) {
        await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'CHECKED_IN', sessionId: created.id } });
      }
      if (gate) {
        await tx.gateEvent.create({
          data: { gateId: gate.id, type: 'ENTRY', outcome: 'GRANTED', plate, vehicleId: vehicle?.id, sessionId: created.id, cameraId: recognition?.cameraId, userId: user?.id, reason: decision.reason },
        });
      }
      await audit(req, { action: 'PARKING_ENTRY', entity: 'ParkingSession', entityId: created.id, metadata: { plate, facilityId: facility.id, spaceId: space?.id, gateId: gate?.id, decision: decision.code } }, tx);
      // Return the space we already hold instead of paying for extra join queries over the network.
      return { ...created, space: space ? { id: space.id, code: space.code, type: space.type, status: 'OCCUPIED' } : null, vehicle };
    });
  } catch (err) {
    if (err instanceof AppError && err.code.startsWith('ACCESS_DENIED_')) {
      const d = err.details.decision;
      await recordGateEvent({ gateId: gate?.id, type: 'DENIED', outcome: 'DENIED', plate, vehicleId: vehicle?.id, cameraId: recognition?.cameraId, userId: user?.id, reason: d.reason, details: { code: d.code, direction: 'ENTRY' } });
      await audit(req, { action: 'PARKING_ENTRY', entity: 'Vehicle', entityId: vehicle?.id, result: 'DENIED', metadata: { plate, code: d.code, reason: d.reason, facilityId: facility.id } });
      if (['RESTRICTED_VEHICLE', 'ALREADY_INSIDE'].includes(d.code)) {
        await notify({ type: 'UNUSUAL_ACCESS', severity: 'WARNING', title: 'Entry denied', message: `${plate}: ${d.reason}`, facilityId: facility.id, dedupeKey: `deny:${plate}:${d.code}`, dedupeMinutes: 10 });
      }
    }
    // The partial unique indexes turn a concurrent duplicate into a clean conflict.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'DUPLICATE_ENTRY', 'This vehicle (or space) already has an active session');
    }
    throw err;
  }

  emit('session:entry', { id: session.id, plate, facilityId: facility.id, spaceCode: session.space?.code }, facility.id);
  await refreshOccupancy(facility.id);
  return { ...session, formatMatch: matchPlateFormat(plate), decision };
}

/** The facility to use when none is given: the user's own, or the only active one. */
export async function resolveFacilityId(user, requested) {
  if (requested) return requested;
  if (user?.facilityId) return user.facilityId;
  const list = await prisma.parkingFacility.findMany({ where: { archivedAt: null, isActive: true }, select: { id: true }, take: 2 });
  if (list.length === 1) return list[0].id;
  if (list.length === 0) throw new AppError(409, 'NO_FACILITY', 'No parking facility exists yet. Create one under Settings > Facilities first.');
  throw badRequest('Several facilities exist: choose which one to use');
}

export async function loadRates(facilityId) {
  return prisma.parkingRate.findMany({ where: { isActive: true, OR: [{ facilityId: null }, { facilityId }] } });
}

async function hasActivePermit(plate, facilityId, at) {
  return !!(await prisma.parkingPermit.findFirst({
    where: { plate, facilityId, status: 'ACTIVE', startsAt: { lte: at }, endsAt: { gte: at } },
  }));
}

/**
 * Calculates what is owed right now for an active session without changing anything.
 * If a payment covering the stored fee was made within the exit grace window, that fee is honored.
 */
export async function quoteSession(session, { at = new Date(), exempt = false, exemptReason, discountPercent = 0, discountFixed = 0 } = {}) {
  const paid = new Decimal(session.amountPaid);
  // Independent lookups run together: every query is a network round trip to the database.
  const [facility, lastPayment, permitHit, rates] = await Promise.all([
    session.facility ?? prisma.parkingFacility.findUnique({ where: { id: session.facilityId } }),
    prisma.payment.findFirst({ where: { sessionId: session.id, status: 'SUCCESS' }, orderBy: { paidAt: 'desc' } }),
    session.service === 'PARKING' ? hasActivePermit(session.plate, session.facilityId, at) : Promise.resolve(false),
    loadRates(session.facilityId),
  ]);
  const withinGrace = lastPayment?.paidAt && at - lastPayment.paidAt <= EXIT_GRACE_MINUTES * 60000;
  const storedTotal = new Decimal(session.total);
  if (!exempt && withinGrace && paid.gte(storedTotal) && storedTotal.gt(0)) {
    return { fee: null, frozen: true, total: storedTotal, paid, balanceDue: new Decimal(0), facility, stored: true };
  }

  // A monthly permit only covers parking, not garage or car wash charges.
  const permit = permitHit;
  const rate = pickRate(rates, { facilityId: session.facilityId, vehicleType: session.vehicleType, service: session.service, unit: session.billingUnit, at });
  if (!rate && !exempt && !permit) {
    throw new AppError(422, 'NO_RATE', `No active price for ${session.service.toLowerCase().replace('_', ' ')} (${session.vehicleType.toLowerCase()}, per ${session.billingUnit.toLowerCase()}). Add one under Price / Cost.`);
  }
  const fee = calculateFee({
    entryAt: session.entryAt, exitAt: at, rate, taxRate: facility.taxRate,
    discountPercent, discountFixed,
    exempt: exempt || permit,
    exemptReason: exempt ? exemptReason : permit ? 'Active parking permit' : null,
  });
  const balanceDue = Decimal.max(0, fee.total.minus(paid));
  return { fee, frozen: false, total: fee.total, paid, balanceDue, facility, rate };
}

export async function findActiveSession({ sessionId, plate }) {
  const where = sessionId ? { id: sessionId } : { plate: normalizePlate(plate), status: 'ACTIVE' };
  if (!sessionId && !where.plate) throw badRequest('sessionId or plate is required');
  const session = await prisma.parkingSession.findFirst({ where, include: { space: true, vehicle: true, facility: true, payments: { where: { status: 'SUCCESS' }, include: { receipt: { select: { id: true } } } } } });
  if (!session) throw notFound('Active parking session');
  return session;
}

export async function previewExit(params) {
  const session = await findActiveSession(params);
  if (session.status !== 'ACTIVE') throw new AppError(409, 'SESSION_CLOSED', 'Session is not active');
  const q = await quoteSession(session, params);
  return {
    session,
    fee: q.fee ? serializeFee(q.fee) : { frozen: true, total: q.total.toFixed(2), lines: [{ label: 'Paid - fee frozen at payment time', amount: q.total.toFixed(2) }] },
    total: q.total.toFixed(2),
    amountPaid: q.paid.toFixed(2),
    balanceDue: q.balanceDue.toFixed(2),
    currency: session.facility.currency,
  };
}

/** Persists the quoted fee on the session (called when a payment is initiated or settled). */
export async function persistFee(tx, sessionId, q) {
  if (!q.fee) return;
  await tx.parkingSession.update({
    where: { id: sessionId },
    data: {
      subtotal: q.fee.subtotal.toFixed(2), discount: q.fee.discount.toFixed(2), tax: q.fee.tax.toFixed(2),
      total: q.fee.total.toFixed(2), durationMinutes: q.fee.durationMinutes, rateId: q.fee.rateId,
      breakdown: serializeFee(q.fee), exemptReason: q.fee.exemptReason,
    },
  });
}

/**
 * Closes an active session. Refuses (402) while a balance is outstanding.
 * The session close, space release and gate event commit together or not at all.
 */
export async function registerExit({ sessionId, plate, gateId, exempt, exemptReason, discountPercent, user, req, recognition, confidence }) {
  const session = await findActiveSession({ sessionId, plate });
  if (session.status !== 'ACTIVE') throw new AppError(409, 'SESSION_CLOSED', 'Session is already closed');

  const gate = gateId ? await prisma.gate.findUnique({ where: { id: gateId } }) : null;
  if (gateId && !gate) throw notFound('Gate');
  if (gate && gate.direction !== 'EXIT') throw badRequest('This gate is configured for entries only');
  if (gate && gate.facilityId !== session.facilityId) throw badRequest('Gate does not belong to the session facility');
  const minConfidence = (await getSetting('anpr.minConfidence')) ?? 0.85;

  const at = new Date();
  const q = await quoteSession(session, { at, exempt, exemptReason, discountPercent });
  const decision = decideAccess({
    direction: 'EXIT', plate: session.plate, gateStatus: gate?.status, facilityActive: session.facility.isActive,
    vehicle: session.vehicle, activeSession: session, balanceDue: q.balanceDue.toFixed(2), confidence, minConfidence,
  });

  if (!decision.allow) {
    await recordGateEvent({ gateId: gate?.id, type: 'DENIED', outcome: 'DENIED', plate: session.plate, sessionId: session.id, cameraId: recognition?.cameraId, userId: user?.id, reason: decision.reason, details: { code: decision.code, direction: 'EXIT', balanceDue: q.balanceDue.toFixed(2) } });
    await audit(req, { action: 'PARKING_EXIT', entity: 'ParkingSession', entityId: session.id, result: 'DENIED', metadata: { code: decision.code, balanceDue: q.balanceDue.toFixed(2) } });
    const status = decision.code === 'PAYMENT_REQUIRED' ? 402 : 403;
    throw new AppError(status, `ACCESS_DENIED_${decision.code}`, decision.reason, {
      decision, balanceDue: q.balanceDue.toFixed(2), total: q.total.toFixed(2),
    });
  }

  if (exempt) {
    await audit(req, { action: 'EXEMPTION_APPLIED', entity: 'ParkingSession', entityId: session.id, metadata: { reason: exemptReason } });
  }

  const closed = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction: another request may have closed the session already.
    const fresh = await tx.parkingSession.updateMany({
      where: { id: session.id, status: 'ACTIVE' },
      data: { status: 'COMPLETED', exitAt: at, exitGateId: gate?.id, exitedById: user?.id, exitRecognitionId: recognition?.id },
    });
    if (fresh.count === 0) throw new AppError(409, 'SESSION_CLOSED', 'Session was already closed');
    if (q.fee) await persistFee(tx, session.id, q);
    await tx.parkingSession.update({
      where: { id: session.id },
      data: { durationMinutes: q.fee?.durationMinutes ?? Math.ceil((at - session.entryAt) / 60000) },
    });
    if (session.spaceId) await setSpaceStatus(tx, session.spaceId, 'OCCUPIED', 'AVAILABLE', 'Vehicle exit', session.id);
    if (gate) {
      await tx.gateEvent.create({
        data: { gateId: gate.id, type: 'EXIT', outcome: 'GRANTED', plate: session.plate, vehicleId: session.vehicleId, sessionId: session.id, cameraId: recognition?.cameraId, userId: user?.id, reason: decision.reason },
      });
    }
    await audit(req, { action: 'PARKING_EXIT', entity: 'ParkingSession', entityId: session.id, metadata: { total: q.total.toFixed(2), paid: q.paid.toFixed(2), gateId: gate?.id } }, tx);
    return tx.parkingSession.findUnique({ where: { id: session.id }, include: { space: true, vehicle: true, payments: true } });
  });

  emit('session:exit', { id: closed.id, plate: closed.plate, facilityId: closed.facilityId }, closed.facilityId);
  await refreshOccupancy(closed.facilityId);
  return closed;
}

export async function cancelSession(sessionId, reason, user, req) {
  const session = await prisma.parkingSession.findUnique({ where: { id: sessionId } });
  if (!session) throw notFound('Parking session');
  if (session.status !== 'ACTIVE') throw new AppError(409, 'SESSION_CLOSED', 'Only active sessions can be cancelled');
  await prisma.$transaction(async (tx) => {
    await tx.parkingSession.update({ where: { id: sessionId }, data: { status: 'CANCELLED', exitAt: new Date(), notes: reason, exitedById: user.id } });
    if (session.spaceId) await setSpaceStatus(tx, session.spaceId, 'OCCUPIED', 'AVAILABLE', `Session cancelled: ${reason}`, sessionId);
    await audit(req, { action: 'SESSION_CANCELLED', entity: 'ParkingSession', entityId: sessionId, metadata: { reason } }, tx);
  });
  await refreshOccupancy(session.facilityId);
}
