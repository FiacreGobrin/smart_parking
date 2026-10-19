import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { can } from '../config/permissions.js';
import { requirePermission, scopeFacility } from '../middleware/auth.js';
import { validateBody } from '../middleware/common.js';
import { NEEDS_FACILITY, approveUser, generateCredentials, resetCredentials, sendCredentialsSms } from '../services/accounts.js';
import { audit } from '../services/audit.js';
import { hashPassword, passwordSchema, publicUser } from '../services/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { isNationalId, normalizeRwPhone } from '../utils/identity.js';
import { pageMeta, parsePagination, parseSort } from '../utils/pagination.js';
import { created, ok } from '../utils/respond.js';

const router = Router();
const ROLES = ['USER', 'ATTENDANT', 'PARKING_ADMIN', 'FINANCE_OFFICER', 'VIEWER', 'SUPER_ADMIN'];
const STAFF_ROLES = ['USER', 'ATTENDANT', 'VIEWER']; // what a parking administrator may manage

const phoneField = z.string().trim().min(1, 'Phone number is required').transform((v, ctx) => {
  const n = normalizeRwPhone(v);
  if (!n) ctx.addIssue({ code: 'custom', message: 'Use a Rwandan number like 0788 123 456' });
  return n;
});
const nationalIdField = z.string().trim().refine(isNationalId, 'National ID must be 16 digits');

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: phoneField,
  nationalId: nationalIdField,
  role: z.enum(ROLES),
  facilityId: z.string().nullable().optional(),
  // From POST /users/generate. When omitted the server generates its own.
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{4,30}$/, 'Username: 4-30 letters, digits or underscore').optional(),
  password: passwordSchema.optional(),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits').optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phone: phoneField.optional(),
  nationalId: nationalIdField.optional(),
  role: z.enum(ROLES).optional(),
  facilityId: z.string().nullable().optional(),
});

// Super admins manage everyone; parking admins manage users/attendants/viewers in their own facility.
function assertCanManage(actor, { role, facilityId }) {
  if (actor.role === 'SUPER_ADMIN') return;
  if (!can(actor.role, 'users.write.staff')) throw forbidden();
  if (!STAFF_ROLES.includes(role)) throw forbidden('You can only manage users, attendants and viewers');
  if (!actor.facilityId || facilityId !== actor.facilityId) throw forbidden('You can only manage people of your own facility');
}

async function lastSuperAdminGuard(target) {
  if (target.role !== 'SUPER_ADMIN') return;
  const others = await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE', archivedAt: null, id: { not: target.id } } });
  if (others === 0) throw badRequest('At least one active super administrator is required');
}

const withFacilityDefault = async (data) => {
  if (!NEEDS_FACILITY.includes(data.role) || data.facilityId) return data;
  const f = await prisma.parkingFacility.findMany({ where: { archivedAt: null }, select: { id: true }, take: 2 });
  if (f.length === 1) return { ...data, facilityId: f[0].id };
  throw badRequest('Choose a facility for this role');
};

const scopedWhere = (user) => ({ archivedAt: null, ...(user.facilityId ? { OR: [{ facilityId: user.facilityId }, { facilityId: null, status: 'PENDING' }] } : {}) });

router.get('/stats', requirePermission('users.read'), async (req, res) => {
  const groups = await prisma.user.groupBy({ by: ['status'], where: scopedWhere(req.user), _count: true });
  const c = Object.fromEntries(groups.map((g) => [g.status, g._count]));
  ok(res, { all: Object.values(c).reduce((a, b) => a + b, 0), pending: c.PENDING || 0, active: c.ACTIVE || 0, blocked: c.BLOCKED || 0 });
});

router.get('/', requirePermission('users.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const search = req.query.search ? String(req.query.search) : null;
  const where = {
    AND: [
      scopedWhere(req.user),
      ...(facilityId && !req.user.facilityId ? [{ facilityId }] : []),
      ...(ROLES.includes(req.query.role) ? [{ role: req.query.role }] : []),
      ...(['PENDING', 'ACTIVE', 'BLOCKED'].includes(req.query.status) ? [{ status: req.query.status }] : []),
      ...(search ? [{ OR: [
        { name: { contains: search, mode: 'insensitive' } }, { username: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search.replace(/\D/g, '') || '-' } }, { nationalId: { contains: search.replace(/\D/g, '') || '-' } },
      ] }] : []),
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, skip, take, orderBy: parseSort(req.query, ['name', 'username', 'status', 'createdAt', 'lastLoginAt']), include: { facility: { select: { name: true } } } }),
    prisma.user.count({ where }),
  ]);
  ok(res, rows.map((u) => ({ ...publicUser(u), facility: u.facility })), pageMeta(page, limit, total));
});

// Suggests a code, username and password. Stateless: the user is only created by POST /users.
router.post('/generate', requirePermission('users.write.staff'), validateBody(z.object({ name: z.string().trim().min(2), phone: z.string().trim().min(1), userId: z.string().optional() })), async (req, res) => {
  ok(res, await generateCredentials(req.body));
});

router.get('/:id', requirePermission('users.read'), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user || user.archivedAt) throw notFound('User');
  if (req.user.facilityId && user.facilityId && user.facilityId !== req.user.facilityId) throw forbidden();
  ok(res, publicUser(user));
});

