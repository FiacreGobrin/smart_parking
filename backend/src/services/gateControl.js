import { prisma } from '../config/db.js';
import { getController } from '../integrations/gate-controllers/index.js';
import { AppError, notFound } from '../utils/errors.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { emit } from '../sockets/index.js';

export const COMMANDS = ['OPEN', 'CLOSE', 'LOCK', 'UNLOCK'];

/**
 * Sends a command to a gate controller and records the real outcome.
 * Fail closed: an offline gate is never commanded to open, and no acknowledgement means FAILED.
 */
export async function sendGateCommand(gateId, command, user, req, reason) {
  const gate = await prisma.gate.findUnique({ where: { id: gateId } });
  if (!gate) throw notFound('Gate');

  if (command === 'OPEN' && gate.status !== 'ONLINE') {
    await prisma.gateEvent.create({ data: { gateId, type: 'COMMAND', outcome: 'DENIED', userId: user.id, reason: `Gate is ${gate.status.toLowerCase()}`, details: { command } } });
    await audit(req, { action: 'GATE_COMMAND', entity: 'Gate', entityId: gateId, result: 'DENIED', metadata: { command, status: gate.status } });
    throw new AppError(409, 'GATE_NOT_ONLINE', `Gate is ${gate.status.toLowerCase()}; the open command was not sent`);
  }

  const result = await getController(gate).send(gate, command);
  const outcome = result.acknowledged ? 'ACKNOWLEDGED' : 'FAILED';

  const event = await prisma.gateEvent.create({
    data: { gateId, type: 'COMMAND', outcome, userId: user.id, reason: reason || null, details: { command, ...result } },
  });
  await audit(req, { action: 'GATE_COMMAND', entity: 'Gate', entityId: gateId, result: outcome, metadata: { command, reason, ...result } });

  if (!result.acknowledged) {
    await prisma.gate.update({ where: { id: gateId }, data: { status: 'ERROR' } });
    await notify({
      type: 'DEVICE_OFFLINE', severity: 'CRITICAL', title: `Gate ${gate.name} did not respond`,
      message: result.detail, facilityId: gate.facilityId, dedupeKey: `gate:${gateId}`, dedupeMinutes: 15,
    });
    emit('gate:update', { id: gateId, status: 'ERROR' }, gate.facilityId);
  } else {
    await prisma.gate.update({ where: { id: gateId }, data: { lastHeartbeatAt: new Date() } });
  }
  return { event, ...result, outcome };
}

export async function pingGate(gateId, user, req) {
  const gate = await prisma.gate.findUnique({ where: { id: gateId } });
  if (!gate) throw notFound('Gate');
  const r = await getController(gate).ping(gate);
  const status = r.online ? (gate.status === 'MAINTENANCE' ? 'MAINTENANCE' : 'ONLINE') : 'OFFLINE';
  const updated = await prisma.gate.update({
    where: { id: gateId },
    data: { status, ...(r.online ? { lastHeartbeatAt: new Date() } : {}) },
  });
  if (!r.online) {
    await notify({ type: 'DEVICE_OFFLINE', severity: 'CRITICAL', title: `Gate ${gate.name} is offline`, message: r.detail, facilityId: gate.facilityId, dedupeKey: `gate:${gateId}`, dedupeMinutes: 15 });
  }
  await audit(req, { action: 'GATE_PING', entity: 'Gate', entityId: gateId, metadata: r });
  emit('gate:update', { id: gateId, status }, gate.facilityId);
  return { gate: updated, ...r };
}
