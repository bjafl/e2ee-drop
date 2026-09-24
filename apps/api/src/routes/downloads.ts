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
    if (drop.status === "uploading") {
      return reply.status(403).send({ error: "File is not ready for download yet" });
    }

    const downloadUrl = await getSignedDownloadUrl(drop.s3Key);
    // Status is informational progress, not a one-shot gate: a download URL can be
    // re-issued any number of times (network blip mid-download, expired presigned
    // URL, tab closed before the download actually started, etc.) as long as the
    // upload itself has finished. Only advance "uploaded" -> "downloading" on the
    // first successful issuance; don't regress an already-"downloading" or
    // "downloaded" drop back to "downloading".
    //
    // This must be a conditional update keyed on the row's *current* status, not a
    // blind update guarded by the `drop.status` snapshot read above: there's an
    // `await` boundary above (getSignedDownloadUrl) during which a concurrent
    // request (e.g. POST .../downloaded, or another overlapping GET that got
    // further along) could have already advanced the row past "uploaded". A blind
    // `update` here would stomp that newer status back to "downloading". `updateMany`
    // with `status: "uploaded"` in the where-clause is an atomic compare-and-swap in
    // Postgres: it only writes (and only matches a row) when the row is still
    // exactly "uploaded" at write time, so a race loses this write silently instead
    // of regressing state. URL issuance is returned regardless of whether the status
    // write actually happened — the two are independent concerns.
    await prisma.drop.updateMany({
      where: { id: drop.id, status: "uploaded" },
      data: { status: "downloading" },
    });

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
