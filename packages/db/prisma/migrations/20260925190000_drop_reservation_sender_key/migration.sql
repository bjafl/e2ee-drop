-- Per-sender share of an owner's in-flight upload reservations (see
-- apps/api/src/lib/quota.ts assertWithinSenderShare). Nullable: only set on
-- owned links' "uploading" drops, cleared on /complete.
ALTER TABLE "Drop" ADD COLUMN "reservationSenderKey" TEXT;
