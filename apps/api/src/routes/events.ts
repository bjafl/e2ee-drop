// apps/api/src/routes/events.ts
import type { FastifyInstance } from "fastify";
import { getLinkBySlug, isLinkExpired } from "../lib/links";
import { subscribeToLink } from "../lib/dropEvents";

export function registerEventRoutes(server: FastifyInstance): void {
  server.get<{ Params: { slug: string } }>("/api/links/:slug/events", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
    // Anonymous (ownerless) links stay open to any link holder, exactly like
    // Plan 1's other link routes. Owned links: owner only. `request.user` is
    // set on every request (null when there's no valid session) by the global
    // onRequest hook in plugins/auth.ts, so a missing session can never
    // equal a real ownerId.
    if (link.ownerId && link.ownerId !== request.user?.id) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    reply.hijack(); // take over the response so Fastify doesn't also try to send one
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = subscribeToLink(link.id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // The response's "close" fires when the client disconnects (or the
    // server shuts down); each connection removes only its own listener.
    reply.raw.on("close", () => {
      unsubscribe();
    });
  });
}
