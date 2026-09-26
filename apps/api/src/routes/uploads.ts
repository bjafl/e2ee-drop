// apps/api/src/routes/uploads.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { prisma, Prisma, type Drop } from "@e2ee-drop/db";
import type { RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired, toDropSummary, transitionFileUploadStatus } from "../lib/links";
import { getSignedUploadUrl, objectHasSize } from "../lib/storage";
import { emitDropEvent } from "../lib/dropEvents";
import { hasAcceptedContact } from "../lib/contacts";
import {
  NACL_BOX_OVERHEAD_BYTES,
  QUOTA_TX_OPTIONS,
  QuotaExceededError,
  SenderReservationLimitError,
  assertWithinQuota,
  assertWithinSenderShare,
  chargedBytes,
  lockOwnerQuota,
  reservationCutoff,
} from "../lib/quota";
import { reservationSenderKey } from "../lib/senderKey";
import { env } from "../env";
import { uploadUrlRateLimiter, rateLimitExceededBody } from "../lib/rateLimit";
import { assertSenderIdentity, SenderIdentityMismatchError } from "../lib/senderIdentity";

// A drop only reaches "complete" after a successful /complete. A repeated or
// late /complete on such a drop is answered idempotently (200), never re-run.
function isCompletedStatus(fileUploadStatus: string): boolean {
  return fileUploadStatus === "complete";
}

// NACL_BOX_OVERHEAD_BYTES (lib/quota): the server knows the exact ciphertext byte
// count from the declared plaintext `fileSize` alone, and signs it into the
// presigned PUT so storage enforces it. The same figure is what a drop is charged
// against its owner's storage quota.

// Postgres error code Prisma surfaces when a Serializable transaction loses a write
// conflict/read-write dependency to a concurrent transaction ("could not serialize
// access due to read/write dependencies among transactions").
const SERIALIZATION_FAILURE_CODE = "P2034";

// Thrown inside the transaction below when a re-check finds a drop already exists.
// Distinct from the Prisma serialization-failure error so both "someone else already
// has a confirmed drop" and "we lost a live race" map to the same 409 outward.
class DropAlreadyExistsError extends Error {}

// The owned link's owner row vanished between fetching the link and locking the
// owner (account deletion in progress). The link is on its way out too.
class OwnerGoneError extends Error {}

// Keyed by the sender's IP, never the link/owner (see uploadUrlRateLimiter in
// lib/rateLimit.ts). Applied to every upload-url call rather than only the
// owned-link (quota-reserving) branch: it runs before the link lookup, so a
// throttled caller costs no DB work at all, and for anonymous links it is
// harmless defense-in-depth on top of their single-drop Serializable check.
async function uploadUrlRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!uploadUrlRateLimiter.attempt(request.ip)) {
    reply.status(429).send(rateLimitExceededBody());
  }
}

