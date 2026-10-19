const KIGALI_OFFSET_MS = 2 * 3600000; // Rwanda is UTC+2 year-round (no DST)

// Parses ?from=&to= (ISO or YYYY-MM-DD). A date-only `to` includes the whole day.
export function parseRange(query, defaultDays = 30) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultDays * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

// Midnight today in Africa/Kigali, expressed as a UTC instant.
export function startOfToday(now = new Date()) {
  const local = new Date(now.getTime() + KIGALI_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - KIGALI_OFFSET_MS);
}

export const daysAgo = (n) => new Date(startOfToday().getTime() - n * 86400000);
