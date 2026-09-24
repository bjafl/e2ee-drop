// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import { registerLinkRoutes } from "./routes/links";
import { registerUploadRoutes } from "./routes/uploads";
import { registerDownloadRoutes } from "./routes/downloads";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => ({ status: "ok" }));
  registerLinkRoutes(server);
  registerUploadRoutes(server);
  registerDownloadRoutes(server);

  return server;
}
