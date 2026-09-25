// apps/api/src/routes/uploads.ts
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma, Prisma } from "@e2ee-drop/db";
import type { RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired, transitionDropStatus } from "../lib/links";
import { getSignedUploadUrl } from "../lib/storage";
import { env } from "../env";

const MAX_MESSAGE_LENGTH = 500;

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
      // Fast path only: avoids opening a transaction for the common case where we
      // already know from this same fetch that a drop exists. Not relied on for
      // correctness — the transaction below re-checks authoritatively.
      if (link.drops.length > 0) {
        return reply.status(409).send({ error: "Link already has a pending or completed drop" });
      }

      if (!request.body) {
        return reply.status(400).send({ error: "Missing metadata" });
      }
      const { senderPublicKey, message, metadata } = request.body;
      if (!senderPublicKey || !metadata?.fileName || !metadata?.nonce || !metadata?.mimeType || !metadata?.contentMD5 || !metadata?.fileSize) {
        return reply.status(400).send({ error: "Missing metadata" });
      }
      if (metadata.fileSize > env.MAX_FILE_SIZE_BYTES) {
        return reply.status(413).send({ error: `File too large (max ${env.MAX_FILE_SIZE_BYTES} bytes)` });
      }

      const dropId = nanoid();
      const s3Key = `${link.id}/${dropId}`;

      try {
        // Serializable isolation makes Postgres detect the phantom-read/write-skew
        // pattern here (transaction A's count sees zero rows, transaction B then
        // inserts a row for the same linkId) and abort one side with P2034, even
        // though there's no unique constraint on Drop.linkId to enforce this at the
        // row level. Re-fetch the count *inside* the transaction rather than reusing
        // `link.drops` from the fetch above, which is a stale snapshot from before
        // this transaction started.
        await prisma.$transaction(
          async (tx) => {
            const existingDropCount = await tx.drop.count({ where: { linkId: link.id } });
            if (existingDropCount > 0) {
              throw new DropAlreadyExistsError();
            }
            await tx.drop.create({
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

      const uploadUrl = await getSignedUploadUrl(s3Key);
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
      return reply.send({ updated: true });
    }
  );
}
