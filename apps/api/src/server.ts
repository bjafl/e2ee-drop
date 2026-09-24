// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => ({ status: "ok" }));

  return server;
}
