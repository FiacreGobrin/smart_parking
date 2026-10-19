-- Scanned plate photos are kept in the database itself, next to the recognized text,
-- so they survive redeploys on hosts with ephemeral disks.
ALTER TABLE "RecognitionEvent" ADD COLUMN "imageData" BYTEA, ADD COLUMN "imageMime" TEXT;
