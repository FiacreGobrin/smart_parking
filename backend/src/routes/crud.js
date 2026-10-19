import { Router } from 'express';
import { prisma } from '../config/db.js';
import { assertFacilityAccess, requirePermission, scopeFacility } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notFound } from '../utils/errors.js';
import { pageMeta, parsePagination, parseSort } from '../utils/pagination.js';
import { created, ok } from '../utils/respond.js';

/**
 * Generic, permission-checked, facility-scoped CRUD router. Keeps the many simple admin resources
 * (facilities, zones, spaces, cameras, gates, rates, ...) consistent: pagination, filtering, sorting,
 * soft-archiving and audit logging all behave the same way.
 *
 * options:
 *   model            prisma delegate name, e.g. 'parkingSpace'
 *   entity           audit entity label
 *   read / write     permission names
 *   createSchema / updateSchema   zod schemas
 *   scope            'facilityId' | 'id' | null   field used for facility scoping
 *   filters          query params matched exactly (array of field names)
 *   search           fields searched with case-insensitive "contains"
 *   sortable         fields allowed in ?sortBy=
 *   include          prisma include for reads
 *   archive          true => set archivedAt instead of deleting
 *   hooks            { beforeCreate(data, req), beforeUpdate(data, req, existing), afterChange(record, req, kind) }
 */
export function crud(o) {
  const router = Router();
  const db = () => prisma[o.model];
  const scopeField = o.scope === undefined ? 'facilityId' : o.scope;

  function buildWhere(req) {
    const where = {};
    if (o.archive) where.archivedAt = null;
    for (const f of o.filters || []) {
      const v = req.query[f];
      if (v === undefined || v === '') continue;
      where[f] = v === 'true' ? true : v === 'false' ? false : String(v);
    }
    if (scopeField) {
      const scoped = scopeFacility(req.user, req.query.facilityId?.toString());
      if (scoped && o.scopeIncludeNull) where.AND = [{ OR: [{ [scopeField]: scoped }, { [scopeField]: null }] }];
      else if (scoped) where[scopeField] = scoped;
    }
    if (req.query.search && o.search?.length) {
      where.OR = o.search.map((f) => ({ [f]: { contains: String(req.query.search), mode: 'insensitive' } }));
    }
    return where;
  }

  router.get('/', requirePermission(o.read), async (req, res) => {
    const { page, limit, skip, take } = parsePagination(req.query, { maxLimit: o.maxLimit || 100 });
    const where = buildWhere(req);
    const [rows, total] = await Promise.all([
      db().findMany({ where, skip, take, orderBy: parseSort(req.query, o.sortable || ['createdAt'], o.defaultSort || { createdAt: 'desc' }), include: o.include }),
      db().count({ where }),
    ]);
    ok(res, rows, pageMeta(page, limit, total));
  });

  router.get('/:id', requirePermission(o.read), async (req, res) => {
    const row = await db().findUnique({ where: { id: req.params.id }, include: o.detailInclude || o.include });
    if (!row || (o.archive && row.archivedAt)) throw notFound(o.entity);
    if (scopeField && !(o.scopeIncludeNull && row[scopeField] === null)) assertFacilityAccess(req.user, row[scopeField]);
    ok(res, row);
  });

  router.post('/', requirePermission(o.write), async (req, res) => {
    let data = o.createSchema.parse(req.body ?? {});
    if (scopeField && data[scopeField]) assertFacilityAccess(req.user, data[scopeField]);
    if (scopeField === 'id' && req.user.facilityId) throw notFound(o.entity); // scoped users cannot create top-level records
    if (o.hooks?.beforeCreate) data = (await o.hooks.beforeCreate(data, req)) ?? data;
    const row = await db().create({ data, include: o.include });
    await audit(req, { action: `${o.entity.toUpperCase()}_CREATED`, entity: o.entity, entityId: row.id, metadata: { after: data } });
    await o.hooks?.afterChange?.(row, req, 'create');
    created(res, row);
  });

  router.patch('/:id', requirePermission(o.write), async (req, res) => {
    const existing = await db().findUnique({ where: { id: req.params.id } });
    if (!existing || (o.archive && existing.archivedAt)) throw notFound(o.entity);
    if (scopeField) assertFacilityAccess(req.user, existing[scopeField]);
    let data;
    if (o.updateSchema) {
      data = o.updateSchema.parse(req.body ?? {});
    } else {
      // partial() keeps schema defaults, which would silently reset fields on PATCH: keep only sent keys.
      const parsed = o.createSchema.partial().parse(req.body ?? {});
      data = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in (req.body ?? {})));
    }
    if (scopeField && data[scopeField]) assertFacilityAccess(req.user, data[scopeField]);
    if (o.hooks?.beforeUpdate) data = (await o.hooks.beforeUpdate(data, req, existing)) ?? data;
    const row = await db().update({ where: { id: existing.id }, data, include: o.include });
    await audit(req, { action: `${o.entity.toUpperCase()}_UPDATED`, entity: o.entity, entityId: row.id, metadata: { before: pick(existing, data), after: data } });
    await o.hooks?.afterChange?.(row, req, 'update');
    ok(res, row);
  });

  router.delete('/:id', requirePermission(o.write), async (req, res) => {
    const existing = await db().findUnique({ where: { id: req.params.id } });
    if (!existing || (o.archive && existing.archivedAt)) throw notFound(o.entity);
    if (scopeField) assertFacilityAccess(req.user, existing[scopeField]);
    if (o.hooks?.beforeDelete) await o.hooks.beforeDelete(existing, req);
    if (o.archive) await db().update({ where: { id: existing.id }, data: { archivedAt: new Date() } });
    else await db().delete({ where: { id: existing.id } });
    await audit(req, { action: `${o.entity.toUpperCase()}_${o.archive ? 'ARCHIVED' : 'DELETED'}`, entity: o.entity, entityId: existing.id });
    await o.hooks?.afterChange?.(existing, req, 'delete');
    ok(res, { deleted: true, archived: !!o.archive });
  });

  return router;
}

const pick = (obj, like) => Object.fromEntries(Object.keys(like).map((k) => [k, obj[k]]));
