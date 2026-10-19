import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { can } from '../config/permissions.js';
import { requirePermission, requireRole, scopeFacility } from '../middleware/auth.js';
import { validateBody } from '../middleware/common.js';
import { resolveUpload } from '../middleware/upload.js';
import { audit } from '../services/audit.js';
import * as dashboard from '../services/dashboard.js';
import { runMaintenance } from '../services/jobs.js';
import { REPORTS, runReport } from '../services/reports.js';
import { SETTING_DEFAULTS, getAllSettings, setSetting } from '../services/settings.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/errors.js';
import { parseRange } from '../utils/dates.js';
import { pageMeta, parsePagination } from '../utils/pagination.js';
import { ok } from '../utils/respond.js';
import { sendCsv } from '../utils/csv.js';

// ---------------- Dashboard ----------------
export const dashboardRouter = Router();
dashboardRouter.use(requirePermission('dashboard.read'));

const FINANCE_KEYS = ['revenueToday', 'paymentsToday', 'pendingPayments', 'failedPaymentsToday', 'outstanding'];

dashboardRouter.get('/summary', async (req, res) => {
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const summary = await dashboard.getSummary(facilityId);
  // Users without finance access never receive money figures, even in the raw API response.
  if (!can(req.user.role, 'reports.finance')) for (const k of FINANCE_KEYS) delete summary[k];
  ok(res, summary);
});
dashboardRouter.get('/revenue', requirePermission('reports.finance'), async (req, res) => {
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  ok(res, await dashboard.getRevenueTrend(facilityId, Math.min(90, Math.max(2, parseInt(req.query.days, 10) || 14))));
});
dashboardRouter.get('/occupancy', async (req, res) => {
  ok(res, await dashboard.getOccupancy(scopeFacility(req.user, req.query.facilityId?.toString())));
});
dashboardRouter.get('/recent-activity', async (req, res) => {
  const activity = await dashboard.getRecentActivity(scopeFacility(req.user, req.query.facilityId?.toString()), Math.min(50, parseInt(req.query.limit, 10) || 15));
  ok(res, can(req.user.role, 'reports.finance') ? activity : activity.map(({ total, ...rest }) => rest));
});

// ---------------- Reports ----------------
export const reportsRouter = Router();

reportsRouter.get('/', requirePermission('reports.read'), (req, res) => {
  ok(res, Object.entries(REPORTS).filter(([, d]) => can(req.user.role, d.permission)).map(([key, d]) => ({ key, title: d.title })));
});

reportsRouter.get('/:type', requirePermission('reports.read'), async (req, res) => {
  const def = REPORTS[req.params.type];
  if (!def) throw notFound('Report');
  if (!can(req.user.role, def.permission)) throw forbidden('You do not have access to this report');
  const range = parseRange(req.query);
  if (!range) throw badRequest('Invalid date range');
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const result = await runReport(req.params.type, { ...range, facilityId, period: req.query.period?.toString() });
  if (req.query.format === 'csv') {
    if (!can(req.user.role, 'export')) throw forbidden('You are not allowed to export data');
    await audit(req, { action: 'EXPORT', entity: 'Report', metadata: { type: req.params.type, rows: result.rows.length } });
    return sendCsv(res, `${req.params.type}-report.csv`, result.rows, result.columns);
  }
  ok(res, { ...result, range, facilityId: facilityId ?? null });
});

// ---------------- Notifications ----------------
export const notificationsRouter = Router();
notificationsRouter.use(requirePermission('notifications.read'));

const visibleTo = (user) => (user.facilityId ? { OR: [{ facilityId: user.facilityId }, { facilityId: null }] } : {});

notificationsRouter.get('/', async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const base = visibleTo(req.user);
  const where = {
    ...base,
    ...(req.query.type ? { type: String(req.query.type) } : {}),
    ...(req.query.severity ? { severity: String(req.query.severity) } : {}),
    ...(req.query.unread === 'true' ? { reads: { none: { userId: req.user.id } } } : {}),
  };
  const [rows, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { reads: { where: { userId: req.user.id }, select: { readAt: true } } } }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...base, reads: { none: { userId: req.user.id } } } }),
  ]);
  ok(res, rows.map(({ reads, ...n }) => ({ ...n, read: reads.length > 0 })), { ...pageMeta(page, limit, total), unread });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const unread = await prisma.notification.findMany({ where: { ...visibleTo(req.user), reads: { none: { userId: req.user.id } } }, select: { id: true }, take: 1000 });
  await prisma.notificationRead.createMany({ data: unread.map((n) => ({ userId: req.user.id, notificationId: n.id })), skipDuplicates: true });
  ok(res, { marked: unread.length });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const n = await prisma.notification.findFirst({ where: { id: req.params.id, ...visibleTo(req.user) } });
  if (!n) throw notFound('Notification');
  await prisma.notificationRead.upsert({
    where: { userId_notificationId: { userId: req.user.id, notificationId: n.id } }, update: {}, create: { userId: req.user.id, notificationId: n.id },
  });
  ok(res, { read: true });
});

