import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { env, isProd } from '../config/env.js';
import { logger } from '../config/logger.js';
import { permissionsFor } from '../config/permissions.js';
import { signAccessToken } from '../middleware/auth.js';
import { AppError, badRequest, unauthorized } from '../utils/errors.js';
import { audit } from './audit.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = 12;
// Compared against when the account does not exist so response time does not reveal valid emails.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a digit');

export const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, name: u.name, phone: u.phone, nationalId: u.nationalId, role: u.role, status: u.status,
    facilityId: u.facilityId, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt, permissions: permissionsFor(u.role),
  };
}

async function issueRefreshToken(user, meta) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: {
      userId: user.id, tokenHash: sha256(raw), userAgent: meta.userAgent?.slice(0, 250), ip: meta.ip,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000),
    },
  });
  return raw;
}

export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax', // frontend and API are on different origins in production
  path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400000,
});

const findByIdentifier = (identifier) => {
  const id = String(identifier).trim().toLowerCase();
  return prisma.user.findFirst({ where: { OR: [{ username: id }, { email: id }], archivedAt: null } });
};

export async function login(identifier, password, code, meta, req) {
  const user = await findByIdentifier(identifier);
  const record = (success, reason) =>
    prisma.loginHistory.create({ data: { userId: user?.id, email: identifier, success, reason, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 250) } });

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    await record(false, 'locked');
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
  }
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) {
    await record(false, !user ? 'unknown-user' : 'bad-password');
    await audit(req, { action: 'LOGIN', entity: 'User', entityId: user?.id, result: 'FAILED', metadata: { identifier } });
    if (user) {
      const failed = user.failedLogins + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: failed, ...(failed >= MAX_FAILED ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000), failedLogins: 0 } : {}) },
      });
    }
    throw unauthorized('Invalid username or password'); // same message for every failure
  }
  // Only someone who knows the password learns the account state.
  if (user.status === 'PENDING') {
    await record(false, 'pending');
    throw new AppError(403, 'ACCOUNT_PENDING', 'Your account is waiting for approval by an administrator.');
  }
  if (user.status === 'BLOCKED') {
    await record(false, 'blocked');
    throw new AppError(403, 'ACCOUNT_BLOCKED', 'Your account is blocked. Contact an administrator.');
  }
  if (user.activationCodeHash) {
    if (!code) throw new AppError(401, 'ACTIVATION_CODE_REQUIRED', 'Enter the 6-digit code you received by SMS to activate your account.');
    if (!(await bcrypt.compare(String(code), user.activationCodeHash))) {
      await record(false, 'bad-code');
      throw new AppError(401, 'ACTIVATION_CODE_INVALID', 'That code is not correct.');
    }
  }
  const updated = await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), activationCodeHash: null } });
  await record(true);
  await audit(req, { action: 'LOGIN', entity: 'User', entityId: user.id, actor: user });
  return { user: updated, accessToken: signAccessToken(updated), refreshToken: await issueRefreshToken(updated, meta) };
}

// Rotating refresh tokens. Presenting an already-used token signals theft: revoke the whole family.
export async function refresh(rawToken, meta) {
  if (!rawToken) throw unauthorized();
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) }, include: { user: true } });
  if (!stored) throw unauthorized();
  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    logger.warn('refresh token reuse detected', { userId: stored.userId });
    throw unauthorized('Session is no longer valid');
  }
  if (stored.expiresAt < new Date() || stored.user.status !== 'ACTIVE') throw unauthorized('Session expired');
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  return { user: stored.user, accessToken: signAccessToken(stored.user), refreshToken: await issueRefreshToken(stored.user, meta) };
}

export async function logout(rawToken) {
  if (!rawToken) return;
  await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(rawToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function changePassword(user, current, next, req) {
  if (!(await bcrypt.compare(current, user.passwordHash))) throw badRequest('Current password is incorrect');
  if (current === next) throw badRequest('New password must differ from the current one');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next), mustChangePassword: false } });
  await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, { action: 'PASSWORD_CHANGED', entity: 'User', entityId: user.id });
}

// No e-mail provider is wired up. In development the token is returned so the flow can be tested;
// in production it is only logged as a stub so operators know to connect an e-mail adapter.
export async function requestPasswordReset(identifier, req) {
  const user = await findByIdentifier(identifier);
  if (!user || user.status !== 'ACTIVE') return null; // caller responds identically either way
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.user.update({ where: { id: user.id }, data: { resetTokenHash: sha256(token), resetExpiresAt: new Date(Date.now() + 3600000) } });
  await audit(req, { action: 'PASSWORD_RESET_REQUESTED', entity: 'User', entityId: user.id, actor: user });
  logger.warn('password reset requested; no e-mail adapter configured', { userId: user.id });
  return isProd ? null : token;
}

export async function resetPassword(token, newPassword, req) {
  const user = await prisma.user.findFirst({ where: { resetTokenHash: sha256(token), resetExpiresAt: { gt: new Date() } } });
  if (!user) throw badRequest('Reset link is invalid or has expired');
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword), resetTokenHash: null, resetExpiresAt: null, failedLogins: 0, lockedUntil: null, mustChangePassword: false },
  });
  await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, { action: 'PASSWORD_RESET', entity: 'User', entityId: user.id, actor: user });
}
