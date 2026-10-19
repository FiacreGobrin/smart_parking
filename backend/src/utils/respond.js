export const ok = (res, data, meta, status = 200) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

export const created = (res, data) => ok(res, data, undefined, 201);
