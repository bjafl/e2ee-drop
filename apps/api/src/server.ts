// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import authPlugin from "./plugins/auth";
import { registerAuthRoutes } from "./routes/auth";
import { registerPasswordResetRoutes } from "./routes/passwordReset";
import { registerLinkRoutes } from "./routes/links";
import { registerUploadRoutes } from "./routes/uploads";
import { registerDownloadRoutes } from "./routes/downloads";
import { registerTwoFactorRoutes } from "./routes/twoFactor";
import { registerContactRoutes } from "./routes/contacts";
import { registerEventRoutes } from "./routes/events";
import { registerAccountRoutes } from "./routes/account";
import { env } from "./env";
import { createTrustProxyFn } from "./lib/trustProxy";
import { errorHandler } from "./lib/httpErrors";

export interface BuildServerOptions {
  /** Overrides env.TRUST_PROXY_HOPS (used by tests). */
  trustProxyHops?: number;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  // Trust exactly TRUST_PROXY_HOPS reverse-proxy hops of X-Forwarded-For
  // (default 1: the shipped apps/web/nginx.conf proxy talking directly to
  // this API). request.ip is used as the /api/auth/login rate-limit key
  // (lib/rateLimit.ts), so it must be the real client's address. Trusting
  // too few hops collapses every client into one proxy's address (one shared
  // bucket, so one attacker can lock everyone out of login). Trusting too
  // many lets clients spoof their IP. An operator who puts their own reverse
  // proxy in front of the `web` container (README "Fronting with TLS") must
  // set TRUST_PROXY_HOPS=2. See lib/trustProxy.ts for how hops are counted.
  //
  // `trustProxy: true` (trust all hops) is deliberately NOT used: Fastify
  // would then take the leftmost, client-supplied X-Forwarded-For entry,
  // letting a caller spoof its IP and dodge the limit.
  //
  // Do NOT "simplify" this to a numeric `trustProxy: N`. Besides not being
  // in Fastify's TS types (boolean | string | string[] | TrustProxyFunction),
  // Fastify 5.12.5 deliberately fails CLOSED on a number at runtime
  // (lib/request.js getTrustProxyFn returns `() => false`, because a bare hop
  // count can't validate the immediate peer). That would silently disable all
  // proxy trust, making request.ip always nginx's address and collapsing
  // every client into one bucket again.
  //
  // The function form trusts hop 0 (the socket peer) unconditionally, which
  // is only safe because the API is never directly reachable by untrusted
  // clients: docker-compose.yml publishes no ports for the `api` service, so
  // only the `web` container's nginx can connect to it. Never publish the
  // API's port or expose it to clients directly, or anyone could set
  // X-Forwarded-For freely.
  const server = Fastify({
    logger: true,
    trustProxy: createTrustProxyFn(options.trustProxyHops ?? env.TRUST_PROXY_HOPS),
  });

  // Thrown, unhandled errors must never leak their message/stack to the
  // client (Fastify's default handler sends error.message, which for Prisma
  // errors includes file paths, query snippets and argument dumps). See
  // lib/httpErrors.ts for what is and isn't passed through.
  server.setErrorHandler(errorHandler);

  // Must be registered before authPlugin(server): the auth plugin's
  // onRequest hook reads request.cookies (populated by this plugin's own
  // deferred hook). Both hooks are installed through Fastify's boot queue
  // in call order, so if this line moved after authPlugin(server), the auth
  // hook's cookie-reading hook would run before request.cookies has been
  // set up — request.cookies would be null and every request would 500.
  server.register(cookie, { secret: env.SESSION_SECRET });
  // Called directly (not server.register(authPlugin)) so server.requireAuth
  // exists synchronously before the route registrations below run — see the
  // comment atop plugins/auth.ts for why .register() would leave it
  // undefined at this point and silently disable auth on every protected
  // route registered in this function (and in every later task's
  // registerXRoutes(server), which follows the same synchronous pattern).
  authPlugin(server);

  server.get("/api/health", async () => ({ status: "ok" }));
  registerAuthRoutes(server);
  registerPasswordResetRoutes(server);
  registerLinkRoutes(server);
  registerUploadRoutes(server);
  registerDownloadRoutes(server);
  registerTwoFactorRoutes(server);
  registerContactRoutes(server);
  registerEventRoutes(server);
  registerAccountRoutes(server);

  return server;
}
