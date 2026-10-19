import crypto from 'node:crypto';

/** "0788 123 456", "+250788123456", "250 788123456" -> "+250788123456"; null when not a Rwandan mobile number. */
export function normalizeRwPhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  let local;
  if (digits.startsWith('250') && digits.length === 12) local = digits.slice(3);
  else if (digits.startsWith('0') && digits.length === 10) local = digits.slice(1);
  else if (digits.length === 9) local = digits;
  else return null;
  return /^7\d{8}$/.test(local) ? `+250${local}` : null;
}

/** "+250788123456" -> "0788 123 456" */
export function localPhone(normalized) {
  const d = String(normalized ?? '').replace(/^\+250/, '');
  if (d.length !== 9) return normalized ?? '';
  const l = `0${d}`;
  return `${l.slice(0, 4)} ${l.slice(4, 7)} ${l.slice(7)}`;
}

export const isNationalId = (v) => /^\d{16}$/.test(String(v ?? ''));

const ascii = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Jean Uwase + +250788123456 -> "juwase_0788" (initial + last name + first 4 digits of the local number). */
export function usernameFrom(fullName, normalizedPhone) {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  const first = ascii(parts[0] || 'user').slice(0, 1) || 'u';
  const last = ascii(parts.length > 1 ? parts[parts.length - 1] : parts[0] || 'user') || 'user';
  const tail = `0${String(normalizedPhone).replace(/^\+250/, '')}`.slice(0, 4);
  return `${first}${last}_${tail}`;
}

const pick = (chars) => chars[crypto.randomInt(chars.length)];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'; // no look-alikes (I, l, O, 0)

/** 6-digit one-time activation code. */
export const generateCode = () => String(crypto.randomInt(100000, 1000000));

/** 10 characters such as "Tp#8291xQa": letters, a symbol and digits, so it satisfies the password policy. */
export function generatePassword() {
  const digits = Array.from({ length: 4 }, () => String(crypto.randomInt(10))).join('');
  return `${pick(LETTERS)}${pick(LETTERS)}#${digits}${pick(LETTERS)}${pick(LETTERS)}${pick(LETTERS)}`;
}