export function registerUploadRoutes(server: FastifyInstance): void {
  server.post<{ Params: { slug: string }; Body: RequestUploadUrlRequest }>(
    "/api/links/:slug/upload-url",
    {
      preHandler: uploadUrlRateLimit,
      schema: {
        body: {
          type: "object",
          properties: {
            senderPublicKey: { type: "string" },
            archiveNonce: { type: "string" },
            encryptedMessage: { type: ["string", "null"] },
            messageNonce: { type: ["string", "null"] },
            encryptedMetadata: { type: "string" },
            metadataNonce: { type: "string" },
            metadata: {
              type: "object",
              properties: {
                fileSize: { type: "integer" },
                contentMD5: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      // Not deleted here — see the GET /api/links/:slug handler: only the cleanup
      // job deletes expired links, so storage objects are never orphaned.
      if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      // Checked before any DB writes or the Serializable transaction below: a
      // disallowed sender should be rejected as cheaply as possible, and must
      // never cause a drop row (or queue-limit bookkeeping) to be created.
      if (link.visibility === "contacts-only") {
        const allowed = request.user ? await hasAcceptedContact(link.ownerId!, request.user.id) : false;
        if (!allowed) {
          return reply.status(403).send({ error: "This link only accepts uploads from approved contacts" });
        }
      }
      // Fast path only: avoids opening a transaction for the common case where we
      // already know from this same fetch that a drop exists. Not relied on for
      // correctness — the transaction below re-checks authoritatively.
      if (link.mode === "one-time" && link.drops.length > 0) {
        return reply.status(409).send({ error: "Link already has a pending or completed drop" });
      }

      if (!request.body) {
        return reply.status(400).send({ error: "Missing metadata" });
      }
      const { senderPublicKey, archiveNonce, encryptedMessage, messageNonce, encryptedMetadata, metadataNonce, metadata } =
        request.body;
      if (
        !senderPublicKey ||
        !archiveNonce ||
        !encryptedMetadata ||
        !metadataNonce ||
        !metadata?.contentMD5 ||
        !metadata?.fileSize
      ) {
        return reply.status(400).send({ error: "Missing metadata" });
      }
      if ((encryptedMessage && !messageNonce) || (!encryptedMessage && messageNonce)) {
        return reply.status(400).send({ error: "encryptedMessage and messageNonce must be provided together" });
      }
      // fileSize determines the signed Content-Length of the upload, so it must be a
      // real byte count — not a string ("10" + 16 would be "1016"), fraction or
      // negative number that slips past the size check below.
      if (!Number.isSafeInteger(metadata.fileSize) || metadata.fileSize <= 0) {
        return reply.status(400).send({ error: "Invalid fileSize" });
      }
      if (metadata.fileSize > env.MAX_FILE_SIZE_BYTES) {
        return reply.status(413).send({ error: `File too large (max ${env.MAX_FILE_SIZE_BYTES} bytes)` });
      }
      // Design spec §3.2: an authenticated sender's claimed senderPublicKey must match their
      // account's own public key, or the inbox (spec §5) could display a different account's
      // name than the one that actually produced the ciphertext (see lib/senderIdentity.ts).
      // request.user only carries `id` (apps/api/src/plugins/auth.ts), so the account's
      // publicKey is fetched fresh here rather than trusted from the session.
      const senderAccount = request.user
        ? await prisma.user.findUnique({ where: { id: request.user.id }, select: { publicKey: true } })
        : null;
      try {
        assertSenderIdentity(senderAccount, senderPublicKey);
      } catch (err) {
        if (err instanceof SenderIdentityMismatchError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }

      const dropId = nanoid();
      const s3Key = `${link.id}/${dropId}`;

      const dropData: Prisma.DropUncheckedCreateInput = {
        id: dropId,
        linkId: link.id,
        senderPublicKey,
        senderUserId: request.user?.id,
        s3Key,
        archiveNonce,
        encryptedMessage: encryptedMessage ?? undefined,
        messageNonce: messageNonce ?? undefined,
        encryptedMetadata,
        metadataNonce,
        fileSize: metadata.fileSize,
        contentMD5: metadata.contentMD5,
        fileUploadStatus: "uploading",
      };

      let created: Drop;
      try {
        const ownerId = link.ownerId;
        if (ownerId !== null) {
          // Tags this reservation with the sender's network, so no single
          // sender can hold more than its share of the owner's quota in
          // reservations (assertWithinSenderShare below; lib/quota.ts).
          const senderKey = reservationSenderKey(request.ip);
          dropData.reservationSenderKey = senderKey;
          // Owned link (either mode): the storage quota (spec §8) is checked and
          // the drop inserted under a row lock on the owner, so every upload-url
          // for this owner — across all their links — is serialized here. That
          // makes the quota check race-free (concurrent senders can't each pass
          // it against the same free space), and it also protects an owned
          // one-time link's single-drop invariant: with inserts serialized, a
          // plain Read Committed count after the lock sees every committed drop,
          // so the Serializable transaction below isn't needed (and would take
          // its snapshot before the lock wait, hiding the drops we queued behind).
          created = await prisma.$transaction(async (tx) => {
            const owner = await lockOwnerQuota(tx, ownerId);
            if (!owner) throw new OwnerGoneError();
            if (link.mode !== "permanent") {
              const existingDropCount = await tx.drop.count({ where: { linkId: link.id } });
              if (existingDropCount > 0) throw new DropAlreadyExistsError();
            }
            await assertWithinQuota(tx, ownerId, owner, metadata.fileSize);
            // Same lock, same transaction as the insert below: two concurrent
            // requests from one sender can't both pass against one headroom.
            await assertWithinSenderShare(tx, ownerId, owner, senderKey, metadata.fileSize, env.MAX_FILE_SIZE_BYTES);
            return tx.drop.create({ data: dropData });
          }, QUOTA_TX_OPTIONS);
        } else if (link.mode === "permanent") {
          // Anonymous permanent link (none are created today; kept for safety).
          // A permanent link accepts any number of drops, so there is no
          // one-drop invariant to protect and no reason to pay for Serializable
          // isolation. Running these inserts in the Serializable transaction
          // below made concurrent senders abort each other with P2034, which
          // surfaced as spurious 409s on a link that is supposed to queue them.
          created = await prisma.drop.create({ data: dropData });
        } else {
          // Anonymous one-time link (Plan 1): at most one drop, ever. Serializable isolation makes
          // Postgres detect the phantom-read/write-skew pattern here (transaction
          // A's count sees zero rows, transaction B then inserts a row for the
          // same linkId) and abort one side with P2034, even though there's no
          // unique constraint on Drop.linkId to enforce this at the row level.
          // Re-fetch the count *inside* the transaction rather than reusing
          // `link.drops` from the fetch above, which is a stale snapshot from
          // before this transaction started.
          created = await prisma.$transaction(
            async (tx) => {
              const existingDropCount = await tx.drop.count({ where: { linkId: link.id } });
              if (existingDropCount > 0) {
                throw new DropAlreadyExistsError();
              }
              return tx.drop.create({ data: dropData });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          );
        }
      } catch (err) {
        if (err instanceof DropAlreadyExistsError) {
          return reply.status(409).send({ error: "Link already has a pending or completed drop" });
        }
        // 413, like the MAX_FILE_SIZE_BYTES check above: the request is refused
        // purely because of its size relative to available capacity (a smaller
        // file could still go through), not because this sender lacks
        // permission — 403 is reserved in these routes for who-may-do-this
        // rejections (contacts-only, not the owner). The message deliberately
        // omits the owner's usage/remaining bytes: senders are often strangers.
        if (err instanceof QuotaExceededError) {
          return reply.status(413).send({ error: "Recipient's storage quota exceeded" });
        }
        // 429, not 413: the recipient still has room; it's this sender (network)
        // that already holds its share of it in unfinished uploads. Checked
        // after the quota, so a genuinely full inbox still reads as 413.
        if (err instanceof SenderReservationLimitError) {
          return reply
            .status(429)
            .header("Retry-After", String(err.retryAfterSeconds))
            .send({
              error:
                "Too many unfinished uploads to this recipient from your network. Finish or wait for them, then try again.",
            });
        }
        if (err instanceof OwnerGoneError) {
          return reply.status(404).send({ error: "Link not found" });
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === SERIALIZATION_FAILURE_CODE) {
          return reply.status(409).send({ error: "Link already has a pending or completed drop" });
        }
        throw err;
      }
      // Emitted only after the drop row has committed (for one-time links, after
      // the Serializable transaction), so subscribers never hear about a drop
      // that a lost race rolled back.
      emitDropEvent(link.id, { type: "drop-created", drop: toDropSummary(created, link) });

      const uploadUrl = await getSignedUploadUrl(s3Key, metadata.fileSize + NACL_BOX_OVERHEAD_BYTES);
      const body: RequestUploadUrlResponse = { dropId, uploadUrl };
      return reply.send(body);
    }
  );

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/complete",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      const { dropId } = request.params;

      // Scoped by link: a drop id alone must never act on another link's drop.
      const drop = await prisma.drop.findFirst({
        where: { id: dropId, linkId: link.id },
        select: { fileUploadStatus: true, s3Key: true, fileSize: true },
      });
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      // Idempotent: a drop that is already complete reports success again
      // rather than 404. Otherwise a sender whose drop was completed first by
      // someone else — a bystander holding an anonymous link's slug, or just
      // its own retried request — sees "upload failed" with no way forward,
      // even though its bytes landed. Nothing is written here, so an owned
      // link's quota is not charged a second time.
      if (isCompletedStatus(drop.fileUploadStatus)) return reply.send({ updated: false });

      // Verify, don't trust (spec §5.1): the caller's word that the upload
      // finished is not enough. Only an object actually in storage with
      // exactly the size the presigned PUT was signed for (upload-url above)
      // may complete the drop. Without this, the sender on an OWNED link could
      // skip the PUT and call /complete directly, charging the owner's quota
      // for bytes that were never stored (and freeing its own reservation
      // share for another round); and anyone holding an anonymous link's slug
      // could flip the drop to "uploaded" before its bytes exist. Checked
      // outside any transaction: no row lock is held across a network call.
      // A missed race (object deleted between here and the CAS) can only
      // happen with the drop row itself, so the CAS then simply misses.
      if (!(await objectHasSize(drop.s3Key, drop.fileSize + NACL_BOX_OVERHEAD_BYTES))) {
        // 409: the drop exists and the request is well-formed, but it
        // conflicts with the current state of storage. The sender may retry
        // once its PUT has actually succeeded.
        return reply.status(409).send({ error: "Upload not received yet; finish uploading the file, then try again" });
      }

      // Compare-and-swap: only "uploading" -> "complete", and only for a drop
      // that belongs to this link, so a late call can never regress an
      // already-complete drop.
      const ownerId = link.ownerId;
      let updated: boolean;
      if (ownerId === null) {
        // Anonymous link: no owner, no quota to charge.
        //
        // Any slug holder can read this drop's id (GET /api/links/:slug), and
        // so can call /complete on it (security review SEC10). With the HEAD
        // check above they can only report a completion that is already true,
        // and the idempotent early return means the real sender's own call
        // still succeeds afterwards. Slot-taking and DELETE by a slug holder
        // remain accepted trade-offs (spec §5.1).
        updated = await transitionFileUploadStatus(dropId, link.id, ["uploading"], "complete");
        if (updated) {
          await prisma.drop.update({ where: { id: dropId }, data: { deliveryStatus: "sent" } });
        }
      } else {
        // Owned link: the CAS and the owner's quota charge commit together, and
        // the charge happens only if this call won the CAS — so a drop is charged
        // exactly once no matter how many /complete calls race or repeat, and
        // there is no moment where a drop is neither "uploading" (reserved at
        // upload-url) nor counted in storageUsedBytes. The owner row is locked
        // first to keep the lock order (User -> Drop) consistent with the
        // deletion paths in lib/quota.ts; the charge itself is an atomic
        // increment, never read-then-write.
        //
        // The CAS also requires the drop to still be inside its upload
        // reservation window (lib/quota.ts). Once it falls out, upload-url no
        // longer counts it, so its capacity may already have been reserved by
        // another sender; charging it now could push usage past the quota.
        // The age condition sits in the same UPDATE ... WHERE as the status
        // condition, so there is no check-then-act gap, and the cutoff is taken
        // after the owner lock, so it is never earlier than the cutoff any
        // upload-url that ran before us (also under this lock) used.
        const outcome = await prisma.$transaction(async (tx) => {
          if (!(await lockOwnerQuota(tx, ownerId))) return "not-found" as const;
          const { count } = await tx.drop.updateMany({
            where: {
              id: dropId,
              linkId: link.id,
              fileUploadStatus: "uploading",
              createdAt: { gt: reservationCutoff() },
            },
            // No longer a reservation, so the sender tag has no further use.
            data: { fileUploadStatus: "complete", deliveryStatus: "sent", reservationSenderKey: null },
          });
          if (count !== 1) return "lost" as const;
          await tx.user.update({
            where: { id: ownerId },
            data: { storageUsedBytes: { increment: chargedBytes(drop.fileSize) } },
          });
          return "completed" as const;
        }, QUOTA_TX_OPTIONS);
        if (outcome === "not-found") return reply.status(404).send({ error: "Link not found" });
        updated = outcome === "completed";
      }

      if (!updated) {
        // Lost the CAS. Re-read only to choose the response; nothing is written.
        const current = await prisma.drop.findFirst({
          where: { id: dropId, linkId: link.id },
          select: { fileUploadStatus: true },
        });
        if (!current) return reply.status(404).send({ error: "Drop not found" });
        // A concurrent /complete for the same drop won: same idempotent success
        // as the early return above, and it did the one and only charge.
        if (isCompletedStatus(current.fileUploadStatus)) return reply.send({ updated: false });
        // Still "uploading", so (owned links only) the age condition failed.
        // 410 rather than 404: the drop exists, but the upload window it was
        // granted has closed for good; the sender must start a new upload.
        return reply.status(410).send({ error: "Upload window expired; please start the upload again" });
      }
      // Only emitted when this call actually won the CAS. The drop was created
      // (as "uploading") before this request fetched `link`, so it's in the snapshot.
      const snapshot = link.drops.find((candidate) => candidate.id === dropId);
      if (snapshot) {
        emitDropEvent(link.id, {
          type: "drop-updated",
          drop: toDropSummary({ ...snapshot, fileUploadStatus: "complete", deliveryStatus: "sent" }, link),
        });
      }
      return reply.send({ updated: true });
    }
  );

  // Design spec §5.1: a sender whose upload PUT fails or is abandoned gets a clean slate, not a
  // resumed attempt — this deletes the reservation outright (message envelope included) rather
  // than leaving a stale "uploading" row that would block a one-time link's single-drop slot
  // until the passive sweep (Task 8) eventually catches it, up to an hour later.
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/abandon",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      const { dropId } = request.params;
      // Same CAS discipline as everywhere else: only a drop still "uploading" for THIS link is
      // eligible, so a late abandon call on an already-completed drop is a harmless no-op, never
      // a race that deletes real, delivered content.
      const { count } = await prisma.drop.deleteMany({
        where: { id: dropId, linkId: link.id, fileUploadStatus: "uploading" },
      });
      return reply.send({ abandoned: count === 1 });
    }
  );
}
