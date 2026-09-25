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
import { env } from "./env";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

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

  return server;
}
