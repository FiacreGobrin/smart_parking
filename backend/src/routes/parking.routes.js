import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { can } from '../config/permissions.js';
import { assertFacilityAccess, requirePermission, scopeFacility } from '../middleware/auth.js';
import { validateBody } from '../middleware/common.js';
import * as parking from '../services/parking.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { parseRange } from '../utils/dates.js';
import { normalizePlate } from '../utils/plate.js';
import { pageMeta, parsePagination, parseSort } from '../utils/pagination.js';
import { created, ok } from '../utils/respond.js';
import { sendCsv } from '../utils/csv.js';

const router = Router();

const entrySchema = z.object({
  plate: z.string().trim().min(3).max(20),
  facilityId: z.string().optional(),
  gateId: z.string().optional(),
  vehicleType: z.enum(['CAR', 'MOTORCYCLE', 'BUS', 'TRUCK', 'OTHER']).optional(),
  spaceId: z.string().optional(),
  notes: z.string().max(300).optional(),
  service: z.enum(['PARKING', 'GARAGE', 'CAR_WASH']).default('PARKING'),
  billingUnit: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'VISIT']).optional(),
});

const exitSchema = z.object({
  sessionId: z.string().optional(),
  plate: z.string().trim().min(3).max(20).optional(),
  gateId: z.string().optional(),
  exempt: z.boolean().optional(),
  exemptReason: z.string().trim().min(3).max(200).optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
}).refine((v) => v.sessionId || v.plate, { message: 'sessionId or plate is required' })
  .refine((v) => !v.exempt || v.exemptReason, { message: 'A reason is required for an exemption', path: ['exemptReason'] });

function assertOverridePermission(user, body) {
  if ((body.exempt || body.discountPercent) && !can(user.role, 'sessions.exempt')) {
    throw forbidden('You are not allowed to grant exemptions or discounts');
  }
}

router.post('/entry', requirePermission('sessions.write'), validateBody(entrySchema), async (req, res) => {
  const { gateId, facilityId } = req.body;
  let fid = facilityId;
  if (gateId) {
    const gate = await prisma.gate.findUnique({ where: { id: gateId } });
    if (!gate) throw notFound('Gate');
    fid = fid || gate.facilityId;
  }
  fid = await parking.resolveFacilityId(req.user, fid);
  assertFacilityAccess(req.user, fid);
  const session = await parking.registerEntry({ ...req.body, facilityId: fid, user: req.user, req });
  created(res, session);
});

router.get('/exit-preview', requirePermission('sessions.read'), async (req, res) => {
  const preview = await parking.previewExit({ sessionId: req.query.sessionId?.toString(), plate: req.query.plate?.toString() });
  assertFacilityAccess(req.user, preview.session.facilityId);
  ok(res, preview);
});

router.post('/exit', requirePermission('sessions.write'), validateBody(exitSchema), async (req, res) => {
  assertOverridePermission(req.user, req.body);
  const active = await parking.findActiveSession({ sessionId: req.body.sessionId, plate: req.body.plate });
  assertFacilityAccess(req.user, active.facilityId);
  const session = await parking.registerExit({ ...req.body, sessionId: active.id, user: req.user, req });
  ok(res, session);
});

router.get('/sessions', requirePermission('sessions.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const range = req.query.from || req.query.to ? parseRange(req.query, 365) : null;
  if ((req.query.from || req.query.to) && !range) throw badRequest('Invalid date range');
  const where = {
    ...(facilityId ? { facilityId } : {}),
    ...(['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(req.query.status) ? { status: req.query.status } : {}),
    ...(req.query.vehicleType ? { vehicleType: String(req.query.vehicleType) } : {}),
    ...(['PARKING', 'GARAGE', 'CAR_WASH'].includes(req.query.service) ? { service: req.query.service } : {}),
    ...(range ? { entryAt: { gte: range.from, lte: range.to } } : {}),
    ...(req.query.search ? { OR: [{ plate: { contains: normalizePlate(req.query.search) || '-' } }, { ticketNo: { contains: String(req.query.search), mode: 'insensitive' } }] } : {}),
  };
  const include = { facility: { select: { name: true } }, space: { select: { code: true } }, vehicle: { select: { id: true, status: true } } };
  const orderBy = parseSort(req.query, ['entryAt', 'exitAt', 'plate', 'total', 'status'], { entryAt: 'desc' });

  if (req.query.format === 'csv') {
    if (!can(req.user.role, 'export')) throw forbidden();
    const rows = await prisma.parkingSession.findMany({ where, orderBy, take: 10000, include });
    return sendCsv(res, 'parking-sessions.csv', rows.map((s) => ({ ticket: s.ticketNo, plate: s.plate, facility: s.facility.name, space: s.space?.code ?? '', status: s.status, entry_at: s.entryAt, exit_at: s.exitAt ?? '', minutes: s.durationMinutes ?? '', total: s.total.toString(), paid: s.amountPaid.toString() })));
  }
  const [rows, total] = await Promise.all([
    prisma.parkingSession.findMany({ where, skip, take, orderBy, include }),
    prisma.parkingSession.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

router.get('/sessions/:id', requirePermission('sessions.read'), async (req, res) => {
  const session = await prisma.parkingSession.findUnique({
    where: { id: req.params.id },
    include: { facility: true, space: true, vehicle: { include: { owner: true } }, payments: { include: { receipt: true }, orderBy: { createdAt: 'desc' } } },
  });
  if (!session) throw notFound('Parking session');
  assertFacilityAccess(req.user, session.facilityId);
  ok(res, session);
});

router.post('/sessions/:id/cancel', requirePermission('sessions.exempt'), validateBody(z.object({ reason: z.string().trim().min(3).max(200) })), async (req, res) => {
  const s = await prisma.parkingSession.findUnique({ where: { id: req.params.id } });
  if (!s) throw notFound('Parking session');
  assertFacilityAccess(req.user, s.facilityId);
  await parking.cancelSession(s.id, req.body.reason, req.user, req);
  ok(res, { cancelled: true });
});

export default router;
