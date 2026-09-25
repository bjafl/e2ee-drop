// apps/api/src/routes/uploads.ts
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma, Prisma, type Drop } from "@e2ee-drop/db";
import type { RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired, toDropSummary, transitionDropStatus } from "../lib/links";
import { getSignedUploadUrl } from "../lib/storage";
import { emitDropEvent } from "../lib/dropEvents";
import { hasAcceptedContact } from "../lib/contacts";
import { env } from "../env";

const MAX_MESSAGE_LENGTH = 500;

// Clients encrypt the whole file with a single NaCl `box` (tweetnacl), whose
// ciphertext is always exactly plaintext length + this fixed Poly1305 tag overhead
// (nacl.box.overhead). The server therefore knows the exact byte count the upload
// must have from the declared plaintext `fileSize` alone, and signs it into the
// presigned PUT so storage enforces it.
const NACL_BOX_OVERHEAD_BYTES = 16;

// Postgres error code Prisma surfaces when a Serializable transaction loses a write
// conflict/read-write dependency to a concurrent transaction ("could not serialize
// access due to read/write dependencies among transactions").
const SERIALIZATION_FAILURE_CODE = "P2034";

// Thrown inside the transaction below when a re-check finds a drop already exists.
// Distinct from the Prisma serialization-failure error so both "someone else already
// has a confirmed drop" and "we lost a live race" map to the same 409 outward.
class DropAlreadyExistsError extends Error {}

function sanitizeMessage(message: string | undefined): string | null {
  if (!message) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = message.replace(/[\x00-\x1F\x7F]/g, "");
  return stripped.slice(0, MAX_MESSAGE_LENGTH) || null;
}

export function registerUploadRoutes(server: FastifyInstance): void {
  server.post<{ Params: { slug: string }; Body: RequestUploadUrlRequest }>(
    "/api/links/:slug/upload-url",
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

      let created: Drop;
      try {
        // Serializable isolation makes Postgres detect the phantom-read/write-skew
        // pattern here (transaction A's count sees zero rows, transaction B then
        // inserts a row for the same linkId) and abort one side with P2034, even
        // though there's no unique constraint on Drop.linkId to enforce this at the
        // row level. Re-fetch the count *inside* the transaction rather than reusing
        // `link.drops` from the fetch above, which is a stale snapshot from before
        // this transaction started.
        created = await prisma.$transaction(
          async (tx) => {
            const existingDropCount = await tx.drop.count({ where: { linkId: link.id } });
            if (link.mode === "one-time" && existingDropCount > 0) {
              throw new DropAlreadyExistsError();
            }
            return tx.drop.create({
              data: {
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
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (err) {
        if (err instanceof DropAlreadyExistsError) {
          return reply.status(409).send({ error: "Link already has a pending or completed drop" });
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === SERIALIZATION_FAILURE_CODE) {
          return reply.status(409).send({ error: "Link already has a pending or completed drop" });
        }
        throw err;
      }
      // Emitted only after the Serializable transaction has committed, so
      // subscribers never hear about a drop that a lost race rolled back.
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
      // belongs to this link. Drop ids are visible to anyone holding the link, so a
      // blind update would let them flip a drop to "uploaded" before its bytes exist,
      // or flip an already-"downloaded" drop back to "uploaded".
      const updated = await transitionDropStatus(request.params.dropId, link.id, ["uploading"], "uploaded");
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
