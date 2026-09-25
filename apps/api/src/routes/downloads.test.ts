// apps/api/src/routes/downloads.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { subscribeToLink, type DropEvent } from "../lib/dropEvents";

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

  it("allows re-issuing a download url after the drop has already been marked downloaded", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, "uploaded");

    await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/downloaded`,
    });

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(200);
    // The download-url route must not regress the "downloaded" status back to
    // "downloading" on this re-issuance (see the conditional-update comment in
    // downloads.ts).
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("downloaded");
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
    // Deletion is cleanup's job: deleting the row here would lose the drop's s3Key
    // and orphan the uploaded object in storage forever.
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
    expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(1);
  });

  it("returns 404 when marking a drop downloaded via a link it does not belong to", async () => {
    const server = buildServer();
    const { dropId } = await createLinkWithDrop(server, "uploaded");
    const otherRes = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50" },
    });
    const otherSlug = otherRes.json().slug;

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${otherSlug}/drops/${dropId}/downloaded`,
    });

    expect(response.statusCode).toBe(404);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("uploaded");
  });

  it("returns 404 when marking a still-uploading drop as downloaded (can't defeat the not-ready check)", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, "uploading");

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/downloaded`,
    });

    expect(response.statusCode).toBe(404);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("uploading");
    const downloadUrl = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    expect(downloadUrl.statusCode).toBe(403);
  });

  it("marks an uploaded (not yet downloading) drop as downloaded", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, "uploaded");

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/downloaded`,
    });

    expect(response.statusCode).toBe(200);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("downloaded");
  });

  it("returns 404 when marking an already-downloaded drop as downloaded again", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, "uploaded");
    const url = `/api/links/${slug}/drops/${dropId}/downloaded`;

    const first = await server.inject({ method: "POST", url });
    const second = await server.inject({ method: "POST", url });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
  });
});

// Owned-link access control and queue selection (Plan 3 Task 7). Authenticated
// requests use a REAL registered user's session cookie (see links.test.ts /
// contacts.test.ts for the established pattern) — there is no fake
// user-id header in this codebase's auth plugin.
async function registerAndGetCookie(server: ReturnType<typeof buildServer>, username: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `${username}@example.com`,
      username,
      name: username,
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: `${username}-pubkey`,
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return {
    userId: response.json().userId as string,
    cookies: { e2ee_drop_session: cookie.value },
  };
}

async function createQueuedDrop(linkId: string, fileName: string, status = "uploaded") {
  return prisma.drop.create({
    data: {
      linkId,
      senderPublicKey: "c2VuZGVy",
      s3Key: `${linkId}/${fileName}`,
      nonce: "bm9uY2U=",
      fileName,
      fileSize: 1,
      mimeType: "text/plain",
      contentMD5: "bWQ1",
      status,
    },
  });
}

// Registration creates the owner's default permanent link with slug === username.
async function ownedLinkWithQueue(server: ReturnType<typeof buildServer>, username: string) {
  const owner = await registerAndGetCookie(server, username);
  const link = (await prisma.link.findUnique({ where: { slug: username } }))!;
  const first = await createQueuedDrop(link.id, "first.txt");
  const second = await createQueuedDrop(link.id, "second.txt");
  return { owner, link, first, second };
}

describe("owned-link download routes", () => {
  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("rejects an unauthenticated download-url request for an owned link", async () => {
    const server = buildServer();
    const { link } = await ownedLinkWithQueue(server, "dlowner");

    const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}/download-url` });

    expect(response.statusCode).toBe(403);
  });

  it("rejects another authenticated user even with a correct dropId, without touching drop status", async () => {
    const server = buildServer();
    const { link, second } = await ownedLinkWithQueue(server, "dlowner");
    const intruder = await registerAndGetCookie(server, "intruder");

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/download-url?dropId=${second.id}`,
      cookies: intruder.cookies,
    });

    expect(response.statusCode).toBe(403);
    expect((await prisma.drop.findUnique({ where: { id: second.id } }))?.status).toBe("uploaded");
  });

  it("selects the drop matching an explicit dropId out of a queue, leaving other queued drops untouched", async () => {
    const server = buildServer();
    const { owner, link, first, second } = await ownedLinkWithQueue(server, "dlowner");

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/download-url?dropId=${second.id}`,
      cookies: owner.cookies,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().fileName).toBe("second.txt");
    expect((await prisma.drop.findUnique({ where: { id: second.id } }))?.status).toBe("downloading");
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.status).toBe("uploaded");
  });

  it("returns 404 for a dropId that does not belong to the requested link", async () => {
    const server = buildServer();
    const { owner, link } = await ownedLinkWithQueue(server, "dlowner");
    const other = await ownedLinkWithQueue(server, "otherowner");

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/download-url?dropId=${other.first.id}`,
      cookies: owner.cookies,
    });

    expect(response.statusCode).toBe(404);
    expect((await prisma.drop.findUnique({ where: { id: other.first.id } }))?.status).toBe("uploaded");
  });

  it("rejects a non-owner marking an owned link's drop as downloaded", async () => {
    const server = buildServer();
    const { link, first } = await ownedLinkWithQueue(server, "dlowner");
    const intruder = await registerAndGetCookie(server, "intruder");
    const url = `/api/links/${link.slug}/drops/${first.id}/downloaded`;

    const anonymous = await server.inject({ method: "POST", url });
    const otherUser = await server.inject({ method: "POST", url, cookies: intruder.cookies });

    expect(anonymous.statusCode).toBe(403);
    expect(otherUser.statusCode).toBe(403);
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.status).toBe("uploaded");
  });

  it("lets the owner mark one queued drop downloaded without affecting the others", async () => {
    const server = buildServer();
    const { owner, link, first, second } = await ownedLinkWithQueue(server, "dlowner");

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${first.id}/downloaded`,
      cookies: owner.cookies,
    });

    expect(response.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.status).toBe("downloaded");
    expect((await prisma.drop.findUnique({ where: { id: second.id } }))?.status).toBe("uploaded");
  });
});

describe("download route drop events", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("emits drop-updated(downloading) only when download-url actually wins the uploaded->downloading CAS", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, "uploaded");
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

    await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    // Re-issuance: the CAS matches no row (already "downloading"), so no second event.
    await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/downloaded` });
    unsubscribe();

    expect(events.map((e) => [e.type, e.drop.id, e.drop.status])).toEqual([
      ["drop-updated", dropId, "downloading"],
      ["drop-updated", dropId, "downloaded"],
    ]);
  });
});
