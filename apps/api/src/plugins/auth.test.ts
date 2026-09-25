// apps/api/src/plugins/auth.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../server";

describe("auth plugin", () => {
  it("leaves request.user null and 403s protected routes with no cookie", async () => {
    const server = buildServer();
    server.get("/__test/protected", { preHandler: server.requireAuth }, async () => ({ ok: true }));

    const response = await server.inject({ method: "GET", url: "/__test/protected" });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a garbage/unsigned cookie value the same as no cookie", async () => {
    const server = buildServer();
    server.get("/__test/protected", { preHandler: server.requireAuth }, async () => ({ ok: true }));

    const response = await server.inject({
      method: "GET",
      url: "/__test/protected",
      cookies: { e2ee_drop_session: "not-a-real-signed-value" },
    });
    expect(response.statusCode).toBe(403);
  });
});
