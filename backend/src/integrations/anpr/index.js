// ANPR (automatic number plate recognition) engine adapters.
//
// The recognition engine is deliberately NOT part of this Node API. Production deployments run a
// separate service (e.g. Python + OpenCV + YOLO + EasyOCR) exposing:
//
//   POST {ANPR_SERVICE_URL}/recognize        multipart/form-data, field "image"
//   -> 200 { "plate": "RAB123C", "confidence": 0.93 }      (plate may be null when nothing is found)
//
// Adapter contract: recognize({ buffer, mimeType, hint }) -> { plate, confidence } | throws.
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

// SIMULATION: does not look at the image. It echoes the plate the operator typed in the test
// console. Every event it produces is flagged isSimulated=true and labelled as such in the UI.
export const simulationEngine = {
  name: 'simulation',
  isSimulated: true,
  async recognize({ hint }) {
    if (!hint?.plate) return { plate: null, confidence: null };
    return { plate: hint.plate, confidence: hint.confidence ?? 0.97 };
  },
};

export const httpEngine = {
  name: 'http',
  isSimulated: false,
  async recognize({ filePath, mimeType }) {
    if (!env.ANPR_SERVICE_URL) {
      throw new AppError(501, 'ANPR_NOT_CONFIGURED', 'ANPR_MODE=http but ANPR_SERVICE_URL is not set');
    }
    const buffer = await fs.readFile(filePath);
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mimeType }), 'capture');
    const res = await fetch(`${env.ANPR_SERVICE_URL.replace(/\/$/, '')}/recognize`, {
      method: 'POST',
      body: form,
      headers: env.ANPR_SERVICE_TOKEN ? { Authorization: `Bearer ${env.ANPR_SERVICE_TOKEN}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new AppError(502, 'ANPR_ENGINE_ERROR', `Recognition engine returned ${res.status}`);
    const body = await res.json();
    return { plate: body.plate ?? null, confidence: typeof body.confidence === 'number' ? body.confidence : null };
  },
};

// ---- Built-in OCR (Tesseract). Reads the letters and digits from the photo, best effort. ----
// Works for a reasonably sharp, frontal photo of a plate. It is NOT a full ANPR system (no plate detection
// in a wide scene, no night/glare handling): low confidence always goes to the operator for confirmation.
let workerPromise = null;
let queue = Promise.resolve();

async function getWorker() {
  workerPromise ||= (async () => {
    const { createWorker } = await import('tesseract.js');
    const w = await createWorker('eng', 1, { cachePath: path.resolve('.tessdata'), logger: () => {} });
    await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' });
    return w;
  })().catch((err) => { workerPromise = null; throw err; });
  return workerPromise;
}

const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };

/** Rwandan private plates are 3 letters, 3 digits, 1 letter (RAB 123 C): repair look-alike characters by position. */
export function repairRwandan(compact) {
  if (compact.length !== 7) return compact;
  const fix = (c, wantDigit) => (wantDigit ? (/\d/.test(c) ? c : TO_DIGIT[c] || c) : (/[A-Z]/.test(c) ? c : TO_LETTER[c] || c));
  return [...compact].map((c, i) => fix(c, i >= 3 && i <= 5)).join('');
}

/** Picks the most plate-like token out of raw OCR text. */
export function pickPlate(text) {
  const up = String(text).toUpperCase().replace(/[^A-Z0-9\n ]/g, ' ');
  const lines = up.split('\n').map((l) => l.trim()).filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    const compact = line.replace(/\s+/g, '');
    if (compact.length >= 5 && compact.length <= 9) candidates.push(compact);
    for (const tok of line.split(/\s+/)) if (tok.length >= 5 && tok.length <= 9) candidates.push(tok);
  }
  const rw = /^R[A-Z]{2}\d{3}[A-Z]$/;
  for (const c of candidates) { const r = repairRwandan(c); if (rw.test(r)) return { plate: r, known: true }; }
  const generic = candidates.find((c) => /[A-Z]/.test(c) && /\d/.test(c));
  return generic ? { plate: generic, known: false } : { plate: null, known: false };
}

export const ocrEngine = {
  name: 'ocr',
  isSimulated: false,
  async recognize({ filePath }) {
    if (!filePath) throw new AppError(400, 'IMAGE_REQUIRED', 'A photo is required for plate reading');
    const buffer = await fs.readFile(filePath);
    // One OCR job at a time: the worker is single-threaded and photos are small.
    const job = queue.then(async () => {
      const worker = await getWorker();
      let best = { plate: null, confidence: null };
      for (const psm of ['7', '6', '11']) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        const { data } = await worker.recognize(buffer);
        const { plate, known } = pickPlate(data.text);
        if (plate) {
          const confidence = Math.min(1, Math.max(0, (data.confidence || 0) / 100));
          // A read that matches the Rwandan layout is far more trustworthy than a loose token.
          const score = known ? confidence : confidence * 0.8;
          if (!best.plate || score > (best.confidence ?? 0)) best = { plate, confidence: score };
          if (known && confidence >= 0.8) break;
        }
      }
      return best;
    });
    queue = job.catch(() => {});
    return job;
  },
};

export const getEngine = () => (env.ANPR_MODE === 'http' ? httpEngine : env.ANPR_MODE === 'ocr' ? ocrEngine : simulationEngine);
