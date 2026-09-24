// apps/api/src/routes/uploads.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

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
});
