# Database design

Source of truth: `backend/prisma/schema.prisma` plus `prisma/migrations/*_constraints/migration.sql`.

## Entity relationships

```
ParkingFacility 1─* ParkingZone 1─* ParkingSpace 1─* SpaceStatusHistory
ParkingFacility 1─* ParkingSpace, Gate, Camera, ParkingRate(optional), User(optional)
Gate 1─* Camera, GateEvent, RecognitionEvent
Vehicle *─1 VehicleOwner
ParkingSession *─1 Vehicle(optional, by plate) *─1 ParkingFacility *─1 ParkingSpace(optional)
ParkingSession 1─* Payment 1─1 Receipt
Payment *─1 ParkingPermit(optional)
Reservation *─1 ParkingSpace, optional 1─1 ParkingSession
User 1─* RefreshToken, LoginHistory, NotificationRead
Notification 1─* NotificationRead      AuditLog (append-only)      SystemSetting (key/value)
WebhookEvent (provider, eventId unique)  -> webhook idempotency
```

## Design decisions

- **Plates** are stored normalized (`RAB123C`) with the operator's spelling in `plateDisplay`. Sessions reference the plate, so unregistered visitors work without polluting the vehicle registry.
- **Money** is `NUMERIC(12,2)` everywhere; arithmetic uses decimal.js. Totals round to a configurable step (50 RWF by default).
- **Soft deletion** (`archivedAt`) for facilities, spaces, vehicles, users so history stays resolvable. Hard deletes only for devices/tariffs/zones with no dependants.
- **Timestamps** are stored in UTC; reports bucket by `Africa/Kigali`.
- **Roles and permissions** are a code-level map (`config/permissions.js`) rather than tables: simpler to review and test. Move them to tables if per-tenant customization is needed.

## Integrity rules enforced by PostgreSQL

| Rule | Mechanism |
|---|---|
| One ACTIVE session per plate | partial unique index on `ParkingSession(plate) WHERE status='ACTIVE'` |
| One ACTIVE session per space | partial unique index on `ParkingSession(spaceId) WHERE status='ACTIVE' AND spaceId IS NOT NULL` |
| No overlapping live reservations on a space | `EXCLUDE USING gist (spaceId =, tsrange(startAt,endAt) &&) WHERE status IN (PENDING,CONFIRMED,CHECKED_IN)` |
| Unique payment reference / provider reference / idempotency key | unique constraints |
| Payments are positive | `CHECK (amount > 0)` |
| Reservation ends after it starts | `CHECK (endAt > startAt)` |
| Audit log cannot be edited or deleted | `BEFORE UPDATE OR DELETE` trigger raising an exception |
| Webhook events processed once | unique `(provider, eventId)` |

Concurrency: space allocation uses `SELECT ... FOR UPDATE SKIP LOCKED` inside the entry transaction, so simultaneous entries never receive the same space. Session close is a conditional update (`WHERE status='ACTIVE'`) so double exits cannot both succeed.

## Operations

- Apply: `npx prisma migrate deploy` (never `db push`: it would skip the custom constraints).
- Seed: `npm run db:seed` (demo data only outside production).
- New migration after editing the schema: `npx prisma migrate dev --name <change>` against a development database.
