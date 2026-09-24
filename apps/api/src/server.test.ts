// apps/api/src/server.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "./server";

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
