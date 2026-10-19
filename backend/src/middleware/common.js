import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { env, isProd, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';

export function requestId(req, res, next) {
  req.id = req.headers['x-request-id']?.toString().slice(0, 64) || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      id: req.id, method: req.method, path: req.originalUrl.split('?')[0],
      status: res.statusCode, ms: Date.now() - start, user: req.user?.id,
    });
  });
  next();
}

// Parses req.body with a zod schema and replaces it with the validated value.
export const validateBody = (schema) => (req, _res, next) => {
  req.body = schema.parse(req.body ?? {});
  next();
};

export const limiter = (opts) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
    handler: (req, res) =>
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later', requestId: req.id },
      }),
    ...opts,
  });

// Only failed attempts count, so a shared office IP signing in at shift start is not locked out.
export const loginLimiter = limiter({ max: env.RATE_LIMIT_LOGIN_MAX, skipSuccessfulRequests: true });
export const sensitiveLimiter = limiter({ max: 30, windowMs: 60 * 1000 });
// Every page load restores the session through /auth/refresh, so it needs more headroom (shared office IPs).
export const refreshLimiter = limiter({ max: 150, windowMs: 60 * 1000 });
export const apiLimiter = limiter({ max: 600, windowMs: 60 * 1000 });

const PG_EXCLUSION = '23P01';

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl.split('?')[0]} not found`, requestId: req.id },
  });
}

// Centralized error handler: never leaks stack traces or database internals.
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Some fields are invalid';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err?.code === 'P2002') {
    status = 409;
    code = 'CONFLICT';
    message = 'A record with the same unique value already exists';
  } else if (err?.code === 'P2025') {
    status = 404;
    code = 'NOT_FOUND';
    message = 'Record not found';
  } else if (err?.code === 'P2003') {
    status = 409;
    code = 'CONFLICT';
    message = 'This record is referenced by other data and cannot be changed this way';
  } else if (err?.meta?.code === PG_EXCLUSION || /Reservation_no_overlap/.test(err?.message || '')) {
    status = 409;
    code = 'RESERVATION_CONFLICT';
    message = 'That space is already reserved for an overlapping period';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_JSON';
    message = 'Malformed JSON body';
  } else if (err?.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    code = 'FILE_TOO_LARGE';
    message = 'Uploaded file is too large';
  }

  if (status >= 500) {
    logger.error('unhandled error', { id: req.id, path: req.originalUrl, error: err?.message, stack: isProd ? undefined : err?.stack });
  }

  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
}
