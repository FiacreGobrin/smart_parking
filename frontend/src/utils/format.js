const tz = 'Africa/Kigali';

export const money = (value, currency = 'RWF') => {
  const n = Number(value ?? 0);
  if (Number.isNaN(n)) return '-';
  return `${new Intl.NumberFormat('en-RW', { maximumFractionDigits: currency === 'RWF' ? 0 : 2 }).format(n)} ${currency}`;
};

export const num = (v) => new Intl.NumberFormat('en-RW').format(Number(v ?? 0));

export const dateTime = (v) => (v ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(v)) : '-');
export const dateOnly = (v) => (v ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: tz }).format(new Date(v)) : '-');
export const timeOnly = (v) => (v ? new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: tz }).format(new Date(v)) : '-');

export function duration(minutes) {
  if (minutes == null) return '-';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

export const minutesSince = (v) => Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000));

export function timeAgo(v) {
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const titleCase = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** "RAB123C" -> "RAB 123 C" for Rwandan-style plates; other plates are shown as stored. */
export function displayPlate(plate) {
  if (!plate) return '';
  const m = /^([A-Z]{2,3})(\d{2,4})([A-Z]{0,2})$/.exec(plate);
  return m ? [m[1], m[2], m[3]].filter(Boolean).join(' ') : plate;
}

/** Converts a Date or ISO string to the value format of <input type="datetime-local"> in local time. */
export function toLocalInput(v) {
  const d = v ? new Date(v) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "+250788123456" -> "0788 123 456" (how Rwandan numbers are written locally). */
export function localPhone(normalized) {
  const d = String(normalized ?? '').replace(/^\+250/, '');
  if (d.length !== 9) return normalized ?? '';
  const l = `0${d}`;
  return `${l.slice(0, 4)} ${l.slice(4, 7)} ${l.slice(7)}`;
}
