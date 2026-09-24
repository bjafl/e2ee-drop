// apps/api/src/routes/uploads.ts
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma } from "@e2ee-drop/db";
import type { RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired } from "../lib/links";
import { getSignedUploadUrl } from "../lib/storage";
import { env } from "../env";

const MAX_MESSAGE_LENGTH = 500;

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
      if (isLinkExpired(link)) {
        await prisma.link.delete({ where: { id: link.id } });
        return reply.status(404).send({ error: "Link not found" });
      }
      if (link.drops.length > 0) {
        return reply.status(409).send({ error: "Link already has a pending or completed drop" });
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
      await prisma.drop.create({
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

      const uploadUrl = await getSignedUploadUrl(s3Key);
      const body: RequestUploadUrlResponse = { dropId, uploadUrl };
      return reply.send(body);
    }
  );

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/complete",
    async (request, reply) => {
      const drop = await prisma.drop.findUnique({ where: { id: request.params.dropId } });
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      await prisma.drop.update({ where: { id: drop.id }, data: { status: "uploaded" } });
      return reply.send({ updated: true });
    }
  );
}
