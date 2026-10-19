-- Aligns the data model with the approved design: user sign-up/approval, service pricing
-- (start price + increase per unit + cap), service-aware sessions, bank payments, SMS outbox.
-- Written to preserve existing rows (users, rates, sessions).

-- Enums
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'USER';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'BANK';
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED');
CREATE TYPE "ServiceType" AS ENUM ('PARKING', 'GARAGE', 'CAR_WASH');
CREATE TYPE "BillingUnit" AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH', 'VISIT');

-- Users: username sign-in, phone + national ID, status instead of isActive
ALTER TABLE "User"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "nationalId" TEXT,
  ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "activationCodeHash" TEXT;

UPDATE "User" u SET "username" = s.uname
FROM (
  SELECT id,
    lower(regexp_replace(split_part("email", '@', 1), '[^a-zA-Z0-9_]', '_', 'g'))
    || CASE WHEN row_number() OVER (PARTITION BY lower(regexp_replace(split_part("email", '@', 1), '[^a-zA-Z0-9_]', '_', 'g')) ORDER BY "createdAt") > 1
            THEN '_' || (row_number() OVER (PARTITION BY lower(regexp_replace(split_part("email", '@', 1), '[^a-zA-Z0-9_]', '_', 'g')) ORDER BY "createdAt"))::text
            ELSE '' END AS uname
  FROM "User"
) s WHERE u.id = s.id;

UPDATE "User" SET "status" = CASE WHEN "isActive" THEN 'ACTIVE'::"UserStatus" ELSE 'BLOCKED'::"UserStatus" END;

ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "User" DROP COLUMN "isActive";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
CREATE UNIQUE INDEX "User_nationalId_key" ON "User"("nationalId");
CREATE INDEX "User_status_idx" ON "User"("status");

-- Tariffs
ALTER TABLE "ParkingRate"
  ADD COLUMN "service" "ServiceType" NOT NULL DEFAULT 'PARKING',
  ADD COLUMN "unit" "BillingUnit" NOT NULL DEFAULT 'HOUR',
  ADD COLUMN "startPrice" DECIMAL(12,2) NOT NULL DEFAULT 100,
  ADD COLUMN "increment" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "cap" DECIMAL(12,2);

UPDATE "ParkingRate" SET
  "startPrice" = GREATEST("hourlyRate", 100),
  "increment" = "hourlyRate",
  "cap" = COALESCE("maxDailyCharge", "dailyRate");

ALTER TABLE "ParkingRate"
  DROP COLUMN "hourlyRate", DROP COLUMN "dailyRate", DROP COLUMN "maxDailyCharge", DROP COLUMN "minimumCharge",
  DROP COLUMN "graceMinutes", DROP COLUMN "roundingMinutes", DROP COLUMN "roundingStep", DROP COLUMN "monthlyPermitFee";
CREATE INDEX "ParkingRate_service_unit_idx" ON "ParkingRate"("service", "unit");

-- Sessions know which service they bill
ALTER TABLE "ParkingSession"
  ADD COLUMN "service" "ServiceType" NOT NULL DEFAULT 'PARKING',
  ADD COLUMN "billingUnit" "BillingUnit" NOT NULL DEFAULT 'HOUR';

-- SMS outbox
CREATE TABLE "SmsMessage" (
  "id" TEXT NOT NULL,
  "toPhone" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SIMULATED',
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmsMessage_createdAt_idx" ON "SmsMessage"("createdAt");

-- Sequential, human-readable payment references (MM-2026-001245)
CREATE SEQUENCE IF NOT EXISTS payment_ref_seq START 1001;
