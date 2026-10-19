-- Integrity rules Prisma cannot express in schema.prisma.

-- 1. A plate can have at most one ACTIVE parking session.
CREATE UNIQUE INDEX "ParkingSession_one_active_per_plate"
  ON "ParkingSession" ("plate") WHERE "status" = 'ACTIVE';

-- 2. A space can host at most one ACTIVE parking session.
CREATE UNIQUE INDEX "ParkingSession_one_active_per_space"
  ON "ParkingSession" ("spaceId") WHERE "status" = 'ACTIVE' AND "spaceId" IS NOT NULL;

-- 3. Payments never carry a negative or zero amount.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive" CHECK ("amount" > 0);

-- 4. Reservations on the same space cannot overlap while they are live.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_no_overlap"
  EXCLUDE USING gist ("spaceId" WITH =, tsrange("startAt", "endAt", '[)') WITH &&)
  WHERE ("status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN'));
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_valid_period" CHECK ("endAt" > "startAt");

-- 5. Audit records are append-only.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
