// apps/api/src/routes/downloads.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { DownloadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired } from "../lib/links";
import { getSignedDownloadUrl } from "../lib/storage";

export function registerDownloadRoutes(server: FastifyInstance): void {
  server.get<{ Params: { slug: string } }>("/api/links/:slug/download-url", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    if (isLinkExpired(link)) {
      await prisma.link.delete({ where: { id: link.id } });
      return reply.status(404).send({ error: "Link not found" });
    }
    const drop = link.drops[0];
    if (!drop) return reply.status(404).send({ error: "No uploaded file for this link" });
    if (drop.status !== "uploaded") {
      return reply.status(403).send({ error: "File is not ready for download yet" });
    }

    const downloadUrl = await getSignedDownloadUrl(drop.s3Key);
    await prisma.drop.update({ where: { id: drop.id }, data: { status: "downloading" } });

    const body: DownloadUrlResponse = {
      downloadUrl,
      fileName: drop.fileName,
      fileSize: drop.fileSize,
      mimeType: drop.mimeType,
      nonce: drop.nonce,
      senderPublicKey: drop.senderPublicKey,
      contentMD5: drop.contentMD5,
    };
    return reply.send(body);
  });

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/downloaded",
    async (request, reply) => {
      const drop = await prisma.drop.findUnique({ where: { id: request.params.dropId } });
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      await prisma.drop.update({ where: { id: drop.id }, data: { status: "downloaded" } });
      return reply.send({ updated: true });
    }
  );
}
