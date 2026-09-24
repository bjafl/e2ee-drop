// apps/api/src/routes/links.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { CreateLinkRequest, CreateLinkResponse } from "@e2ee-drop/shared";
import {
  createOneTimeLink,
  deleteLinkIfExists,
  getLinkBySlug,
  isLinkExpired,
  toLinkStatusResponse,
} from "../lib/links";
import { resolveLocale, deriveCodewords, CODEWORD_MAX_COUNT } from "../lib/codewords";

export function registerLinkRoutes(server: FastifyInstance): void {
  server.post<{ Body: CreateLinkRequest }>("/api/links", async (request, reply) => {
    const { recipientPublicKey, locale } = request.body;
    if (!recipientPublicKey) {
      return reply.status(400).send({ error: "Missing recipientPublicKey" });
    }
    const link = await createOneTimeLink(recipientPublicKey, locale);
    const body: CreateLinkResponse = {
      linkId: link.id,
      slug: link.slug,
      codewords: deriveCodewords(link.recipientPublicKey, resolveLocale(link.codewordLocale), CODEWORD_MAX_COUNT),
    };
    return reply.send(body);
  });

  server.get<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    if (isLinkExpired(link)) {
      await deleteLinkIfExists(link.id);
      return reply.status(404).send({ error: "Link not found" });
    }
    return reply.send(toLinkStatusResponse(link));
  });

  server.delete<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    await prisma.link.delete({ where: { id: link.id } });
    return reply.send({ deleted: true });
  });
}
