import fs from 'node:fs/promises';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { isPlausiblePlate, normalizePlate } from '../utils/plate.js';
import { getEngine } from '../integrations/anpr/index.js';
import { getSetting } from './settings.js';
import { registerEntry, registerExit } from './parking.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { emit } from '../sockets/index.js';

async function processRecognition(event, user, req) {
  const gate = event.gateId ? await prisma.gate.findUnique({ where: { id: event.gateId } }) : null;
  if (!gate) return { action: 'NONE', reason: 'Camera is not linked to a gate; confirm and process manually' };
  try {
    if (gate.direction === 'ENTRY') {
      const session = await registerEntry({ plate: event.plate, facilityId: gate.facilityId, gateId: gate.id, recognition: event, user, req });
      await prisma.recognitionEvent.update({ where: { id: event.id }, data: { matchedSessionId: session.id } });
      return { action: 'ENTRY_GRANTED', sessionId: session.id };
    }
    const session = await registerExit({ plate: event.plate, gateId: gate.id, recognition: event, user, req });
    await prisma.recognitionEvent.update({ where: { id: event.id }, data: { matchedSessionId: session.id } });
    return { action: 'EXIT_GRANTED', sessionId: session.id };
  } catch (err) {
    if (err instanceof AppError) {
      return { action: 'DENIED', code: err.code, reason: err.message, details: err.details };
    }
    throw err;
  }
}

/**
 * Handles one camera capture: recognize, de-duplicate, match, store, and optionally act on it.
 * `file` is a multer file already validated by the route.
 */
