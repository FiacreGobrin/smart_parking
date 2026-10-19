import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/db.js';
import { can } from '../config/permissions.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'smart-parking',
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { issuer: 'smart-parking' });
}

// Verifies the bearer token and reloads the user so deactivation takes effect immediately.
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw unauthorized('Session expired or invalid token');
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status !== 'ACTIVE' || user.archivedAt) throw unauthorized('Account is disabled');
  req.user = user;
  next();
}

// Usage: requirePermission('payments.create'). Any one of several permissions is enough.
export function requirePermission(...permissions) {
  return (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!permissions.some((p) => can(req.user.role, p))) throw forbidden();
    next();
  };
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) throw unauthorized();
  if (!roles.includes(req.user.role)) throw forbidden();
  next();
};

// Facility scoping: users bound to a facility only see/act on that facility.
// Returns the facilityId filter to apply (or undefined for "all"). Throws if a different facility is requested.
export function scopeFacility(user, requested) {
  if (!user.facilityId) return requested || undefined;
  if (requested && requested !== user.facilityId) throw forbidden('You are not assigned to this facility');
  return user.facilityId;
}

export function assertFacilityAccess(user, facilityId) {
  if (user.facilityId && facilityId && user.facilityId !== facilityId) {
    throw forbidden('You are not assigned to this facility');
  }
}