// ---------------- Audit logs (read-only) ----------------
export const auditRouter = Router();
auditRouter.get('/', requirePermission('audit.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query, { defaultLimit: 25 });
  const range = req.query.from || req.query.to ? parseRange(req.query, 365) : null;
  let actorFilter = {};
  if (req.user.facilityId) {
    // Facility-bound administrators only see activity of people in their facility.
    const ids = (await prisma.user.findMany({ where: { facilityId: req.user.facilityId }, select: { id: true } })).map((u) => u.id);
    actorFilter = { actorId: { in: ids } };
  }
  const where = {
    ...actorFilter,
    ...(req.query.action ? { action: { contains: String(req.query.action).toUpperCase() } } : {}),
    ...(req.query.entity ? { entity: String(req.query.entity) } : {}),
    ...(req.query.result ? { result: String(req.query.result) } : {}),
    ...(req.query.actor ? { actorEmail: { contains: String(req.query.actor), mode: 'insensitive' } } : {}),
    ...(range ? { createdAt: { gte: range.from, lte: range.to } } : {}),
  };
  if (req.query.format === 'csv') {
    if (!can(req.user.role, 'export')) throw forbidden();
    const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10000 });
    return sendCsv(res, 'audit-log.csv', rows.map((r) => ({ time: r.createdAt, actor: r.actorEmail ?? '', action: r.action, entity: r.entity ?? '', entity_id: r.entityId ?? '', result: r.result, ip: r.ip ?? '', metadata: r.metadata ?? '' })));
  }
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.auditLog.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

// ---------------- System settings ----------------
export const settingsRouter = Router();

const validators = {
  'plate.formats': z.array(z.object({ name: z.string().min(1).max(60), pattern: z.string().max(200).refine((p) => { try { new RegExp(p); return true; } catch { return false; } }, 'Invalid regular expression') })).max(50),
  'access.allowUnregistered': z.boolean(),
  'anpr.minConfidence': z.number().min(0).max(1),
  'org.name': z.string().min(1).max(100),
  'telephone.sms_sender': z.string().min(1).max(11),
  'telephone.support_line': z.string().max(30),
  'telephone.mtn_momo': z.string().max(30),
  'telephone.airtel_money': z.string().max(30),
  'telephone.equity_bank': z.string().max(40),
  'org.receiptFooter': z.string().max(200),
  'permit.expiryWarningDays': z.number().int().min(1).max(90),
  'reservation.noShowGraceMinutes': z.number().int().min(0).max(240),
};

settingsRouter.get('/', requirePermission('settings.read', 'pricing.read'), async (_req, res) => ok(res, await getAllSettings()));

settingsRouter.put('/:key', requirePermission('settings.write'), validateBody(z.object({ value: z.any() })), async (req, res) => {
  const key = req.params.key;
  if (!(key in SETTING_DEFAULTS)) throw badRequest(`Unknown setting "${key}"`);
  const value = validators[key].parse(req.body.value);
  const before = (await getAllSettings()).find((s) => s.key === key)?.value;
  const row = await setSetting(key, value, req.user.id);
  await audit(req, { action: 'SETTING_CHANGED', entity: 'SystemSetting', entityId: key, metadata: { before, after: value } });
  ok(res, row);
});

// ---------------- Uploaded files (authenticated; never served statically) ----------------
export const filesRouter = Router();
filesRouter.get('/:name', requirePermission('anpr.read', 'vehicles.read'), async (req, res) => {
  const scan = await prisma.recognitionEvent.findFirst({ where: { imagePath: req.params.name }, select: { imageData: true, imageMime: true } });
  if (scan?.imageData) {
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Type', scan.imageMime || 'image/jpeg');
    return res.send(Buffer.from(scan.imageData));
  }
  const full = resolveUpload(req.params.name);
  if (!full || !fs.existsSync(full)) throw notFound('File');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(full);
});

// ---------------- SMS outbox (read-only; passwords are masked) ----------------
export const smsRouter = Router();
smsRouter.get('/', requirePermission('users.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const [rows, total] = await Promise.all([
    prisma.smsMessage.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.smsMessage.count(),
  ]);
  ok(res, rows, { ...pageMeta(page, limit, total), mode: env.SMS_MODE, configured: env.SMS_MODE === 'africastalking' ? !!(env.AT_USERNAME && env.AT_API_KEY) : env.SMS_MODE === 'http' ? !!(env.SMS_API_URL && env.SMS_API_KEY) : false });
});

// ---------------- System ----------------
export const systemRouter = Router();
systemRouter.post('/maintenance', requireRole('SUPER_ADMIN'), async (req, res) => {
  const summary = await runMaintenance();
  await audit(req, { action: 'MAINTENANCE_RUN', entity: 'System', metadata: summary });
  ok(res, summary);
});
systemRouter.get('/info', requireRole('SUPER_ADMIN'), (_req, res) => {
  ok(res, {
    nodeEnv: process.env.NODE_ENV, anprMode: process.env.ANPR_MODE || 'simulation', paymentMode: process.env.PAYMENT_MODE || 'simulation',
    version: '1.0.0', uptimeSeconds: Math.round(process.uptime()),
  });
});

export { AppError };