export async function processCapture({ file, cameraId, simulatedPlate, simulatedConfidence, autoProcess, user, req }) {
  const camera = await prisma.camera.findUnique({ where: { id: cameraId }, include: { gate: true } });
  if (!camera) throw notFound('Camera');
  const engine = getEngine();
  const minConfidence = (await getSetting('anpr.minConfidence')) ?? env.ANPR_MIN_CONFIDENCE;

  // The photo is stored in the database (survives redeploys); the temporary upload is removed by the route.
  const imageData = file ? await fs.readFile(file.path) : null;
  const base = {
    facilityId: camera.facilityId, cameraId: camera.id, gateId: camera.gateId,
    imagePath: file?.filename ?? null, imageData, imageMime: file?.mimetype ?? null, engine: engine.name, isSimulated: engine.isSimulated,
  };
  await prisma.camera.update({ where: { id: camera.id }, data: { lastSeenAt: new Date(), status: camera.status === 'MAINTENANCE' ? 'MAINTENANCE' : 'ONLINE' } });

  let result;
  try {
    result = await engine.recognize({
      filePath: file?.path, mimeType: file?.mimetype,
      hint: simulatedPlate ? { plate: simulatedPlate, confidence: simulatedConfidence } : null,
    });
  } catch (err) {
    const failed = await prisma.recognitionEvent.create({ data: { ...base, status: 'FAILED', error: err.message } });
    await notify({ type: 'RECOGNITION_FAILED', severity: 'WARNING', title: 'Plate recognition error', message: `${camera.name}: ${err.message}`, facilityId: camera.facilityId, dedupeKey: `anpr-err:${camera.id}`, dedupeMinutes: 10 });
    return { event: failed, action: { action: 'NONE', reason: 'Recognition failed' } };
  }

  const plate = normalizePlate(result.plate);
  if (!plate || !isPlausiblePlate(plate)) {
    const failed = await prisma.recognitionEvent.create({ data: { ...base, rawPlate: result.plate, status: 'FAILED', confidence: result.confidence, error: 'No readable plate found' } });
    await notify({ type: 'RECOGNITION_FAILED', severity: 'WARNING', title: 'Plate not recognized', message: `${camera.name} captured an image with no readable plate.`, facilityId: camera.facilityId, dedupeKey: `anpr-fail:${camera.id}`, dedupeMinutes: 10 });
    emit('recognition:new', failed, camera.facilityId);
    return { event: failed, action: { action: 'NONE', reason: 'No readable plate; enter it manually' } };
  }

  // Cameras fire repeatedly while a car sits in view: ignore repeats of the same plate.
  const since = new Date(Date.now() - env.ANPR_DEDUP_SECONDS * 1000);
  const recent = await prisma.recognitionEvent.findFirst({
    where: { cameraId: camera.id, plate, createdAt: { gte: since }, status: { in: ['RECOGNIZED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'CORRECTED'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    const dup = await prisma.recognitionEvent.create({ data: { ...base, rawPlate: result.plate, plate, confidence: result.confidence, status: 'DUPLICATE', error: `Repeat of ${recent.id}`, matchedVehicleId: recent.matchedVehicleId, matchedSessionId: recent.matchedSessionId } });
    return { event: dup, duplicateOf: recent.id, action: { action: 'NONE', reason: 'Duplicate capture ignored' } };
  }

  const [vehicle, active] = await Promise.all([
    prisma.vehicle.findUnique({ where: { plate } }),
    prisma.parkingSession.findFirst({ where: { plate, status: 'ACTIVE' } }),
  ]);
  const confident = result.confidence != null && result.confidence >= minConfidence;
  const event = await prisma.recognitionEvent.create({
    data: {
      ...base, rawPlate: result.plate, plate, confidence: result.confidence,
      status: confident ? 'RECOGNIZED' : 'PENDING_CONFIRMATION',
      matchedVehicleId: vehicle?.id, matchedSessionId: active?.id,
    },
  });
  await audit(req, { action: 'ANPR_RECOGNITION', entity: 'RecognitionEvent', entityId: event.id, metadata: { plate, confidence: result.confidence, simulated: engine.isSimulated } });
  emit('recognition:new', event, camera.facilityId);

  let action = { action: 'NONE' };
  if (!confident) {
    action = { action: 'CONFIRMATION_REQUIRED', reason: 'Confidence below threshold; confirm or correct the plate' };
  } else if (autoProcess) {
    action = await processRecognition(event, user, req);
  }
  return { event, vehicle, activeSession: active, action };
}

/** Operator confirms (or corrects) a low-confidence recognition, optionally acting on it. */
export async function confirmRecognition(id, { plate, process }, user, req) {
  const event = await prisma.recognitionEvent.findUnique({ where: { id } });
  if (!event) throw notFound('Recognition event');
  if (!['PENDING_CONFIRMATION', 'RECOGNIZED'].includes(event.status)) {
    throw new AppError(409, 'NOT_CONFIRMABLE', `Event is already ${event.status.toLowerCase()}`);
  }
  const finalPlate = plate ? normalizePlate(plate) : event.plate;
  if (!isPlausiblePlate(finalPlate || '')) throw badRequest('A valid plate is required');
  const corrected = finalPlate !== event.plate;
  const [vehicle, active] = await Promise.all([
    prisma.vehicle.findUnique({ where: { plate: finalPlate } }),
    prisma.parkingSession.findFirst({ where: { plate: finalPlate, status: 'ACTIVE' } }),
  ]);
  const updated = await prisma.recognitionEvent.update({
    where: { id },
    data: { plate: finalPlate, status: corrected ? 'CORRECTED' : 'CONFIRMED', confirmedById: user.id, matchedVehicleId: vehicle?.id ?? null, matchedSessionId: active?.id ?? null },
  });
  await audit(req, { action: corrected ? 'ANPR_PLATE_CORRECTED' : 'ANPR_PLATE_CONFIRMED', entity: 'RecognitionEvent', entityId: id, metadata: { from: event.plate, to: finalPlate } });
  // Human confirmation replaces the confidence check, so no confidence is passed on.
  const action = process ? await processRecognition(updated, user, req) : { action: 'NONE' };
  return { event: updated, action };
}
