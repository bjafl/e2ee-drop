// apps/api/src/routes/uploads.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

const { getSignedUploadUrlSpy } = vi.hoisted(() => ({ getSignedUploadUrlSpy: vi.fn() }));

vi.mock("../lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/storage")>();
  getSignedUploadUrlSpy.mockImplementation(original.getSignedUploadUrl);
  return { ...original, getSignedUploadUrl: getSignedUploadUrlSpy };
});

import { buildServer } from "../server";

const validMetadata = {
  fileName: "report.pdf",
  fileSize: 1024,
  nonce: "bm9uY2U=",
  mimeType: "application/pdf",
  contentMD5: "bWQ1",
};

async function createLink(server: ReturnType<typeof buildServer>) {
  const res = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "cmVjaXBpZW50" },
  });
  return res.json().slug as string;
}

describe("upload routes", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("issues an upload url and creates a drop for a fresh link", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dropId).toBeTruthy();
    expect(body.uploadUrl).toContain("http");
  });

  it("signs the upload url for exactly the NaCl box ciphertext length (fileSize + 16)", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    getSignedUploadUrlSpy.mockClear();

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });

    expect(response.statusCode).toBe(200);
    expect(getSignedUploadUrlSpy).toHaveBeenCalledTimes(1);
    expect(getSignedUploadUrlSpy.mock.calls[0][1]).toBe(validMetadata.fileSize + 16);
  });

  it.each([
    ["a numeric string", "1024"],
    ["a fraction", 10.5],
    ["a negative number", -5],
  ])("rejects a fileSize that is %s with 400 (it's used to sign the upload's content-length)", async (_label, fileSize) => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: { ...validMetadata, fileSize } },
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.drop.count({ where: { link: { slug } } })).toBe(0);
  });

  it("rejects a file larger than MAX_FILE_SIZE_BYTES with 413", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: {
        senderPublicKey: "c2VuZGVy",
        metadata: { ...validMetadata, fileSize: 999_999_999_999 },
      },
    });

    expect(response.statusCode).toBe(413);
  });

  it("rejects a second upload-url request once a drop already exists", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const first = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVyMg==", metadata: validMetadata },
    });
    expect(second.statusCode).toBe(409);

    const drops = await prisma.drop.findMany({ where: { link: { slug } } });
    expect(drops).toHaveLength(1);
  });

  it("allows only one of two concurrent upload-url requests on the same link to succeed", async () => {
    // server.inject() simulates requests in-process and does not reliably interleave two
    // concurrent calls (Fastify/light-my-request tends to resolve one fully before the next
    // handler body even starts, which would pass even against the old, unguarded code without
    // proving anything). Listen on a real socket and fire genuine concurrent HTTP requests so
    // both handlers' DB round-trips actually overlap and exercise the real race.
    const server = buildServer();
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const slug = await createLink(server);

      const fire = () =>
        fetch(`${baseUrl}/api/links/${slug}/upload-url`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ senderPublicKey: "c2VuZGVy", metadata: validMetadata }),
        });

      // Fire many concurrent requests, not just two: with only two racers, one request's
      // full round trip (read + insert + sign) can complete before the other's read even
      // returns, which "accidentally" avoids the race without proving anything was fixed.
      // A wider burst makes it overwhelmingly likely that at least two reads land inside
      // the same open window, so this reliably exercises the actual race.
      const CONCURRENT_REQUESTS = 12;
      const responses = await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, fire));
      const statusCodes = responses.map((r) => r.status);
      const successes = statusCodes.filter((s) => s === 200);
      const conflicts = statusCodes.filter((s) => s === 409);
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(CONCURRENT_REQUESTS - 1);

      const drops = await prisma.drop.findMany({ where: { link: { slug } } });
      expect(drops).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("rejects an empty body with 400 instead of crashing", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
    });

    expect(response.statusCode).toBe(400);

    const drops = await prisma.drop.findMany({ where: { link: { slug } } });
    expect(drops).toHaveLength(0);
  });

  it("rejects a present-but-incomplete body with 400 (missing required metadata field)", async () => {
    // Distinct from the empty-body case above: request.body is present here, so this
    // must fall through the `!request.body` guard and land on the actual field-by-field
    // validation (`!senderPublicKey || !metadata?.fileName || ...`), not just prove the
    // guard exists.
    const server = buildServer();
    const slug = await createLink(server);

    const { nonce: _omittedNonce, ...metadataWithoutNonce } = validMetadata;

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: metadataWithoutNonce },
    });

    expect(response.statusCode).toBe(400);

    const drops = await prisma.drop.findMany({ where: { link: { slug } } });
    expect(drops).toHaveLength(0);
  });

  it("returns 404 for an expired link", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-upload-test",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });

    expect(response.statusCode).toBe(404);
    // Deletion is cleanup's job: deleting the row here would lose the s3Key and
    // orphan any storage object belonging to the link.
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
  });

  it("truncates a message longer than 500 characters and strips control characters", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    const longMessage = "a".repeat(600) + "\x00\x1F";

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", message: longMessage, metadata: validMetadata },
    });

    expect(response.statusCode).toBe(200);
    const drop = await prisma.drop.findFirst({ where: { link: { slug } } });
    expect(drop?.message).toHaveLength(500);
    expect(drop?.message).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it("marks a drop as uploaded via the complete endpoint", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    const uploadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });
    const { dropId } = uploadRes.json();

    const completeRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete`,
    });
    expect(completeRes.statusCode).toBe(200);

    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("uploaded");
  });

  async function createLinkWithUploadingDrop(server: ReturnType<typeof buildServer>) {
    const slug = await createLink(server);
    const uploadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });
    return { slug, dropId: uploadRes.json().dropId as string };
  }

  it("returns 404 when completing a drop via a link it does not belong to", async () => {
    const server = buildServer();
    const { dropId } = await createLinkWithUploadingDrop(server);
    const otherSlug = await createLink(server);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${otherSlug}/drops/${dropId}/complete`,
    });

    expect(res.statusCode).toBe(404);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("uploading");
  });

  it("returns 404 when completing a drop that is not in the uploading state", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    const first = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
    expect(second.statusCode).toBe(404);
  });

  it("does not regress a downloaded drop back to uploaded on a late complete call", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    await prisma.drop.update({ where: { id: dropId }, data: { status: "downloaded" } });

    const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });

    expect(res.statusCode).toBe(404);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("downloaded");
  });

  it("returns 404 when completing a drop on an expired link", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    await prisma.link.updateMany({ where: { slug }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });

    expect(res.statusCode).toBe(404);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("uploading");
  });
});
