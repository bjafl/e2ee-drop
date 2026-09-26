// apps/api/src/routes/downloads.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { DownloadUrlResponse, RevealMessageResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired } from "../lib/links";
import { getSignedDownloadUrl, deleteObject } from "../lib/storage";

// fileEnvelopeStatus values that mean "this drop's file bytes are gone/spoken
// for" — a compare-and-swap gate never lets a write clobber either of these.
// "shredded" isn't written anywhere in this plan (reserved for a future
// deletion path — see schema.prisma) but is future-proofed here regardless.
const TERMINAL_FILE_ENVELOPE_STATUSES = ["delivered", "shredded"] as const;

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
      if (drop.fileUploadStatus !== "complete") {
        return reply.status(403).send({ error: "File is not ready for download yet" });
      }

      // Design spec §6.3: this route no longer has a status side effect. The old
      // "uploaded" -> "downloading" CAS marked in-flight progress that the
      // complete-download/download-failed pair below now reports explicitly and
      // far more reliably (an issued-but-never-fetched presigned URL used to
      // leave a drop stuck "downloading" forever). A download URL can still be
      // re-issued any number of times — nothing here gates repeat issuance.
      const downloadUrl = await getSignedDownloadUrl(drop.s3Key);
      const body: DownloadUrlResponse = {
        downloadUrl,
        archiveNonce: drop.archiveNonce,
        senderPublicKey: drop.senderPublicKey,
        contentMD5: drop.contentMD5,
      };
      return reply.send(body);
    }
  );

  // Design spec §3.3/§6.3: the client has already recomputed the ciphertext hash
  // and confirmed it matches contentMD5 before ever calling this route —
  // deletion is gated on that match having happened, never on whether
  // decryption (attempted client-side afterward) also succeeded. A hash
  // mismatch must never reach this route at all; a hash match must delete the
  // object regardless of what the client's decryption step later does with it.
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/complete-download",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      // Same ownership rule as download-url: only the owner may complete a
      // download on an owned link; anonymous links stay open to any link holder.
      if (link.ownerId && link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const { dropId } = request.params;
      const drop = link.drops.find((candidate) => candidate.id === dropId);
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      // Fast path only, not a correctness gate: skips a pointless deleteObject +
      // DB round trip when this request's own snapshot already shows the drop
      // resolved. A drop that reaches this point despite already being terminal
      // (a race that landed between this snapshot and here) is still handled
      // correctly by the CAS below.
      if (TERMINAL_FILE_ENVELOPE_STATUSES.includes(drop.fileEnvelopeStatus as (typeof TERMINAL_FILE_ENVELOPE_STATUSES)[number])) {
        return reply.send({ completed: false });
      }

      // Same order as the DELETE /api/links/:slug route and runCleanup: storage
      // first, DB after. If deleteObject throws, fileEnvelopeStatus is never
      // touched, so the row still names a real (never-deleted) object and a
      // retry is safe. deleteObject succeeds even when the key is already gone
      // (lib/storage.ts), so calling it here — even for a request that goes on
      // to lose the CAS below to a concurrent winner — is harmless.
      await deleteObject(drop.s3Key);

      // The actual compare-and-swap, and the only thing the response below is
      // driven by: only a drop whose fileEnvelopeStatus is not already terminal
      // transitions here. This can't be decided from the `drop` snapshot fetched
      // above — the await on deleteObject is exactly the kind of gap where a
      // concurrent call could already have resolved this drop (see Task 10's
      // reveal-message CAS, and its fix for a stale-snapshot response bug, for
      // why this must be the count, not the snapshot).
      const { count } = await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id, fileEnvelopeStatus: { notIn: [...TERMINAL_FILE_ENVELOPE_STATUSES] } },
        data: { fileEnvelopeStatus: "delivered", contentDeletedAt: new Date() },
      });
      if (count !== 1) {
        // Lost the race to a concurrent complete-download (or a repeat call this
        // request's own fast path above didn't catch). The object is gone either
        // way — deleteObject above is idempotent, and the winner deleted it if
        // this call didn't — so this is not an error, just not this call's win.
        return reply.send({ completed: false });
      }

      // Derive the overall deliveryStatus from both envelope statuses (design
      // spec's partial_delivery/delivered derivation — owned by this plan's
      // endpoints per the design spec's note that plan 1/2 write these fields
      // even though spec 2 owns the full read side). Only the call that actually
      // won the CAS above runs this.
      const messageDone = drop.messageEnvelopeStatus === "delivered" || drop.encryptedMessage === null;
      await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id },
        data: { deliveryStatus: messageDone ? "delivered" : "partial_delivery" },
      });

      return reply.send({ completed: true });
    }
  );

  // Fire-and-forget failure signal from the client (hash mismatch, network
  // failure mid-download, decryption failure, etc.) — never deletes anything;
  // complete-download above is the only route in this file that touches
  // storage. Scoping to this link+dropId is the only gate needed beyond the
  // CAS: drop ids are not secret (GET /api/links/:slug returns them), and
  // marking a drop "delivery_failed" is purely informational bookkeeping.
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/download-failed",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      // Same ownership rule as download-url/complete-download: only the owner
      // may report a failure on an owned link's drop; anonymous links stay open
      // to any link holder.
      if (link.ownerId && link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const { dropId } = request.params;
      // The WHERE clause below is the compare-and-swap — not a pre-fetched
      // snapshot check — so a concurrent complete-download that has already (or
      // is concurrently) resolved this drop to "delivered"/"shredded" can never
      // be clobbered back to "delivery_failed" by a download-failed call that
      // started before it landed. Overwriting a "sealed" or "delivery_failed"
      // row is fine either way (idempotent, and lets a client retry after a
      // previously reported failure).
      await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id, fileEnvelopeStatus: { notIn: [...TERMINAL_FILE_ENVELOPE_STATUSES] } },
        data: { fileEnvelopeStatus: "delivery_failed" },
      });
      return reply.send({ ok: true });
    }
  );

  // Design spec §6.2: a one-time reveal. The atomic UPDATE ... WHERE below is the only place a
  // message can be revealed — it returns the ciphertext AND scrubs the columns in the same
  // statement, so a second call (or two racing calls) sees encryptedMessage already NULL and
  // matches zero rows, never returning the same message twice or losing it to a lost race.
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/reveal-message",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      const { dropId } = request.params;

      const drop = link.drops.find((candidate) => candidate.id === dropId);
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      if (drop.encryptedMessage === null) {
        // Two ways to already be null: this drop never had a message (messageRevealedAt is
        // also null), or a previous call already revealed and scrubbed it. Distinguish so a
        // repeat call reports 409 (conflict with prior reveal), not a misleading 404 — the
        // CAS below still owns the *first* call's race resolution; this is only a fast path
        // for the (non-concurrent) common case where this request's own snapshot is already
        // stale relative to a completed reveal.
        return reply
          .status(drop.messageRevealedAt ? 409 : 404)
          .send({ error: drop.messageRevealedAt ? "Message already revealed" : "This drop has no message" });
      }

      // Snapshot the ciphertext BEFORE the CAS clears it — updateMany doesn't return row data.
      const { encryptedMessage, messageNonce } = drop;
      const { count } = await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id, encryptedMessage: { not: null } },
        data: {
          encryptedMessage: null,
          messageNonce: null,
          messageRevealedAt: new Date(),
          messageEnvelopeStatus: "delivered",
        },
      });
      if (count !== 1) {
        // Lost the race to a concurrent reveal call, or the message was already gone.
        return reply.status(409).send({ error: "Message already revealed" });
      }

      const body: RevealMessageResponse = { encryptedMessage, messageNonce: messageNonce! };
      return reply.send(body);
    }
  );
}
