// apps/api/src/routes/events.ts
import type { FastifyInstance } from "fastify";
import { canReceive, getLinkBySlug, isLinkExpired } from "../lib/links";
import { subscribeToLink } from "../lib/dropEvents";

// A comment line written periodically so a reverse proxy never sees the stream
// idle long enough to time it out (nginx's proxy_read_timeout defaults to 60s,
// and was observed dropping an idle stream at exactly that point). EventSource
// ignores comment lines, so clients never see these.
export const SSE_HEARTBEAT_INTERVAL_MS = 25_000;

export function registerEventRoutes(server: FastifyInstance): void {
  server.get<{ Params: { slug: string } }>("/api/links/:slug/events", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
    // Anonymous (ownerless) links stay open to any link holder, exactly like
    // Plan 1's other link routes. `request.user` is set on every request
    // (null when there's no valid session) by the global onRequest hook in
    // plugins/auth.ts, so a missing session can never equal a real ownerId.
    //
    // Two callers may subscribe to an owned link: the true owner (a normal
    // owned link's recipient, or a request link's initiator/sender — the
    // initiator needs this to detect the link-claimed event over this same
    // channel, per POST /api/links/:slug/claim), and anyone canReceive says
    // may receive (covers an anonymous link, already true above, and a
    // claimed sender-initiated link's real claimant, who is never
    // link.ownerId and so was previously always 403'd here — see
    // docs/STATUS.md gap 1). canReceive itself denies a normal owned link's
    // non-owner and a claimed request link's own initiator, so neither of
    // those gets a new hole through this second check.
    const isOwner = request.user?.id != null && request.user.id === link.ownerId;
    if (!isOwner && !(await canReceive(link, request.user?.id))) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    reply.hijack(); // take over the response so Fastify doesn't also try to send one
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Tells nginx (and compatible proxies) not to buffer this response, so
      // each event reaches the browser as soon as it's written.
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = subscribeToLink(link.id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, SSE_HEARTBEAT_INTERVAL_MS);

    // The response's "close" fires when the client disconnects (or the
    // server shuts down); each connection removes only its own listener and
    // stops only its own heartbeat.
    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
