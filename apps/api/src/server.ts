// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import { registerLinkRoutes } from "./routes/links";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => ({ status: "ok" }));
  registerLinkRoutes(server);

  return server;
}
