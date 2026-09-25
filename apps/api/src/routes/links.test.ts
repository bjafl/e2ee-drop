// apps/api/src/routes/links.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

const { deleteObjectMock } = vi.hoisted(() => ({ deleteObjectMock: vi.fn() }));

vi.mock("../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/storage")>()),
  deleteObject: deleteObjectMock,
}));

import { buildServer } from "../server";

// The brief this suite was drafted from used a placeholder `x-test-user-id`
// header to fake `request.user` in .inject() calls; that header doesn't exist
// in this codebase's real auth plugin (apps/api/src/plugins/auth.ts) —
// request.user is populated only from a signed SESSION_COOKIE_NAME cookie
// (see apps/api/src/lib/sessions.ts). Per contacts.test.ts's established
// pattern, each authenticated test here registers a REAL user via
// POST /api/auth/register and reuses that user's real session cookie.
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
    publicKey: `${username}-pubkey`,
    cookies: { e2ee_drop_session: cookie.value },
  };
}

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

  it("refuses to delete a registered user's default link by slug (unauthenticated)", async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
    const server = buildServer();
    const register = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "victim@example.com",
        username: "victim",
        name: "Victim",
        authKey: "k",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "cHVia2V5",
      },
    });
    expect(register.statusCode).toBe(200);
    const { defaultLinkSlug } = register.json();
    const link = await prisma.link.findFirstOrThrow({ where: { slug: defaultLinkSlug } });

    const response = await server.inject({ method: "DELETE", url: `/api/links/${defaultLinkSlug}` });

    expect(response.statusCode).toBe(403);
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("includes recipient name and email-verified status for an owned link, and omits them for an anonymous one", async () => {
    const server = buildServer();

    const owner = await prisma.user.create({
      data: {
        email: "owner@example.com",
        emailVerified: true,
        name: "Ada Lovelace",
        username: "ada",
        passwordHash: "x",
        passwordSalt: "x",
        passwordWrappedPrivateKey: "x",
        recoveryWrappedPrivateKey: "x",
        publicKey: "b3duZXJrZXk=",
        storageQuotaBytes: BigInt(1024 * 1024 * 1024), // 1GB
      },
    });
    const ownedLink = await prisma.link.create({
      data: { ownerId: owner.id, slug: "ada", mode: "permanent", recipientPublicKey: owner.publicKey },
    });

    const ownedResponse = await server.inject({ method: "GET", url: `/api/links/${ownedLink.slug}` });
    const ownedBody = ownedResponse.json();
    expect(ownedBody.isAnonymous).toBe(false);
    expect(ownedBody.recipientName).toBe("Ada Lovelace");
    expect(ownedBody.recipientEmailVerified).toBe(true);

    const anonCreate = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "YW5vbg==" },
    });
    const { slug: anonSlug } = anonCreate.json();
    const anonResponse = await server.inject({ method: "GET", url: `/api/links/${anonSlug}` });
    const anonBody = anonResponse.json();
    expect(anonBody.isAnonymous).toBe(true);
    expect(anonBody.recipientName).toBeUndefined();
    expect(anonBody.recipientEmailVerified).toBeUndefined();
  });

  it("creates a custom named link for the authenticated owner", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "customownera");

    const response = await server.inject({
      method: "POST",
      url: "/api/links/custom",
      payload: { slug: "team-drop", mode: "permanent", visibility: "public" },
      cookies: owner.cookies,
    });

    expect(response.statusCode).toBe(200);
    const { slug } = response.json();
    expect(slug).toBe("team-drop");

    const link = await prisma.link.findFirst({ where: { ownerId: owner.userId, slug: "team-drop" } });
    expect(link?.mode).toBe("permanent");
    expect(link?.recipientPublicKey).toBe(owner.publicKey);
  });

  it("rejects a duplicate slug, whether from the same owner or a different one (Link.slug is globally unique)", async () => {
    const server = buildServer();
    const ownerA = await registerAndGetCookie(server, "customownerb");
    const ownerB = await registerAndGetCookie(server, "customownerc");

    const first = await server.inject({
      method: "POST",
      url: "/api/links/custom",
      payload: { slug: "dupe", mode: "permanent" },
      cookies: ownerA.cookies,
    });
    expect(first.statusCode).toBe(200);

    const secondSameOwner = await server.inject({
      method: "POST",
      url: "/api/links/custom",
      payload: { slug: "dupe", mode: "one-time" },
      cookies: ownerA.cookies,
    });
    expect(secondSameOwner.statusCode).toBe(409);

    const thirdDifferentOwner = await server.inject({
      method: "POST",
      url: "/api/links/custom",
      payload: { slug: "dupe", mode: "permanent" },
      cookies: ownerB.cookies,
    });
    expect(thirdDifferentOwner.statusCode).toBe(409);
  });
});
