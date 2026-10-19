import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { prisma } from './config/db.js';
import { frontendOrigins, isProd } from './config/env.js';
import { authenticate } from './middleware/auth.js';
import { apiLimiter, errorHandler, notFoundHandler, requestId, requestLogger } from './middleware/common.js';
import authRoutes from './routes/auth.routes.js';
import usersRoutes from './routes/users.routes.js';
import parkingRoutes from './routes/parking.routes.js';
import paymentsRoutes, { webhookRouter } from './routes/payments.routes.js';
import anprRoutes from './routes/anpr.routes.js';
import { permits, reservations } from './routes/reservations.routes.js';
import * as res from './routes/resources.routes.js';
import { auditRouter, dashboardRouter, filesRouter, notificationsRouter, reportsRouter, settingsRouter, smsRouter, systemRouter } from './routes/misc.routes.js';
import { buildOpenApi } from './routes/openapi.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render/Railway/Vercel proxies: correct client IPs and secure cookies

  app.use(requestId);
  app.use(helmet({ contentSecurityPolicy: isProd ? undefined : false })); // dev: lets the Swagger UI inline script run
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || frontendOrigins.includes(origin)),
    credentials: true,
  }));
  app.use(compression());
  // Keep the raw bytes: webhook signatures are verified over exactly what the provider sent.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(cookieParser());
  app.use(requestLogger);

  const api = express.Router();

  api.get('/health', async (_req, response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      response.json({ success: true, data: { status: 'ok', database: 'up', time: new Date().toISOString() } });
    } catch {
      response.status(503).json({ success: false, error: { code: 'DB_DOWN', message: 'Database unreachable' } });
    }
  });

  if (!isProd || process.env.ENABLE_API_DOCS === 'true') {
    api.get('/openapi.json', (_req, response) => response.json(buildOpenApi()));
    api.use('/docs', swaggerUi.serve, swaggerUi.setup(buildOpenApi(), { customSiteTitle: 'Smart Parking API' }));
  }

  api.use(apiLimiter);
  api.use('/auth', authRoutes);
  api.use('/payments/webhooks', webhookRouter); // signature-authenticated, no bearer token

  api.use(authenticate); // everything below requires a signed-in, active user
  api.use('/users', usersRoutes);
  api.use('/dashboard', dashboardRouter);
  api.use('/facilities', res.facilities);
  api.use('/zones', res.zones);
  api.use('/spaces', res.spaces);
  api.use('/vehicles', res.vehicles);
  api.use('/cameras', res.cameras);
  api.use('/gates', res.gates);
  api.use('/gate-events', res.gateEvents);
  api.use('/rates', res.rates);
  api.use('/parking', parkingRoutes);
  api.use('/payments', paymentsRoutes);
  api.use('/anpr', anprRoutes);
  api.use('/reservations', reservations);
  api.use('/permits', permits);
  api.use('/reports', reportsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/audit-logs', auditRouter);
  api.use('/settings', settingsRouter);
  api.use('/files', filesRouter);
  api.use('/sms-messages', smsRouter);
  api.use('/system', systemRouter);

  app.use('/api/v1', api);
  app.get('/', (_req, response) => response.json({ name: 'Smart Parking API', docs: '/api/v1/docs', health: '/api/v1/health' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
