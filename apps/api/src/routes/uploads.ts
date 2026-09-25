// apps/api/src/routes/uploads.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { prisma, Prisma, type Drop } from "@e2ee-drop/db";
import type { RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired, toDropSummary, transitionDropStatus } from "../lib/links";
import { getSignedUploadUrl } from "../lib/storage";
import { emitDropEvent } from "../lib/dropEvents";
import { hasAcceptedContact } from "../lib/contacts";
import {
  NACL_BOX_OVERHEAD_BYTES,
  QUOTA_TX_OPTIONS,
  QuotaExceededError,
  assertWithinQuota,
  chargedBytes,
  lockOwnerQuota,
  reservationCutoff,
} from "../lib/quota";
import { env } from "../env";
import { uploadUrlRateLimiter, rateLimitExceededBody } from "../lib/rateLimit";

const MAX_MESSAGE_LENGTH = 500;

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

function sanitizeMessage(message: string | undefined): string | null {
  if (!message) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = message.replace(/[\x00-\x1F\x7F]/g, "");
  return stripped.slice(0, MAX_MESSAGE_LENGTH) || null;
}

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
    { preHandler: uploadUrlRateLimit },
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
      const { senderPublicKey, message, metadata } = request.body;
      if (!senderPublicKey || !metadata?.fileName || !metadata?.nonce || !metadata?.mimeType || !metadata?.contentMD5 || !metadata?.fileSize) {
        return reply.status(400).send({ error: "Missing metadata" });
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

      const dropId = nanoid();
      const s3Key = `${link.id}/${dropId}`;

      const dropData: Prisma.DropUncheckedCreateInput = {
        id: dropId,
        linkId: link.id,
        senderPublicKey,
        s3Key,
        nonce: metadata.nonce,
        fileName: metadata.fileName,
        fileSize: metadata.fileSize,
        mimeType: metadata.mimeType,
        contentMD5: metadata.contentMD5,
        message: sanitizeMessage(message),
        status: "uploading",
      };

      let created: Drop;
      try {
        const ownerId = link.ownerId;
        if (ownerId !== null) {
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
      emitDropEvent(link.id, { type: "drop-created", drop: toDropSummary(created) });

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
      // Compare-and-swap: only "uploading" -> "uploaded", and only for a drop that
      // belongs to this link. An anonymous link's drop id is visible to anyone
      // holding the link (GET /api/links/:slug), so a blind update would let them flip a drop to "uploaded" before its bytes exist,
      // or flip an already-"downloaded" drop back to "uploaded".
      const ownerId = link.ownerId;
      let updated: boolean;
      if (ownerId === null) {
        // Anonymous link: no owner, no quota to charge.
        updated = await transitionDropStatus(request.params.dropId, link.id, ["uploading"], "uploaded");
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
              id: request.params.dropId,
              linkId: link.id,
              status: "uploading",
              createdAt: { gt: reservationCutoff() },
            },
            data: { status: "uploaded" },
          });
          if (count !== 1) {
            // Lost the CAS. Only to choose the error message: a drop that is
            // still "uploading" here failed on age alone. Nothing is written.
            const stale = await tx.drop.count({
              where: { id: request.params.dropId, linkId: link.id, status: "uploading" },
            });
            return stale > 0 ? ("expired" as const) : ("not-found" as const);
          }
          const { fileSize } = await tx.drop.findUniqueOrThrow({
            where: { id: request.params.dropId },
            select: { fileSize: true },
          });
          await tx.user.update({
            where: { id: ownerId },
            data: { storageUsedBytes: { increment: chargedBytes(fileSize) } },
          });
          return "completed" as const;
        }, QUOTA_TX_OPTIONS);
        // 410 rather than 404: the drop exists, but the upload window it was
        // granted has closed for good; the sender must start a new upload.
        if (outcome === "expired") {
          return reply.status(410).send({ error: "Upload window expired; please start the upload again" });
        }
        updated = outcome === "completed";
      }
      if (!updated) return reply.status(404).send({ error: "Drop not found" });
      // Only emitted when this call actually won the CAS. The drop was created
      // (as "uploading") before this request fetched `link`, so it's in the snapshot.
      const drop = link.drops.find((candidate) => candidate.id === request.params.dropId);
      if (drop) {
        emitDropEvent(link.id, { type: "drop-updated", drop: toDropSummary({ ...drop, status: "uploaded" }) });
      }
      return reply.send({ updated: true });
    }
  );
}
