import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

// Records an audit event. Never throws: a failed audit write must not break the business operation,
// but it is logged loudly. Pass `tx` to write inside a transaction.
export async function audit(req, { action, entity, entityId, result = 'SUCCESS', metadata, actor }, tx = prisma) {
  try {
    const user = actor || req?.user;
    await tx.auditLog.create({
      data: {
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? metadata?.email ?? null,
        action,
        entity,
        entityId,
        result,
        ip: req?.ip,
        requestId: req?.id,
        metadata,
      },
    });
  } catch (err) {
    logger.error('audit write failed', { action, error: err.message });
  }
}
