// apps/api/src/routes/downloads.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { DownloadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired, toDropSummary, transitionDropStatus } from "../lib/links";
import { getSignedDownloadUrl } from "../lib/storage";
import { emitDropEvent } from "../lib/dropEvents";

export function registerDownloadRoutes(server: FastifyInstance): void {
  server.get<{ Params: { slug: string }; Querystring: { dropId?: string } }>(
    "/api/links/:slug/download-url",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      // Not deleted here — see the GET /api/links/:slug handler: only the cleanup
      // job deletes expired links, so storage objects are never orphaned.
      if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      // Owned links: only the owner may download. Anonymous (ownerId === null)
      // links are untouched — any link holder may download, as in Plan 1.
      // request.user is always set (null without a valid session) by the global
      // onRequest hook in plugins/auth.ts.
      if (link.ownerId && link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      // A permanent link can hold a queue of drops, so the client names the one it
      // wants. Selecting from `link.drops` (this link's drops only) means a dropId
      // from some other link simply isn't found. Without a dropId, fall back to the
      // link's single drop — Plan 1's one-time-link behavior.
      const { dropId } = request.query;
      const drop = dropId ? link.drops.find((candidate) => candidate.id === dropId) : link.drops[0];
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
      //
      // Only the request that actually wins the CAS (count === 1) announces the
      // transition to SSE subscribers; a re-issuance or a lost race emits nothing,
      // so subscribers never see a stale or duplicate "downloading" event. The
      // summary is built from the snapshot with the status the CAS just wrote —
      // nothing else on a drop row changes after creation.
      const { count } = await prisma.drop.updateMany({
        where: { id: drop.id, status: "uploaded" },
        data: { status: "downloading" },
      });
      if (count === 1) {
        emitDropEvent(link.id, { type: "drop-updated", drop: toDropSummary({ ...drop, status: "downloading" }) });
      }

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
    }
  );

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/downloaded",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      // Same ownership rule as download-url: only the owner may mark an owned
      // link's drop downloaded; anonymous links stay open to any link holder.
      if (link.ownerId && link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      // Compare-and-swap, scoped to this link: only a drop whose upload has finished
      // ("uploaded", or "downloading" once a download URL was issued) can become
      // "downloaded". Rejecting "uploading" stops a link holder from marking a drop
      // downloaded before it exists; drop ids are not secret (GET /api/links/:slug
      // returns them), so the linkId scoping is what ties the call to this link.
      const updated = await transitionDropStatus(
        request.params.dropId,
        link.id,
        ["uploaded", "downloading"],
        "downloaded"
      );
      if (!updated) return reply.status(404).send({ error: "Drop not found" });
      // The CAS only matches a drop on this link in "uploaded"/"downloading", and
      // such a drop already existed when `link` was fetched (new drops start as
      // "uploading"), so it's in this snapshot.
      const drop = link.drops.find((candidate) => candidate.id === request.params.dropId);
      if (drop) {
        emitDropEvent(link.id, { type: "drop-updated", drop: toDropSummary({ ...drop, status: "downloaded" }) });
      }
      return reply.send({ updated: true });
    }
  );
}
