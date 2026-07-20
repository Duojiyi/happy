-- Transient reservations from the pre-object-key schema cannot be safely matched to storage.
DELETE FROM "ChimeraAttachmentReservation";

-- Their aggregate was previously reflected in account state.
UPDATE "Account" SET "attachmentReservedBytes" = 0;

-- Add the required key after old rows have been removed. The default makes this
-- portable across PostgreSQL and PGlite; it is removed immediately.
ALTER TABLE "ChimeraAttachmentReservation" ADD COLUMN "objectKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ChimeraAttachmentReservation" ALTER COLUMN "objectKey" DROP DEFAULT;
