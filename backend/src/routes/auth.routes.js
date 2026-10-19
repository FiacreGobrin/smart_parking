import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { loginLimiter, refreshLimiter, sensitiveLimiter, validateBody } from '../middleware/common.js';
import * as auth from '../services/auth.js';
import { audit } from '../services/audit.js';
import { prisma } from '../config/db.js';
import { ok, created } from '../utils/respond.js';
import { registerPending } from '../services/accounts.js';

const router = Router();
const COOKIE = 'sp_refresh';
const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

// Sign in with a username (or the e-mail kept on older accounts). `code` is the one-time SMS code for first sign-in.
const loginSchema = z.object({
  username: z.string().trim().min(1).optional(),
  email: z.string().trim().min(1).optional(),
  password: z.string().min(1),
  code: z.string().trim().optional(),
}).refine((v) => v.username || v.email, { message: 'Username is required', path: ['username'] });

router.post('/login', loginLimiter, validateBody(loginSchema), async (req, res) => {
  const { user, accessToken, refreshToken } = await auth.login(req.body.username || req.body.email, req.body.password, req.body.code, meta(req), req);
  res.cookie(COOKIE, refreshToken, auth.refreshCookieOptions());
  ok(res, { accessToken, user: auth.publicUser(user) });
});

// Public sign-up. The account stays PENDING until an administrator approves it.
router.post('/register', loginLimiter, validateBody(z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(100),
  phone: z.string().trim().min(1, 'Phone number is required'),
  nationalId: z.string().trim().regex(/^\d{16}$/, 'National ID must be 16 digits'),
})), async (req, res) => {
  await registerPending({ ...req.body, req });
  created(res, { message: 'Thank you. Your request was sent. You will receive your code, username and password by SMS once an administrator approves it.' });
});

router.post('/refresh', refreshLimiter, async (req, res) => {
  const { user, accessToken, refreshToken } = await auth.refresh(req.cookies?.[COOKIE], meta(req));
  res.cookie(COOKIE, refreshToken, auth.refreshCookieOptions());
  ok(res, { accessToken, user: auth.publicUser(user) });
});

router.post('/logout', async (req, res) => {
  await auth.logout(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { ...auth.refreshCookieOptions(), maxAge: undefined });
  ok(res, { loggedOut: true });
});

router.get('/me', authenticate, (req, res) => ok(res, auth.publicUser(req.user)));

router.post('/change-password', authenticate, sensitiveLimiter,
  validateBody(z.object({ currentPassword: z.string().min(1), newPassword: auth.passwordSchema })),
  async (req, res) => {
    await auth.changePassword(req.user, req.body.currentPassword, req.body.newPassword, req);
    res.clearCookie(COOKIE, { ...auth.refreshCookieOptions(), maxAge: undefined });
    ok(res, { changed: true, message: 'Password changed. Please sign in again.' });
  });

// Always answers the same way so the endpoint cannot be used to discover accounts.
router.post('/forgot-password', loginLimiter, validateBody(z.object({ username: z.string().trim().min(1) })), async (req, res) => {
  const devToken = await auth.requestPasswordReset(req.body.username, req);
  ok(res, { message: 'If that account exists, a reset link has been issued.', ...(devToken ? { devResetToken: devToken } : {}) });
});

router.post('/reset-password', loginLimiter, validateBody(z.object({ token: z.string().min(10), newPassword: auth.passwordSchema })), async (req, res) => {
  await auth.resetPassword(req.body.token, req.body.newPassword, req);
  ok(res, { reset: true });
});

router.get('/login-history', authenticate, async (req, res) => {
  const rows = await prisma.loginHistory.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  ok(res, rows);
});

router.patch('/profile', authenticate, validateBody(z.object({ name: z.string().min(2).max(100).optional() })), async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.user.id }, data: req.body });
  await audit(req, { action: 'PROFILE_UPDATED', entity: 'User', entityId: user.id });
  ok(res, auth.publicUser(user));
});

export default router;
