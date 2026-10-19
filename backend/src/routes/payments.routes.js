import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { can } from '../config/permissions.js';
import { assertFacilityAccess, authenticate, requirePermission, scopeFacility } from '../middleware/auth.js';
import { sensitiveLimiter, validateBody } from '../middleware/common.js';
import { audit } from '../services/audit.js';
import * as payments from '../services/payments.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { parseRange } from '../utils/dates.js';
import { pageMeta, parsePagination, parseSort } from '../utils/pagination.js';
import { ok } from '../utils/respond.js';
import { sendCsv } from '../utils/csv.js';

export const webhookRouter = Router();
export const router = Router();

// Provider callbacks are authenticated by signature, not by user token. Needs req.rawBody (see app.js).
webhookRouter.post('/:provider', async (req, res) => {
  if (!req.rawBody) throw badRequest('Missing request body');
  const result = await payments.processWebhook(req.params.provider, req.rawBody, req.headers['x-signature'], req);
  ok(res, { received: true, duplicate: result.duplicate });
});

router.use(authenticate);

const createSchema = z.object({
  sessionId: z.string().min(1),
  method: z.enum(['CASH', 'MOBILE_MONEY', 'BANK', 'CARD']),
  provider: z.enum(['mtn-momo', 'airtel-money', 'equity-bank']).optional(),
  amount: z.coerce.number().positive().optional(),
  payerPhone: z.string().trim().regex(/^\+?\d{9,15}$/, 'Enter a valid phone number').optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
});

router.post('/', requirePermission('payments.create'), sensitiveLimiter, validateBody(createSchema), async (req, res) => {
  if (req.body.discountPercent && !can(req.user.role, 'sessions.exempt')) throw forbidden('You are not allowed to grant discounts');
  const session = await prisma.parkingSession.findUnique({ where: { id: req.body.sessionId } });
  if (!session) throw notFound('Parking session');
  assertFacilityAccess(req.user, session.facilityId);
  const idempotencyKey = req.body.idempotencyKey || req.headers['idempotency-key']?.toString();
  const { payment, replay } = await payments.createPayment({ ...req.body, idempotencyKey, user: req.user, req });
  res.status(replay ? 200 : 201).json({ success: true, data: payment, meta: { replay } });
});

router.get('/', requirePermission('payments.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const range = req.query.from || req.query.to ? parseRange(req.query, 365) : null;
  const where = {
    ...(facilityId ? { facilityId } : {}),
    ...(['PENDING', 'SUCCESS', 'FAILED', 'REFUNDED'].includes(req.query.status) ? { status: req.query.status } : {}),
    ...(['CASH', 'MOBILE_MONEY', 'BANK', 'CARD'].includes(req.query.method) ? { method: req.query.method } : {}),
    ...(range ? { createdAt: { gte: range.from, lte: range.to } } : {}),
    ...(req.query.search ? { OR: [{ reference: { contains: String(req.query.search), mode: 'insensitive' } }, { providerReference: { contains: String(req.query.search), mode: 'insensitive' } }, { session: { plate: { contains: String(req.query.search).toUpperCase().replace(/[^A-Z0-9]/g, '') || '-' } } }] } : {}),
  };
  const include = { session: { select: { plate: true, ticketNo: true } }, receipt: { select: { id: true, number: true } } };
  const orderBy = parseSort(req.query, ['createdAt', 'amount', 'status', 'paidAt'], { createdAt: 'desc' });

  if (req.query.format === 'csv') {
    if (!can(req.user.role, 'export')) throw forbidden();
    const rows = await prisma.payment.findMany({ where, orderBy, take: 10000, include });
    await audit(req, { action: 'EXPORT', entity: 'Payment', metadata: { rows: rows.length, filters: req.query } });
    return sendCsv(res, 'payments.csv', rows.map((p) => ({ reference: p.reference, plate: p.session?.plate ?? '', method: p.method, status: p.status, amount: p.amount.toString(), currency: p.currency, provider: p.provider, simulated: p.isSimulated, created_at: p.createdAt, paid_at: p.paidAt ?? '', reconciled: !!p.reconciledAt })));
  }
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ where, skip, take, orderBy, include }),
    prisma.payment.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

