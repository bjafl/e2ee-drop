// apps/api/src/routes/links.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { registerLinkRoutes } from "./links";

describe("link routes", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("creates a one-time link and can fetch it by slug", async () => {
    const server = buildServer();

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50a2V5" },
    });
    expect(createResponse.statusCode).toBe(200);
    const { slug } = createResponse.json();
    expect(slug).toBeTruthy();

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(getResponse.statusCode).toBe(200);
    const body = getResponse.json();
    expect(body.recipientPublicKey).toBe("cmVjaXBpZW50a2V5");
    expect(body.isAnonymous).toBe(true);
    expect(body.drop).toBeNull();
  });

  it("returns 404 for an unknown slug", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/links/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });

  it("deletes a link", async () => {
    const server = buildServer();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50a2V5" },
    });
    const { slug } = createResponse.json();

    const deleteResponse = await server.inject({ method: "DELETE", url: `/api/links/${slug}` });
    expect(deleteResponse.statusCode).toBe(200);

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(getResponse.statusCode).toBe(404);
  });

  it("returns a codewords phrase on create and on the link status response", async () => {
    const server = buildServer();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50a2V5", locale: "nb" },
    });
    const createBody = createResponse.json();
    expect(Array.isArray(createBody.codewords)).toBe(true);
    expect(createBody.codewords.length).toBeGreaterThan(0);

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${createBody.slug}` });
    const body = getResponse.json();

    expect(body.codewords).toEqual(createBody.codewords);
  });
});
