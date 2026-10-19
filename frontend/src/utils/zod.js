import { z } from 'zod';

// Form inputs hand us strings; these helpers turn "" into undefined so optional fields stay optional.
const blank = (v) => v === '' || v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

export const zNum = (label = 'Value', opts = {}) =>
  z.preprocess((v) => (blank(v) ? undefined : Number(v)),
    z.number({ error: `${label} is required` }).min(opts.min ?? 0, `${label} must be at least ${opts.min ?? 0}`).max(opts.max ?? 1e9, `${label} is too large`));

export const zOptNum = (label = 'Value', opts = {}) =>
  z.preprocess((v) => (blank(v) ? undefined : Number(v)),
    z.number({ error: `${label} must be a number` }).min(opts.min ?? 0, `${label} must be at least ${opts.min ?? 0}`).max(opts.max ?? 1e9).optional());

export const zStr = (label = 'This field', min = 1, max = 200) =>
  z.string({ error: `${label} is required` }).trim().min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`).max(max, `${label} is too long`);

export const zOptStr = (max = 200) => z.preprocess((v) => (blank(v) ? undefined : String(v).trim()), z.string().max(max).optional());

export const zEmail = z.string().trim().min(1, 'E-mail is required').email('Enter a valid e-mail address');
export const zPhone = z.preprocess((v) => (blank(v) ? undefined : String(v).trim()), z.string().regex(/^\+?\d[\d\s-]{7,16}$/, 'Enter a valid phone number').optional());
export const zPassword = z.string().min(10, 'At least 10 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a digit');
export const zDate = (label = 'Date') => z.string({ error: `${label} is required` }).min(1, `${label} is required`);
