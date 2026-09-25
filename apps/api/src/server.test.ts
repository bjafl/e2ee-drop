// apps/api/src/server.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "./server";
import { HttpError } from "./lib/httpErrors";

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("global error handler", () => {
  function serverWithTestRoutes() {
    const server = buildServer();
    server.get("/__test/unexpected", async () => {
      const error = new Error(
        "Invalid `tx.user.create()` invocation in /home/app/src/routes/auth.ts:170:21 authKeyHash: '$argon2id$v=19$secret'"
      );
      (error as Error & { code: string }).code = "P2009";
      throw error;
    });
    server.get("/__test/unexpected-with-status", async () => {
      // A non-HttpError that happens to carry a statusCode must not get its
      // message passed through either.
      throw Object.assign(new Error("internal detail: /var/lib/secret"), { statusCode: 403 });
    });
    server.get("/__test/intended", async () => {
      throw new HttpError(409, "Intended client-facing message");
    });
    server.post("/__test/echo", async (request) => request.body);
    return server;
  }

  it("returns a generic 500 with no internal detail for an unexpected error", async () => {
    const server = serverWithTestRoutes();
    const response = await server.inject({ method: "GET", url: "/__test/unexpected" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    expect(response.body).not.toMatch(/invocation|\/home\/|argon2|P2009|stack/i);
  });

  it("generalizes an untagged error even if it carries a statusCode", async () => {
    const server = serverWithTestRoutes();
    const response = await server.inject({ method: "GET", url: "/__test/unexpected-with-status" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
  });

  it("passes through an intentional HttpError's status and message", async () => {
    const server = serverWithTestRoutes();
    const response = await server.inject({ method: "GET", url: "/__test/intended" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Intended client-facing message" });
  });

  it("keeps Fastify's 4xx status for a malformed JSON body but uses a generic reason phrase", async () => {
    const server = serverWithTestRoutes();
    const response = await server.inject({
      method: "POST",
      url: "/__test/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Bad Request" });
  });
});
