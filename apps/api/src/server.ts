// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import authPlugin from "./plugins/auth";
import { registerLinkRoutes } from "./routes/links";
import { registerUploadRoutes } from "./routes/uploads";
import { registerDownloadRoutes } from "./routes/downloads";
import { env } from "./env";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.register(cookie, { secret: env.SESSION_SECRET });
  // Called directly (not server.register(authPlugin)) so server.requireAuth
  // exists synchronously before the route registrations below run — see the
  // comment atop plugins/auth.ts for why .register() would leave it
  // undefined at this point and silently disable auth on every protected
  // route registered in this function (and in every later task's
  // registerXRoutes(server), which follows the same synchronous pattern).
  authPlugin(server);

  server.get("/api/health", async () => ({ status: "ok" }));
  registerLinkRoutes(server);
  registerUploadRoutes(server);
  registerDownloadRoutes(server);

  return server;
}