router.post('/', requirePermission('users.write.staff'), validateBody(createSchema), async (req, res) => {
  const { password: given, code: givenCode, username: givenName, ...rest } = req.body;
  const data = await withFacilityDefault(rest);
  assertCanManage(req.user, data);
  const clash = await prisma.user.findFirst({ where: { OR: [{ phone: data.phone }, { nationalId: data.nationalId }] } });
  if (clash) throw conflict('Another user already has this phone number or national ID');
  const generated = await generateCredentials({ name: data.name, phone: data.phone });
  const creds = { code: givenCode || generated.code, username: givenName || generated.username, password: given || generated.password };
  if (await prisma.user.findUnique({ where: { username: creds.username } })) throw conflict('That username is already taken. Generate again.');
  const user = await prisma.user.create({
    data: { ...data, username: creds.username, passwordHash: await hashPassword(creds.password), activationCodeHash: await bcrypt.hash(creds.code, 8), mustChangePassword: true, status: 'ACTIVE' },
  });
  const sms = await sendCredentialsSms({ user, ...creds });
  await audit(req, { action: 'USER_CREATED', entity: 'User', entityId: user.id, metadata: { role: user.role, username: user.username, sms: sms.detail } });
  created(res, { ...publicUser(user), credentials: creds, sms });
});

router.patch('/:id', requirePermission('users.write.staff'), validateBody(updateSchema), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.archivedAt) throw notFound('User');
  assertCanManage(req.user, { role: target.role, facilityId: target.facilityId ?? req.user.facilityId });
  const next = { role: req.body.role ?? target.role, facilityId: req.body.facilityId === undefined ? target.facilityId : req.body.facilityId };
  if (target.status !== 'PENDING' || next.facilityId) assertCanManage(req.user, next);
  if (target.id === req.user.id && req.body.role && req.body.role !== target.role) throw badRequest('You cannot change your own role');
  if (req.body.role && req.body.role !== 'SUPER_ADMIN') await lastSuperAdminGuard(target);
  for (const [field, value] of [['phone', req.body.phone], ['nationalId', req.body.nationalId]]) {
    if (value && value !== target[field] && (await prisma.user.findFirst({ where: { [field]: value, id: { not: target.id } } }))) throw conflict(`Another user already has this ${field === 'phone' ? 'phone number' : 'national ID'}`);
  }
  const user = await prisma.user.update({ where: { id: target.id }, data: req.body });
  if (req.body.role && req.body.role !== target.role) await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, { action: req.body.role && req.body.role !== target.role ? 'USER_ROLE_CHANGED' : 'USER_UPDATED', entity: 'User', entityId: user.id, metadata: { changes: Object.keys(req.body) } });
  ok(res, publicUser(user));
});

// Approve a pending sign-up: generates credentials, activates the account and "sends" them by SMS.
router.post('/:id/approve', requirePermission('users.write.staff'), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.archivedAt) throw notFound('User');
  if (target.status !== 'PENDING') throw conflict('Only pending sign-ups can be approved');
  assertCanManage(req.user, { role: target.role, facilityId: target.facilityId ?? req.user.facilityId });
  const { user, credentials, sms } = await approveUser(target, req.user, req);
  ok(res, { ...publicUser(user), credentials, sms });
});

// New code, username and password for an existing account (for example a forgotten password). Keeps its status.
router.post('/:id/credentials', requirePermission('users.write.staff'), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.archivedAt) throw notFound('User');
  if (target.status === 'PENDING') throw conflict('Approve this sign-up instead');
  assertCanManage(req.user, { role: target.role, facilityId: target.facilityId ?? req.user.facilityId });
  const { user, credentials, sms } = await resetCredentials(target, req.user, req);
  ok(res, { ...publicUser(user), credentials, sms });
});

async function setStatus(req, res, status, action) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.archivedAt) throw notFound('User');
  assertCanManage(req.user, { role: target.role, facilityId: target.facilityId ?? req.user.facilityId });
  if (status === 'BLOCKED') {
    if (target.id === req.user.id) throw badRequest('You cannot block your own account');
    await lastSuperAdminGuard(target);
  }
  if (status === 'ACTIVE' && target.status !== 'BLOCKED') throw conflict('Only blocked users can be unblocked');
  if (status === 'BLOCKED' && target.status === 'PENDING') throw conflict('Reject pending sign-ups by deleting them');
  const user = await prisma.user.update({ where: { id: target.id }, data: { status, failedLogins: 0, lockedUntil: null } });
  if (status === 'BLOCKED') await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, { action, entity: 'User', entityId: user.id });
  ok(res, publicUser(user));
}
router.post('/:id/block', requirePermission('users.write.staff'), (req, res) => setStatus(req, res, 'BLOCKED', 'USER_BLOCKED'));
router.post('/:id/unblock', requirePermission('users.write.staff'), (req, res) => setStatus(req, res, 'ACTIVE', 'USER_UNBLOCKED'));

// Users are archived, never hard-deleted, so audit history keeps resolving to a person.
router.delete('/:id', requirePermission('users.write.staff'), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.archivedAt) throw notFound('User');
  assertCanManage(req.user, { role: target.role, facilityId: target.facilityId ?? req.user.facilityId });
  if (target.id === req.user.id) throw badRequest('You cannot delete your own account');
  await lastSuperAdminGuard(target);
  const stamp = Date.now();
  await prisma.user.update({
    where: { id: target.id },
    data: {
      status: 'BLOCKED', archivedAt: new Date(), username: `${target.username}#archived-${stamp}`,
      email: target.email ? `${target.email}#archived-${stamp}` : null, phone: null, nationalId: null,
    },
  });
  await prisma.refreshToken.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, { action: 'USER_ARCHIVED', entity: 'User', entityId: target.id });
  ok(res, { archived: true });
});

router.get('/:id/login-history', requirePermission('users.read'), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw notFound('User');
  if (req.user.facilityId && target.facilityId !== req.user.facilityId) throw forbidden();
  ok(res, await prisma.loginHistory.findMany({ where: { userId: target.id }, orderBy: { createdAt: 'desc' }, take: 50 }));
});

export default router;
