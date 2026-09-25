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

export function buildServer(): FastifyInstance {
  // Trust exactly one hop of X-Forwarded-For, matching this app's shipped
  // deployment topology: nginx (apps/web/nginx.conf) as the sole reverse
  // proxy directly facing clients, forwarding to this API. Without this,
  // request.ip (used by the /api/auth/login rate limiter — see
  // lib/rateLimit.ts) would always resolve to nginx's own container
  // address, collapsing every client behind it into a single rate-limit
  // bucket. `trustProxy: true` (trust all hops) is deliberately NOT used
  // here: with no hop limit, Fastify would trust the leftmost address in a
  // client-supplied X-Forwarded-For header, letting a caller spoof its own
  // IP and dodge the limit entirely. A numeric `trustProxy: 1` would
  // express "trust exactly one hop" directly, but this Fastify version's
  // TS types don't accept a number here (only boolean | string | string[]
  // | TrustProxyFunction) even though the underlying proxy-addr dependency
  // supports it at runtime — so the same semantics are expressed as a
  // TrustProxyFunction: `hop === 0` is the immediate, socket-connecting
  // peer (nginx), which is trusted; anything further left in the chain
  // (hop >= 1) is not, so Fastify stops there and uses that address as the
  // resolved request.ip.
  const server = Fastify({ logger: true, trustProxy: (_address: string, hop: number) => hop === 0 });

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
