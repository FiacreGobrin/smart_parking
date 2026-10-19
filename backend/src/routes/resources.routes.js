import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { assertFacilityAccess, requirePermission, scopeFacility } from '../middleware/auth.js';
import { sensitiveLimiter, validateBody } from '../middleware/common.js';
import { assertImageFile, imageUpload } from '../middleware/upload.js';
import { audit } from '../services/audit.js';
import { COMMANDS, pingGate, sendGateCommand } from '../services/gateControl.js';
import { calculateFee, serializeFee } from '../services/pricing.js';
import { refreshOccupancy } from '../services/notify.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { normalizePlate } from '../utils/plate.js';
import { pageMeta, parsePagination } from '../utils/pagination.js';
import { created, ok } from '../utils/respond.js';
import * as v from '../validators/resources.js';
import { crud } from './crud.js';

export const facilities = crud({
  model: 'parkingFacility', entity: 'Facility', read: 'facilities.read', write: 'facilities.write',
  createSchema: v.facilitySchema, scope: 'id', archive: true,
  filters: ['isActive'], search: ['name', 'code', 'city'], sortable: ['name', 'code', 'createdAt'], defaultSort: { name: 'asc' },
  hooks: {
    async beforeDelete(existing, req) {
      if (req.user.role !== 'SUPER_ADMIN') throw forbidden('Only a super administrator can archive a facility');
      const active = await prisma.parkingSession.count({ where: { facilityId: existing.id, status: 'ACTIVE' } });
      if (active) throw conflict(`${active} vehicle(s) are still parked in this facility`);
    },
  },
});

export const zones = crud({
  model: 'parkingZone', entity: 'Zone', read: 'spaces.read', write: 'zones.write',
  createSchema: v.zoneSchema, filters: ['facilityId'], search: ['name', 'floor', 'section'], sortable: ['name', 'createdAt'], defaultSort: { name: 'asc' },
  include: { _count: { select: { spaces: true } } }, maxLimit: 500,
  hooks: {
    async beforeDelete(existing) {
      const n = await prisma.parkingSpace.count({ where: { zoneId: existing.id, archivedAt: null } });
      if (n) throw conflict(`Zone still contains ${n} space(s); move or archive them first`);
    },
  },
});

async function assertZoneMatches(facilityId, zoneId) {
  if (!zoneId) return;
  const zone = await prisma.parkingZone.findUnique({ where: { id: zoneId } });
  if (!zone || zone.facilityId !== facilityId) throw badRequest('Zone does not belong to the selected facility');
}

export const spaces = crud({
  model: 'parkingSpace', entity: 'Space', read: 'spaces.read', write: 'spaces.write',
  createSchema: v.spaceSchema, archive: true, filters: ['facilityId', 'zoneId', 'type', 'status'],
  search: ['code'], sortable: ['code', 'status', 'type', 'createdAt'], defaultSort: { code: 'asc' }, maxLimit: 1000,
  include: { zone: { select: { id: true, name: true, floor: true } } },
  hooks: {
    async beforeCreate(data) {
      await assertZoneMatches(data.facilityId, data.zoneId);
    },
    async beforeUpdate(data, _req, existing) {
      if (data.zoneId) await assertZoneMatches(existing.facilityId, data.zoneId);
      if (data.status && data.status !== existing.status) {
        const active = await prisma.parkingSession.count({ where: { spaceId: existing.id, status: 'ACTIVE' } });
        // Occupancy is driven by sessions; manual overrides must not contradict them.
        if (active && data.status !== 'OCCUPIED') throw conflict('A vehicle is parked in this space; close its session first');
        if (!active && data.status === 'OCCUPIED') throw conflict('Occupied status is set automatically when a vehicle enters');
        await prisma.spaceStatusHistory.create({ data: { spaceId: existing.id, fromStatus: existing.status, toStatus: data.status, reason: 'Manual change' } });
      }
    },
    async beforeDelete(existing) {
      const active = await prisma.parkingSession.count({ where: { spaceId: existing.id, status: 'ACTIVE' } });
      if (active) throw conflict('A vehicle is parked in this space');
    },
    async afterChange(row) {
      await refreshOccupancy(row.facilityId);
    },
  },
});

// Creates many numbered spaces in one request (e.g. A01..A40).
spaces.post('/bulk', requirePermission('spaces.write'), validateBody(v.bulkSpacesSchema), async (req, res) => {
  const { facilityId, zoneId, prefix, from, to, pad, type } = req.body;
  assertFacilityAccess(req.user, facilityId);
  if (!(await prisma.parkingFacility.findUnique({ where: { id: facilityId } }))) throw notFound('Facility');
  await assertZoneMatches(facilityId, zoneId);
  const data = [];
  for (let i = from; i <= to; i++) {
    data.push({ facilityId, zoneId: zoneId || null, type, code: `${prefix}${String(i).padStart(pad, '0')}`.toUpperCase() });
  }
  const result = await prisma.parkingSpace.createMany({ data, skipDuplicates: true });
  await audit(req, { action: 'SPACES_BULK_CREATED', entity: 'Space', metadata: { facilityId, requested: data.length, created: result.count } });
  await refreshOccupancy(facilityId);
  created(res, { requested: data.length, created: result.count, skipped: data.length - result.count });
});

