import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';
import { badRequest } from '../utils/errors.js';

export const uploadDir = path.resolve(env.UPLOAD_DIR);
fs.mkdirSync(uploadDir, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const storage = multer.diskStorage({
  destination: uploadDir,
  // Random names: never trust the client filename.
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${EXT[file.mimetype] || ''}`),
});

export const imageUpload = multer({
  storage,
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(badRequest('Only JPEG, PNG or WebP images are allowed')),
});

const MAGIC = [
  [0xff, 0xd8, 0xff], // jpeg
  [0x89, 0x50, 0x4e, 0x47], // png
  [0x52, 0x49, 0x46, 0x46], // riff (webp)
];

// Confirms the bytes on disk really are an image; deletes the file otherwise.
export function assertImageFile(file) {
  if (!file) return;
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const okMagic = MAGIC.some((m) => m.every((b, i) => head[i] === b));
  if (!okMagic) {
    fs.unlink(file.path, () => {});
    throw badRequest('File content is not a valid image');
  }
}

export function resolveUpload(name) {
  const safe = path.basename(name);
  const full = path.join(uploadDir, safe);
  return full.startsWith(uploadDir) ? full : null;
}
