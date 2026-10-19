import { Server } from 'socket.io';
import { frontendOrigins } from '../config/env.js';
import { prisma } from '../config/db.js';
import { verifyAccessToken } from '../middleware/auth.js';
import { logger } from '../config/logger.js';

let io = null;

export function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: frontendOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const payload = verifyAccessToken(socket.handshake.auth?.token || '');
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (user?.status !== 'ACTIVE') return next(new Error('unauthorized'));
      socket.data.user = { id: user.id, role: user.role, facilityId: user.facilityId };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { facilityId } = socket.data.user;
    socket.join(facilityId ? `facility:${facilityId}` : 'all');
    logger.debug('socket connected', { user: socket.data.user.id });
  });
  return io;
}

// Events are delivered to unscoped users ("all") and to users of the affected facility.
export function emit(event, payload, facilityId) {
  if (!io) return;
  let target = io.to('all');
  if (facilityId) target = target.to(`facility:${facilityId}`);
  target.emit(event, payload);
}

export const closeSockets = () => new Promise((resolve) => (io ? io.close(() => resolve()) : resolve()));
