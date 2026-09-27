// apps/api/src/routes/inbox.ts
import type { FastifyInstance } from "fastify";
import type { InboxResponse } from "@e2ee-drop/shared";
import { getInboxForUser } from "../lib/inbox";
import { subscribeToOwner } from "../lib/dropEvents";
import { SSE_HEARTBEAT_INTERVAL_MS } from "./events";

export function registerInboxRoutes(server: FastifyInstance): void {
  server.get("/api/inbox", { preHandler: server.requireAuth }, async (request, reply) => {
    const body: InboxResponse = await getInboxForUser(request.user!.id);
    return reply.send(body);
  });

  server.get("/api/inbox/events", { preHandler: server.requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;

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

    const unsubscribe = subscribeToOwner(ownerId, (event) => {
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
