import http from 'node:http';
import { env } from './config/env.js';
import { prisma } from './config/db.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';
import { closeSockets, initSockets } from './sockets/index.js';
import { runMaintenance } from './services/jobs.js';

const app = createApp();
const server = http.createServer(app);
initSockets(server);

const timer = setInterval(() => {
  runMaintenance().catch((err) => logger.error('maintenance failed', { error: err.message }));
}, 60_000);

server.listen(env.PORT, () => {
  logger.info(`Smart Parking API listening on :${env.PORT}`, { env: env.NODE_ENV, anpr: env.ANPR_MODE, payments: env.PAYMENT_MODE });
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info(`${signal} received, shutting down`);
  clearInterval(timer);
  server.close();
  await closeSockets();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { error: String(err) }));