// --- Reconciliation (declared before /:id) ---
async function dayBounds(dateStr) {
  const base = dateStr ? new Date(`${dateStr}T00:00:00+02:00`) : new Date();
  if (Number.isNaN(base.getTime())) throw badRequest('date must be YYYY-MM-DD');
  const { startOfToday } = await import('../utils/dates.js');
  const start = dateStr ? base : startOfToday();
  return { start, end: new Date(start.getTime() + 86400000) };
}

router.get('/reconciliation/summary', requirePermission('payments.read'), async (req, res) => {
  const { start, end } = await dayBounds(req.query.date?.toString());
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const where = { paidAt: { gte: start, lt: end }, status: { in: ['SUCCESS', 'REFUNDED'] }, ...(facilityId ? { facilityId } : {}) };
  const groups = await prisma.payment.groupBy({ by: ['method', 'status'], where, _sum: { amount: true }, _count: true });
  const unreconciled = await prisma.payment.count({ where: { ...where, status: 'SUCCESS', reconciledAt: null } });
  const pending = await prisma.payment.count({ where: { createdAt: { gte: start, lt: end }, status: 'PENDING', ...(facilityId ? { facilityId } : {}) } });
  ok(res, {
    date: start.toISOString(), unreconciled, pending,
    rows: groups.map((g) => ({ method: g.method, status: g.status, count: g._count, amount: String(g._sum.amount ?? 0) })),
  });
});

router.post('/reconciliation/close', requirePermission('payments.reconcile'), validateBody(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), facilityId: z.string().optional(), note: z.string().max(300).optional() })), async (req, res) => {
  const { start, end } = await dayBounds(req.body.date);
  const facilityId = scopeFacility(req.user, req.body.facilityId);
  const pending = await prisma.payment.count({ where: { createdAt: { gte: start, lt: end }, status: 'PENDING', ...(facilityId ? { facilityId } : {}) } });
  if (pending) throw badRequest(`${pending} payment(s) are still pending; resolve them before closing the day`);
  const result = await prisma.payment.updateMany({
    where: { paidAt: { gte: start, lt: end }, status: 'SUCCESS', reconciledAt: null, ...(facilityId ? { facilityId } : {}) },
    data: { reconciledAt: new Date(), reconciledById: req.user.id },
  });
  await audit(req, { action: 'PAYMENTS_RECONCILED', entity: 'Payment', metadata: { date: req.body.date, facilityId, count: result.count, note: req.body.note } });
  ok(res, { reconciled: result.count });
});

router.get('/:id', requirePermission('payments.read'), async (req, res) => {
  const p = await prisma.payment.findUnique({ where: { id: req.params.id }, include: { receipt: true, session: { include: { facility: true } } } });
  if (!p) throw notFound('Payment');
  assertFacilityAccess(req.user, p.facilityId);
  ok(res, p);
});

router.get('/:id/receipt', requirePermission('receipts.read'), async (req, res) => {
  const p = await prisma.payment.findUnique({ where: { id: req.params.id }, include: { receipt: true } });
  if (!p) throw notFound('Payment');
  assertFacilityAccess(req.user, p.facilityId);
  if (!p.receipt) throw notFound('Receipt (payment has not succeeded)');
  ok(res, p.receipt);
});

router.post('/:id/refund', requirePermission('payments.refund'), sensitiveLimiter, validateBody(z.object({ reason: z.string().trim().min(5).max(300) })), async (req, res) => {
  const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!p) throw notFound('Payment');
  assertFacilityAccess(req.user, p.facilityId);
  ok(res, await payments.refundPayment(p.id, req.body.reason, req.user, req));
});

// Development only (PAYMENT_MODE=simulation): triggers a signed provider callback for a pending simulated payment.
router.post('/:id/simulate-callback', requirePermission('payments.create'), validateBody(z.object({ status: z.enum(['SUCCESS', 'FAILED']) })), async (req, res) => {
  ok(res, await payments.simulateCallback(req.params.id, req.body.status, req));
});

export default router;
