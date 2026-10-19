import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { sendSms } from '../integrations/sms/index.js';
import { AppError, conflict } from '../utils/errors.js';
import { generateCode, generatePassword, isNationalId, normalizeRwPhone, usernameFrom } from '../utils/identity.js';
import { audit } from './audit.js';
import { hashPassword } from './auth.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

export const NEEDS_FACILITY = ['PARKING_ADMIN', 'ATTENDANT', 'USER'];

async function uniqueUsername(name, phone, ignoreUserId) {
  const base = usernameFrom(name, phone);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`;
    const clash = await prisma.user.findUnique({ where: { username: candidate } });
    if (!clash || clash.id === ignoreUserId) return candidate;
  }
  return `${base}${crypto.randomInt(1000, 9999)}`;
}

/** Preview of the credentials for a person. Nothing is stored until the user is saved or approved. */
export async function generateCredentials({ name, phone, userId }) {
  const normalized = normalizeRwPhone(phone);
  if (!normalized) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid Rwandan phone number first', [{ field: 'phone', message: 'Enter a valid Rwandan phone number' }]);
  return { code: generateCode(), username: await uniqueUsername(name, normalized, userId), password: generatePassword() };
}

/** Records the SMS (password masked in the stored copy) and hands the real text to the gateway adapter. */
export async function sendCredentialsSms({ user, code, username, password }) {
  const text = (pw) => `Smart Parking: code ${code}, username ${username}, password ${pw}. Sign in and enter the code to activate your account.`;
  const result = await sendSms({ to: user.phone, body: text(password) });
  await prisma.smsMessage.create({
    data: { toPhone: user.phone, body: text('********'), status: result.sent ? 'SENT' : result.simulated ? 'SIMULATED' : 'FAILED', userId: user.id },
  });
  if (!result.sent) logger.warn('credentials SMS not delivered', { userId: user.id, detail: result.detail });
  return result;
}

/** Public sign-up: creates a PENDING account that cannot sign in until an administrator approves it. */
export async function registerPending({ name, phone, nationalId, req }) {
  const normalized = normalizeRwPhone(phone);
  if (!normalized) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid Rwandan phone number', [{ field: 'phone', message: 'Use a number like 0788 123 456' }]);
  if (!isNationalId(nationalId)) throw new AppError(400, 'VALIDATION_ERROR', 'National ID must be 16 digits', [{ field: 'nationalId', message: 'National ID must be 16 digits' }]);
  const dup = await prisma.user.findFirst({ where: { OR: [{ phone: normalized }, { nationalId }] } });
  if (dup) throw conflict('An account with this phone number or national ID already exists');
  const user = await prisma.user.create({
    data: {
      name: name.trim(), phone: normalized, nationalId, role: 'USER', status: 'PENDING',
      username: `pending_${crypto.randomBytes(5).toString('hex')}`,
      passwordHash: await hashPassword(crypto.randomBytes(24).toString('base64url') + 'a1'),
    },
  });
  await audit(req, { action: 'USER_SIGNUP', entity: 'User', entityId: user.id, actor: user, metadata: { phone: normalized } });
  return user;
}

/**
 * Issues fresh credentials. `activate` is true when approving a sign-up (status becomes ACTIVE);
 * resetting an existing account keeps its status, so a blocked user stays blocked.
 * Returns the credentials once for the administrator to see.
 */
export async function issueCredentials(target, actor, req, { activate }) {
  if (!target.phone) throw new AppError(400, 'VALIDATION_ERROR', 'This user has no phone number; add one first');
  if (activate && NEEDS_FACILITY.includes(target.role) && !target.facilityId) {
    const facilities = await prisma.parkingFacility.findMany({ where: { archivedAt: null }, select: { id: true }, take: 2 });
    if (facilities.length !== 1) throw new AppError(400, 'FACILITY_REQUIRED', 'Assign a facility to this user (Edit) before approving');
    target = await prisma.user.update({ where: { id: target.id }, data: { facilityId: facilities[0].id } });
  }
  const creds = await generateCredentials({ name: target.name, phone: target.phone, userId: target.id });
  const user = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(activate ? { status: 'ACTIVE' } : {}), username: creds.username, passwordHash: await hashPassword(creds.password), mustChangePassword: true,
      activationCodeHash: await bcrypt.hash(creds.code, 8), failedLogins: 0, lockedUntil: null,
    },
  });
  if (!activate) await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  const sms = await sendCredentialsSms({ user, ...creds });
  await audit(req, { action: activate ? 'USER_APPROVED' : 'USER_CREDENTIALS_RESET', entity: 'User', entityId: user.id, actor, metadata: { username: creds.username, sms: sms.detail } });
  return { user, credentials: creds, sms };
}

export const approveUser = (target, actor, req) => issueCredentials(target, actor, req, { activate: true });
export const resetCredentials = (target, actor, req) => issueCredentials(target, actor, req, { activate: false });
