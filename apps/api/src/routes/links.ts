// apps/api/src/routes/links.ts
import type { FastifyInstance } from "fastify";
import type { CreateLinkRequest, CreateLinkResponse } from "@e2ee-drop/shared";
import {
  createOneTimeLink,
  deleteLinkIfExists,
  getLinkBySlug,
  isLinkExpired,
  toLinkStatusResponse,
} from "../lib/links";
import { deleteObject } from "../lib/storage";
import { resolveLocale, deriveCodewords, CODEWORD_MAX_COUNT } from "../lib/codewords";

export function registerLinkRoutes(server: FastifyInstance): void {
  server.post<{ Body: CreateLinkRequest }>("/api/links", async (request, reply) => {
    const { recipientPublicKey, locale } = request.body;
    if (!recipientPublicKey) {
      return reply.status(400).send({ error: "Missing recipientPublicKey" });
    }
    const link = await createOneTimeLink(recipientPublicKey, locale);
    // One-time links always have an expiry (createOneTimeLink sets it); only
    // permanent links, which this route doesn't create, have a null expiresAt.
    if (!link.expiresAt) throw new Error("one-time link created without expiresAt");
    const body: CreateLinkResponse = {
      linkId: link.id,
      slug: link.slug,
      codewords: deriveCodewords(link.recipientPublicKey, resolveLocale(link.codewordLocale), CODEWORD_MAX_COUNT),
      expiresAt: link.expiresAt.getTime(),
    };
    return reply.send(body);
  });

  server.get<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    // Expired links are treated as gone but deliberately NOT deleted here: the
    // cleanup job is the only place that deletes expired links, because it deletes
    // each drop's storage object before the row. Deleting the row lazily here would
    // lose the s3Key and orphan the object in storage forever.
    if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
    return reply.send(toLinkStatusResponse(link));
  });

  server.delete<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    // Same order as runCleanup (jobs/cleanup.ts): storage objects first, then the
    // row. If a storage delete throws, the row (and thus the s3Key) survives, so the
    // delete can be retried or the cleanup job can still find it once expired.
    for (const drop of link.drops) {
      await deleteObject(drop.s3Key);
    }
    await deleteLinkIfExists(link.id);
    return reply.send({ deleted: true });
  });
}
