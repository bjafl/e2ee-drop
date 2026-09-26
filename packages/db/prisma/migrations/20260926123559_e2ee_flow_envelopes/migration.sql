-- 1. Add all new nullable columns first (never fails on existing rows).
ALTER TABLE "Link" ADD COLUMN "ownerNote" TEXT;
ALTER TABLE "User" ADD COLUMN "showEmailOnPublicProfile" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Drop" ADD COLUMN "archiveNonce" TEXT;
ALTER TABLE "Drop" ADD COLUMN "encryptedMessage" TEXT;
ALTER TABLE "Drop" ADD COLUMN "messageNonce" TEXT;
ALTER TABLE "Drop" ADD COLUMN "messageRevealedAt" TIMESTAMP(3);
ALTER TABLE "Drop" ADD COLUMN "encryptedMetadata" TEXT;
ALTER TABLE "Drop" ADD COLUMN "metadataNonce" TEXT;
ALTER TABLE "Drop" ADD COLUMN "fileUploadStatus" TEXT NOT NULL DEFAULT 'uploading';
ALTER TABLE "Drop" ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'sender_opened';
ALTER TABLE "Drop" ADD COLUMN "messageEnvelopeStatus" TEXT NOT NULL DEFAULT 'sealed';
ALTER TABLE "Drop" ADD COLUMN "fileEnvelopeStatus" TEXT NOT NULL DEFAULT 'sealed';
ALTER TABLE "Drop" ADD COLUMN "contentDeletedAt" TIMESTAMP(3);

-- 2. Backfill from the old columns where a like-for-like mapping exists. Every existing Drop
--    row predates the three-envelope split, so its "message"/"fileName"/"mimeType" were always
--    plaintext — they CANNOT be retroactively encrypted (no server-held key ever existed for
--    them; that's the point of E2EE). This backfill preserves what the old columns already
--    guaranteed (upload/download progress) and deliberately drops what it cannot: any
--    pre-migration message/filename/mimetype is lost, not smuggled into the new encrypted
--    columns unencrypted.
UPDATE "Drop" SET "archiveNonce" = "nonce";
UPDATE "Drop" SET "fileUploadStatus" = CASE
  WHEN "status" = 'uploading' THEN 'uploading'
  ELSE 'complete'
END;
-- Old "downloading"/"downloaded" drops already left the upload phase; map to a display status
-- consistent with that so a drop that was already fully delivered doesn't regress to
-- "sender_opened" post-migration.
UPDATE "Drop" SET "deliveryStatus" = CASE
  WHEN "status" = 'uploading' THEN 'sender_opened'
  WHEN "status" = 'uploaded' THEN 'sent'
  ELSE 'delivered'
END;
UPDATE "Drop" SET "fileEnvelopeStatus" = CASE
  WHEN "status" = 'downloaded' THEN 'delivered'
  ELSE 'sealed'
END;
-- No pre-existing message content survives (see comment above) — mark any row that HAD a
-- message as already-revealed-and-gone rather than silently pretending it never had one.
UPDATE "Drop" SET "messageEnvelopeStatus" = 'delivered', "messageRevealedAt" = "createdAt"
  WHERE "message" IS NOT NULL;
-- Placeholder metadata for pre-migration rows: NOT NULL columns need a value, and there is no
-- recipient key on hand at migration time to encrypt the old plaintext fileName into
-- encryptedMetadata. Empty-envelope placeholders that will simply fail to decrypt cleanly
-- (a receiver sees "unable to read metadata" for these, not a 500) rather than a fabricated
-- ciphertext that looks legitimate.
UPDATE "Drop" SET "encryptedMetadata" = '', "metadataNonce" = '';

-- 3. Now that every row has a value, make the columns NOT NULL.
ALTER TABLE "Drop" ALTER COLUMN "archiveNonce" SET NOT NULL;
ALTER TABLE "Drop" ALTER COLUMN "encryptedMetadata" SET NOT NULL;
ALTER TABLE "Drop" ALTER COLUMN "metadataNonce" SET NOT NULL;

-- 4. Drop the old columns.
ALTER TABLE "Drop" DROP COLUMN "nonce";
ALTER TABLE "Drop" DROP COLUMN "fileName";
ALTER TABLE "Drop" DROP COLUMN "mimeType";
ALTER TABLE "Drop" DROP COLUMN "message";
ALTER TABLE "Drop" DROP COLUMN "status";

-- 5. Link.retentionDays: backfill from the existing env default (7, matching today's
--    DROP_RETENTION_DAYS default in apps/api/src/env.ts) before tightening to NOT NULL.
UPDATE "Link" SET "retentionDays" = 7 WHERE "retentionDays" IS NULL;
ALTER TABLE "Link" ALTER COLUMN "retentionDays" SET NOT NULL;

-- 6. Link.recipientPublicKey: relaxing NOT NULL is always safe on existing rows.
ALTER TABLE "Link" ALTER COLUMN "recipientPublicKey" DROP NOT NULL;