spaces.get('/:id/history', requirePermission('spaces.read'), async (req, res) => {
  const space = await prisma.parkingSpace.findUnique({ where: { id: req.params.id } });
  if (!space) throw notFound('Space');
  assertFacilityAccess(req.user, space.facilityId);
  const { page, limit, skip, take } = parsePagination(req.query);
  const [rows, total] = await Promise.all([
    prisma.spaceStatusHistory.findMany({ where: { spaceId: space.id }, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.spaceStatusHistory.count({ where: { spaceId: space.id } }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

export const cameras = crud({
  model: 'camera', entity: 'Camera', read: 'cameras.read', write: 'cameras.write',
  createSchema: v.cameraSchema, filters: ['facilityId', 'status', 'gateId'], search: ['name'],
  sortable: ['name', 'status', 'createdAt'], defaultSort: { name: 'asc' },
  include: { gate: { select: { id: true, name: true, direction: true } } },
});

export const gates = crud({
  model: 'gate', entity: 'Gate', read: 'gates.read', write: 'gates.write',
  createSchema: v.gateSchema, updateSchema: v.gateUpdateSchema, filters: ['facilityId', 'status', 'direction'], search: ['name'],
  sortable: ['name', 'status', 'createdAt'], defaultSort: { name: 'asc' },
});

gates.get('/:id/events', requirePermission('gates.read'), async (req, res) => {
  const gate = await prisma.gate.findUnique({ where: { id: req.params.id } });
  if (!gate) throw notFound('Gate');
  assertFacilityAccess(req.user, gate.facilityId);
  const { page, limit, skip, take } = parsePagination(req.query);
  const where = { gateId: gate.id, ...(req.query.outcome ? { outcome: String(req.query.outcome) } : {}), ...(req.query.type ? { type: String(req.query.type) } : {}) };
  const [rows, total] = await Promise.all([
    prisma.gateEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.gateEvent.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

gates.post('/:id/commands', requirePermission('gates.command'), sensitiveLimiter,
  validateBody(z.object({ command: z.enum(COMMANDS), reason: z.string().trim().max(200).optional() })),
  async (req, res) => {
    const gate = await prisma.gate.findUnique({ where: { id: req.params.id } });
    if (!gate) throw notFound('Gate');
    assertFacilityAccess(req.user, gate.facilityId);
    ok(res, await sendGateCommand(gate.id, req.body.command, req.user, req, req.body.reason));
  });

gates.post('/:id/ping', requirePermission('gates.command'), sensitiveLimiter, async (req, res) => {
  const gate = await prisma.gate.findUnique({ where: { id: req.params.id } });
  if (!gate) throw notFound('Gate');
  assertFacilityAccess(req.user, gate.facilityId);
  ok(res, await pingGate(gate.id, req.user, req));
});

// Device events across all gates of the user's scope (live monitor feed).
export const gateEvents = Router();
gateEvents.get('/', requirePermission('gates.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const where = { ...(facilityId ? { gate: { facilityId } } : {}), ...(req.query.outcome ? { outcome: String(req.query.outcome) } : {}) };
  const [rows, total] = await Promise.all([
    prisma.gateEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { gate: { select: { name: true, direction: true } } } }),
    prisma.gateEvent.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

const SERVICE_LABEL = { PARKING: 'Parking', GARAGE: 'Garage', CAR_WASH: 'Car wash' };
const VEHICLE_LABEL = { CAR: 'Car', MOTORCYCLE: 'Motorbike', BUS: 'Bus', TRUCK: 'Truck', OTHER: 'Other' };
const rateName = (r) => `${SERVICE_LABEL[r.service]} - ${r.vehicleType ? VEHICLE_LABEL[r.vehicleType] : 'All vehicles'} - ${r.unit.toLowerCase()}`;

// Cross-field rules are checked on the merged record so PATCH cannot create an invalid price.
function checkRate(r) {
  const unitOk = r.service === 'PARKING' ? r.unit === 'HOUR' : r.service === 'CAR_WASH' ? r.unit === 'VISIT' : ['DAY', 'WEEK', 'MONTH'].includes(r.unit);
  if (!unitOk) throw badRequest('Parking is billed per hour, garage per day/week/month, car wash per visit');
  if (r.cap != null && Number(r.cap) < Number(r.startPrice)) throw badRequest('The cap cannot be below the start price');
}

export const rates = crud({
  model: 'parkingRate', entity: 'Rate', read: 'pricing.read', write: 'pricing.write',
  createSchema: v.rateSchema, updateSchema: v.rateUpdateSchema,
  filters: ['facilityId', 'vehicleType', 'isActive', 'service', 'unit'], search: ['name'], scopeIncludeNull: true,
  sortable: ['name', 'startPrice', 'createdAt', 'service'], defaultSort: { createdAt: 'asc' },
  include: { facility: { select: { name: true } } },
  hooks: {
    async beforeCreate(data) {
      checkRate(data);
      return { ...data, name: rateName(data) };
    },
    async beforeUpdate(data, _req, existing) {
      const merged = { ...existing, ...data };
      checkRate(merged);
      return { ...data, name: rateName(merged) };
    },
  },
});

// Stateless fee preview for the pricing screen: same engine as real charges, nothing is stored.
rates.post('/preview', requirePermission('pricing.read'), validateBody(z.object({
  unit: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'VISIT']),
  startPrice: z.coerce.number().min(0), increment: z.coerce.number().min(0).default(0), cap: z.coerce.number().min(0).nullable().optional(),
  minutes: z.coerce.number().int().min(0).max(525600),
})), async (req, res) => {
  const { unit, startPrice, increment, cap, minutes } = req.body;
  const now = new Date();
  const fee = calculateFee({ entryAt: now, exitAt: new Date(now.getTime() + minutes * 60000), rate: { unit, startPrice, increment, cap } });
  ok(res, serializeFee(fee));
});

export const vehicles = crud({
  model: 'vehicle', entity: 'Vehicle', read: 'vehicles.read', write: 'vehicles.write', scope: null, archive: true,
  createSchema: v.vehicleCreateSchema, updateSchema: v.vehicleUpdateSchema,
  filters: ['type', 'status'], search: ['plate', 'make', 'color'], sortable: ['plate', 'createdAt', 'status'],
  include: { owner: true },
  hooks: {
    async beforeCreate(data) {
      const existing = await prisma.vehicle.findUnique({ where: { plate: data.plate } });
      if (existing && !existing.archivedAt) throw conflict(`Vehicle ${data.plate} is already registered`);
      if (existing?.archivedAt) throw conflict(`Vehicle ${data.plate} exists in the archive; restore it instead`);
    },
    async beforeUpdate(data, _req, existing) {
      if (data.plate && data.plate !== existing.plate) {
        const clash = await prisma.vehicle.findUnique({ where: { plate: data.plate } });
        if (clash) throw conflict(`Vehicle ${data.plate} is already registered`);
      }
      const status = data.status ?? existing.status;
      const reason = data.restrictionReason ?? existing.restrictionReason;
      if (status === 'RESTRICTED' && !reason) throw badRequest('A reason is required for restricted vehicles');
      if (status !== 'RESTRICTED') data.restrictionReason = null;
    },
  },
});

vehicles.get('/lookup/:plate', requirePermission('vehicles.read'), async (req, res) => {
  const plate = normalizePlate(req.params.plate);
  const [vehicle, active] = await Promise.all([
    prisma.vehicle.findUnique({ where: { plate }, include: { owner: true } }),
    prisma.parkingSession.findFirst({ where: { plate, status: 'ACTIVE' }, include: { space: true } }),
  ]);
  ok(res, { plate, vehicle, activeSession: active });
});

vehicles.get('/:id/history', requirePermission('vehicles.read'), async (req, res) => {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id }, include: { owner: true } });
  if (!vehicle) throw notFound('Vehicle');
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user);
  const where = { plate: vehicle.plate, ...(facilityId ? { facilityId } : {}) };
  const [sessions, total, recognitions, stats] = await Promise.all([
    prisma.parkingSession.findMany({ where, orderBy: { entryAt: 'desc' }, skip, take, include: { facility: { select: { name: true } }, space: { select: { code: true } } } }),
    prisma.parkingSession.count({ where }),
    prisma.recognitionEvent.findMany({ where: { plate: vehicle.plate }, omit: { imageData: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.parkingSession.aggregate({ where: { ...where, status: 'COMPLETED' }, _sum: { total: true }, _avg: { durationMinutes: true }, _count: true }),
  ]);
  ok(res, {
    vehicle, sessions, recognitions,
    stats: { visits: stats._count, totalSpent: String(stats._sum.total ?? 0), avgMinutes: Math.round(stats._avg.durationMinutes ?? 0) },
  }, pageMeta(page, limit, total));
});

vehicles.post('/:id/image', requirePermission('vehicles.write'), imageUpload.single('image'), async (req, res) => {
  if (!req.file) throw badRequest('An image file is required (field "image")');
  assertImageFile(req.file);
  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
  if (!vehicle) throw notFound('Vehicle');
  const updated = await prisma.vehicle.update({ where: { id: vehicle.id }, data: { imagePath: req.file.filename } });
  await audit(req, { action: 'VEHICLE_IMAGE_UPLOADED', entity: 'Vehicle', entityId: vehicle.id });
  ok(res, updated);
});
