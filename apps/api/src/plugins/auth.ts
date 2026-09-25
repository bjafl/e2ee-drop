// apps/api/src/plugins/auth.ts
//
// Deliberately NOT registered via `server.register()`. Fastify defers the
// body of a `.register()`-ed plugin to its async boot queue (avvio) — it
// does not run synchronously within the same tick as the `.register()`
// call. `buildServer()` (server.ts) calls route-registration functions
// like `registerLinkRoutes(server)` synchronously, in the same tick, and
// every later task's `registerXRoutes(server)` follows the same pattern
// with routes like `server.get(url, { preHandler: server.requireAuth }, ...)`.
// That `{ preHandler: server.requireAuth }` object literal reads
// `server.requireAuth` immediately, at route-definition time. If this
// plugin were registered the usual way (`server.register(authPlugin)`),
// `server.requireAuth` would still be `undefined` at that point (confirmed
// empirically: `hasDecorator("requireAuth")` is `false` immediately after
// `server.register()`, `true` only after `await server.ready()`), so every
// downstream protected route would silently run with NO preHandler at all
// — Fastify treats an undefined preHandler as "none", not an error — i.e.
// auth would be silently bypassed rather than loudly broken.
//
// Calling this function directly against the root server instance runs
// decorateRequest/addHook/decorate synchronously, so `server.requireAuth`
// exists immediately, before any subsequent route registration in the same
// buildServer() call. No encapsulation boundary needs to be crossed (unlike
// a plugin nested via `.register()`), so `fastify-plugin`'s
// encapsulation-skipping wrapper isn't needed here either.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getUserIdFromSession } from "../lib/sessions";

export const SESSION_COOKIE_NAME = "e2ee_drop_session";

export interface AuthenticatedUser {
  id: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default function authPlugin(server: FastifyInstance): void {
  server.decorateRequest("user", null);

  server.addHook("onRequest", async (request) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (!raw) {
      request.user = null;
      return;
    }
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      request.user = null;
      return;
    }
    const userId = await getUserIdFromSession(unsigned.value);
    request.user = userId ? { id: userId } : null;
  });

  server.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      reply.status(403).send({ error: "Authentication required" });
    }
  });
}
