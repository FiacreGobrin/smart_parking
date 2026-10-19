import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { assertFacilityAccess, requirePermission, scopeFacility } from '../middleware/auth.js';
import { validateBody } from '../middleware/common.js';
import { audit } from '../services/audit.js';
import { registerEntry } from '../services/parking.js';
import { payPermitCash } from '../services/payments.js';
import { AppError, badRequest, conflict, notFound } from '../utils/errors.js';
import { isPlausiblePlate, normalizePlate } from '../utils/plate.js';
import { pageMeta, parsePagination, parseSort } from '../utils/pagination.js';
import { created, ok } from '../utils/respond.js';

const code = (p) => `${p}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const plateField = z.string().trim().min(3).max(20).refine((p) => isPlausiblePlate(normalizePlate(p)), 'Invalid plate');

// ---------------- Reservations ----------------
export const reservations = Router();

const reservationSchema = z.object({
  facilityId: z.string().min(1),
  spaceId: z.string().min(1),
  plate: plateField,
  customerName: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(30).optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  notes: z.string().max(300).optional(),
}).refine((v) => v.endAt > v.startAt, { message: 'End must be after start', path: ['endAt'] });

async function assertSpaceUsable(facilityId, spaceId) {
  const space = await prisma.parkingSpace.findUnique({ where: { id: spaceId } });
  if (!space || space.archivedAt || space.facilityId !== facilityId) throw badRequest('Space does not belong to this facility');
  if (space.status === 'OUT_OF_SERVICE') throw badRequest('That space is out of service');
}

reservations.get('/', requirePermission('reservations.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const where = {
    ...(facilityId ? { facilityId } : {}),
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.search ? { OR: [{ plate: { contains: normalizePlate(req.query.search) || '-' } }, { customerName: { contains: String(req.query.search), mode: 'insensitive' } }, { code: { contains: String(req.query.search), mode: 'insensitive' } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.reservation.findMany({ where, skip, take, orderBy: parseSort(req.query, ['startAt', 'createdAt', 'status'], { startAt: 'desc' }), include: { space: { select: { code: true } }, facility: { select: { name: true } } } }),
    prisma.reservation.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

reservations.post('/', requirePermission('reservations.write'), validateBody(reservationSchema), async (req, res) => {
  const d = req.body;
  assertFacilityAccess(req.user, d.facilityId);
  if (d.endAt < new Date()) throw badRequest('Reservation must end in the future');
  await assertSpaceUsable(d.facilityId, d.spaceId);
  // The exclusion constraint is the real guard; this pre-check only gives a friendlier message.
  const clash = await prisma.reservation.findFirst({ where: { spaceId: d.spaceId, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] }, startAt: { lt: d.endAt }, endAt: { gt: d.startAt } } });
  if (clash) throw new AppError(409, 'RESERVATION_CONFLICT', `Space already reserved ${clash.startAt.toISOString()} - ${clash.endAt.toISOString()} (${clash.code})`);
  const row = await prisma.reservation.create({ data: { ...d, plate: normalizePlate(d.plate), code: code('RSV'), status: 'CONFIRMED', createdById: req.user.id } });
  await audit(req, { action: 'RESERVATION_CREATED', entity: 'Reservation', entityId: row.id, metadata: { plate: row.plate, spaceId: row.spaceId } });
  created(res, row);
});

reservations.patch('/:id', requirePermission('reservations.write'), validateBody(z.object({
  spaceId: z.string().optional(), startAt: z.coerce.date().optional(), endAt: z.coerce.date().optional(),
  customerName: z.string().trim().min(2).max(100).optional(), phone: z.string().trim().max(30).optional(), notes: z.string().max(300).optional(),
})), async (req, res) => {
  const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Reservation');
  assertFacilityAccess(req.user, existing.facilityId);
  if (!['PENDING', 'CONFIRMED'].includes(existing.status)) throw conflict(`A ${existing.status.toLowerCase()} reservation cannot be edited`);
  const startAt = req.body.startAt ?? existing.startAt;
  const endAt = req.body.endAt ?? existing.endAt;
  if (endAt <= startAt) throw badRequest('End must be after start');
  if (req.body.spaceId) await assertSpaceUsable(existing.facilityId, req.body.spaceId);
  const row = await prisma.reservation.update({ where: { id: existing.id }, data: req.body });
  await audit(req, { action: 'RESERVATION_UPDATED', entity: 'Reservation', entityId: row.id, metadata: req.body });
  ok(res, row);
});

reservations.post('/:id/cancel', requirePermission('reservations.write'), validateBody(z.object({ reason: z.string().trim().min(3).max(200) })), async (req, res) => {
  const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Reservation');
  assertFacilityAccess(req.user, existing.facilityId);
  if (!['PENDING', 'CONFIRMED'].includes(existing.status)) throw conflict(`A ${existing.status.toLowerCase()} reservation cannot be cancelled`);
  const row = await prisma.reservation.update({ where: { id: existing.id }, data: { status: 'CANCELLED', cancelledReason: req.body.reason } });
  await audit(req, { action: 'RESERVATION_CANCELLED', entity: 'Reservation', entityId: row.id, metadata: { reason: req.body.reason } });
  ok(res, row);
});

// Convenience for desks: starts the parking session using the reserved space.
reservations.post('/:id/check-in', requirePermission('reservations.write'), requirePermission('sessions.write'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r) throw notFound('Reservation');
  assertFacilityAccess(req.user, r.facilityId);
  if (!['PENDING', 'CONFIRMED'].includes(r.status)) throw conflict(`Reservation is ${r.status.toLowerCase()}`);
  const session = await registerEntry({ plate: r.plate, facilityId: r.facilityId, user: req.user, req });
  ok(res, session);
});

// ---------------- Permits ----------------
export const permits = Router();

const permitSchema = z.object({
  facilityId: z.string().min(1),
  plate: plateField,
  holderName: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(30).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  fee: z.coerce.number().nonnegative().max(1e9).default(0),
}).refine((v) => v.endsAt > v.startsAt, { message: 'End must be after start', path: ['endsAt'] });

permits.get('/', requirePermission('permits.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const where = {
    ...(facilityId ? { facilityId } : {}),
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.search ? { OR: [{ plate: { contains: normalizePlate(req.query.search) || '-' } }, { holderName: { contains: String(req.query.search), mode: 'insensitive' } }, { number: { contains: String(req.query.search), mode: 'insensitive' } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.parkingPermit.findMany({ where, skip, take, orderBy: parseSort(req.query, ['endsAt', 'createdAt', 'plate'], { endsAt: 'desc' }), include: { facility: { select: { name: true } } } }),
    prisma.parkingPermit.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

permits.post('/', requirePermission('permits.write'), validateBody(permitSchema), async (req, res) => {
  const d = req.body;
  assertFacilityAccess(req.user, d.facilityId);
  const plate = normalizePlate(d.plate);
  const overlap = await prisma.parkingPermit.findFirst({ where: { plate, facilityId: d.facilityId, status: 'ACTIVE', startsAt: { lt: d.endsAt }, endsAt: { gt: d.startsAt } } });
  if (overlap) throw conflict(`${plate} already holds permit ${overlap.number} for an overlapping period`);
  const vehicle = await prisma.vehicle.findUnique({ where: { plate } });
  const row = await prisma.parkingPermit.create({ data: { ...d, plate, vehicleId: vehicle?.id, number: code('PRM') } });
  await audit(req, { action: 'PERMIT_CREATED', entity: 'Permit', entityId: row.id, metadata: { plate, endsAt: row.endsAt } });
  created(res, row);
});

permits.patch('/:id', requirePermission('permits.write'), validateBody(z.object({
  holderName: z.string().trim().min(2).max(100).optional(), phone: z.string().trim().max(30).optional(),
  endsAt: z.coerce.date().optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']).optional(),
})), async (req, res) => {
  const existing = await prisma.parkingPermit.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Permit');
  assertFacilityAccess(req.user, existing.facilityId);
  if (req.body.endsAt && req.body.endsAt <= existing.startsAt) throw badRequest('End must be after start');
  const row = await prisma.parkingPermit.update({ where: { id: existing.id }, data: req.body });
  await audit(req, { action: req.body.status ? `PERMIT_${req.body.status}` : 'PERMIT_UPDATED', entity: 'Permit', entityId: row.id, metadata: req.body });
  ok(res, row);
});

permits.post('/:id/renew', requirePermission('permits.write'), validateBody(z.object({ months: z.coerce.number().int().min(1).max(24).default(1) })), async (req, res) => {
  const existing = await prisma.parkingPermit.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Permit');
  assertFacilityAccess(req.user, existing.facilityId);
  const base = existing.endsAt > new Date() ? existing.endsAt : new Date();
  const endsAt = new Date(base);
  endsAt.setMonth(endsAt.getMonth() + req.body.months);
  const row = await prisma.parkingPermit.update({ where: { id: existing.id }, data: { endsAt, status: 'ACTIVE' } });
  await audit(req, { action: 'PERMIT_RENEWED', entity: 'Permit', entityId: row.id, metadata: { months: req.body.months } });
  ok(res, row);
});

permits.post('/:id/pay', requirePermission('permits.write'), requirePermission('payments.create'), validateBody(z.object({ amount: z.coerce.number().positive().optional() })), async (req, res) => {
  const existing = await prisma.parkingPermit.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Permit');
  assertFacilityAccess(req.user, existing.facilityId);
  created(res, await payPermitCash(existing.id, req.body.amount, req.user, req));
});
