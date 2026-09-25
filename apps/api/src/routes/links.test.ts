// apps/api/src/routes/links.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

const { deleteObjectMock } = vi.hoisted(() => ({ deleteObjectMock: vi.fn() }));

vi.mock("../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/storage")>()),
  deleteObject: deleteObjectMock,
}));

import { buildServer } from "../server";

async function createLinkWithDrop(slug: string, expiresAt: Date) {
  const link = await prisma.link.create({
    data: { slug, mode: "one-time", recipientPublicKey: "x", expiresAt },
  });
  const drop = await prisma.drop.create({
    data: {
      linkId: link.id,
      senderPublicKey: "c2VuZGVy",
      s3Key: `${link.id}/drop1`,
      nonce: "bm9uY2U=",
      fileName: "report.pdf",
      fileSize: 1024,
      mimeType: "application/pdf",
      contentMD5: "bWQ1",
      status: "uploaded",
    },
  });
  return { link, drop };
}

describe("link routes", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
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

  it("returns the link's actual server-side expiresAt (epoch ms) on create", async () => {
    const server = buildServer();
    const before = Date.now();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50a2V5" },
    });
    const body = createResponse.json();

    const link = await prisma.link.findFirstOrThrow({ where: { slug: body.slug } });
    expect(typeof body.expiresAt).toBe("number");
    expect(body.expiresAt).toBe(link.expiresAt!.getTime());
    expect(body.expiresAt).toBeGreaterThan(before);
  });

  it("returns 404 for an expired link without deleting it (deletion is cleanup's job, so the object isn't orphaned)", async () => {
    const server = buildServer();
    const { link } = await createLinkWithDrop("expired-get-test", new Date(Date.now() - 1000));

    const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });

    expect(response.statusCode).toBe(404);
    // The row (and its drop's s3Key) must survive so runCleanup can still find it
    // and delete the MinIO object before the row.
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
    expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(1);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("deletes the drop's storage object before deleting the link", async () => {
    const server = buildServer();
    const { link, drop } = await createLinkWithDrop("delete-with-drop", new Date(Date.now() + 60_000));

    const response = await server.inject({ method: "DELETE", url: `/api/links/${link.slug}` });

    expect(response.statusCode).toBe(200);
    expect(deleteObjectMock).toHaveBeenCalledWith(drop.s3Key);
    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
  });

  it("keeps the link row if deleting the storage object fails, so it can be retried", async () => {
    const server = buildServer();
    const { link } = await createLinkWithDrop("delete-storage-fails", new Date(Date.now() + 60_000));
    deleteObjectMock.mockRejectedValueOnce(new Error("minio down"));

    const response = await server.inject({ method: "DELETE", url: `/api/links/${link.slug}` });

    expect(response.statusCode).toBe(500);
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
  });
});
