import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { assertFacilityAccess, requirePermission, scopeFacility } from '../middleware/auth.js';
import { sensitiveLimiter, validateBody } from '../middleware/common.js';
import { assertImageFile, imageUpload } from '../middleware/upload.js';
import { confirmRecognition, processCapture } from '../services/anpr.js';
import { getEngine } from '../integrations/anpr/index.js';
import { getSetting } from '../services/settings.js';
import { resolveFacilityId } from '../services/parking.js';
import fs from 'node:fs/promises';
import { badRequest, notFound } from '../utils/errors.js';
import { pageMeta, parsePagination } from '../utils/pagination.js';
import { ok } from '../utils/respond.js';

const router = Router();
// Photos live in the database but are fetched through /files/:name, never inlined in JSON.
const strip = (e) => { if (!e) return e; const { imageData, ...rest } = e; return rest; };

router.get('/status', requirePermission('anpr.read'), async (_req, res) => {
  const engine = getEngine();
  ok(res, {
    mode: env.ANPR_MODE, engine: engine.name, simulated: engine.isSimulated,
    configured: env.ANPR_MODE === 'simulation' || !!env.ANPR_SERVICE_URL,
    minConfidence: (await getSetting('anpr.minConfidence')) ?? env.ANPR_MIN_CONFIDENCE,
    notice: engine.isSimulated
      ? 'SIMULATION MODE: no image analysis is performed. Plates come from the test field, not from the picture.'
      : engine.name === 'ocr'
        ? 'Built-in OCR reads letters and digits from the photo (best effort). Low confidence always asks the operator to confirm.'
        : 'Connected to external recognition service.',
  });
});

// Accepts a camera snapshot. In simulation mode the image is optional and `simulatedPlate` supplies the result.
router.post('/recognize', requirePermission('anpr.use'), sensitiveLimiter, imageUpload.single('image'), async (req, res) => {
  const body = z.object({
    cameraId: z.string().min(1),
    simulatedPlate: z.string().trim().max(20).optional(),
    simulatedConfidence: z.coerce.number().min(0).max(1).optional(),
    autoProcess: z.preprocess((v) => v === true || v === 'true', z.boolean()).default(false),
  }).parse(req.body);
  if (req.file) assertImageFile(req.file);
  if (env.ANPR_MODE === 'http' && !req.file) throw badRequest('An image is required (field "image")');

  const camera = await prisma.camera.findUnique({ where: { id: body.cameraId } });
  if (!camera) throw notFound('Camera');
  assertFacilityAccess(req.user, camera.facilityId);
  if (body.simulatedPlate && env.ANPR_MODE !== 'simulation') throw badRequest('simulatedPlate is only accepted in simulation mode');

  let result;
  try {
    result = await processCapture({ file: req.file, ...body, user: req.user, req });
  } finally {
    if (req.file) fs.unlink(req.file.path).catch(() => {});
  }
  res.status(201).json({ success: true, data: { ...result, event: strip(result.event) }, meta: { simulated: getEngine().isSimulated } });
});

// Phone camera: the operator photographs a plate; the server finds (or creates) the facility's phone-camera
// device and runs recognition. Nothing is acted on automatically: the operator confirms the plate first.
router.post('/scan', requirePermission('anpr.use'), sensitiveLimiter, imageUpload.single('image'), async (req, res) => {
  const body = z.object({ facilityId: z.string().optional(), simulatedPlate: z.string().trim().max(20).optional() }).parse(req.body);
  if (!req.file) throw badRequest('A photo is required (field "image")');
  assertImageFile(req.file);
  const facilityId = await resolveFacilityId(req.user, body.facilityId);
  assertFacilityAccess(req.user, facilityId);
  const engine = getEngine();
  const camera = (await prisma.camera.findFirst({ where: { facilityId, name: 'Phone camera' } }))
    || (await prisma.camera.create({ data: { facilityId, name: 'Phone camera', isSimulated: engine.isSimulated } }));
  let result;
  try {
    result = await processCapture({ file: req.file, cameraId: camera.id, simulatedPlate: body.simulatedPlate, autoProcess: false, user: req.user, req });
  } finally {
    fs.unlink(req.file.path).catch(() => {});
  }
  res.status(201).json({ success: true, data: { ...result, event: strip(result.event) }, meta: { simulated: engine.isSimulated } });
});

router.get('/events', requirePermission('anpr.read'), async (req, res) => {
  const { page, limit, skip, take } = parsePagination(req.query);
  const facilityId = scopeFacility(req.user, req.query.facilityId?.toString());
  const where = {
    ...(facilityId ? { facilityId } : {}),
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.cameraId ? { cameraId: String(req.query.cameraId) } : {}),
    ...(req.query.search ? { plate: { contains: String(req.query.search).toUpperCase().replace(/[^A-Z0-9]/g, '') || '-' } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.recognitionEvent.findMany({ where, omit: { imageData: true }, orderBy: { createdAt: 'desc' }, skip, take, include: { camera: { select: { name: true } }, gate: { select: { name: true, direction: true } } } }),
    prisma.recognitionEvent.count({ where }),
  ]);
  ok(res, rows, pageMeta(page, limit, total));
});

router.post('/events/:id/confirm', requirePermission('anpr.use'), validateBody(z.object({ plate: z.string().trim().max(20).optional(), process: z.boolean().default(false) })), async (req, res) => {
  const event = await prisma.recognitionEvent.findUnique({ where: { id: req.params.id } });
  if (!event) throw notFound('Recognition event');
  assertFacilityAccess(req.user, event.facilityId);
  const confirmed = await confirmRecognition(event.id, req.body, req.user, req);
  ok(res, { ...confirmed, event: strip(confirmed.event) });
});

export default router;
