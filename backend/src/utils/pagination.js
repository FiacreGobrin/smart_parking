export function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function parseSort(query, allowed, fallback = { createdAt: 'desc' }) {
  const field = String(query.sortBy || '');
  if (!allowed.includes(field)) return fallback;
  return { [field]: query.order === 'asc' ? 'asc' : 'desc' };
}

export const pageMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});
