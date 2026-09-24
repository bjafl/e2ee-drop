// apps/api/src/routes/downloads.test.ts
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

async function createLinkWithDrop(
  server: ReturnType<typeof buildServer>,
  dropStatus: "uploading" | "uploaded"
) {
  const createRes = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "cmVjaXBpZW50" },
  });
  const { slug } = createRes.json();

  const uploadRes = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
  });
  const { dropId } = uploadRes.json();

  if (dropStatus === "uploaded") {
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
  }

  return { slug, dropId };
}

describe("download routes", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("issues a download url once the drop is uploaded", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server, "uploaded");

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.downloadUrl).toContain("http");
    expect(body.fileName).toBe("report.pdf");
  });

  it("allows re-issuing a download url on retry (e.g. after a dropped connection)", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server, "uploaded");

    const first = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    const second = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().downloadUrl).toContain("http");
  });

  it("rejects a download-url request while the drop is still uploading", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server, "uploading");

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(403);
  });

  it("returns 404 when the link has no drop at all", async () => {
    const server = buildServer();
    const createRes = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50" },
    });
    const { slug } = createRes.json();

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(404);
  });

  it("marks a drop as downloaded via the downloaded endpoint", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, "uploaded");

    await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/downloaded`,
    });

    expect(response.statusCode).toBe(200);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("downloaded");
  });

  it("returns 404 for a nonexistent slug on the download-url route", async () => {
    const server = buildServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/links/does-not-exist/download-url",
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when marking a nonexistent drop as downloaded", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server, "uploaded");

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/does-not-exist/downloaded`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an expired link even if a drop was uploaded before it expired", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-download-test",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/drop1`,
        nonce: validMetadata.nonce,
        fileName: validMetadata.fileName,
        fileSize: validMetadata.fileSize,
        mimeType: validMetadata.mimeType,
        contentMD5: validMetadata.contentMD5,
        status: "uploaded",
      },
    });

    const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}/download-url` });

    expect(response.statusCode).toBe(404);
  });
});
