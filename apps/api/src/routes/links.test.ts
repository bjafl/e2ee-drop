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

  it("lists queued drops for the owner, oldest first, excluding downloaded ones", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "queueowner");

    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId,
        slug: "queue-test",
        mode: "permanent",
        recipientPublicKey: owner.publicKey,
      },
    });
    const older = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "a",
        s3Key: "k1",
        nonce: "n",
        fileName: "old.txt",
        fileSize: 1,
        mimeType: "text/plain",
        contentMD5: "m",
        status: "uploaded",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "b",
        s3Key: "k2",
        nonce: "n",
        fileName: "new.txt",
        fileSize: 1,
        mimeType: "text/plain",
        contentMD5: "m",
        status: "uploaded",
      },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c",
        s3Key: "k3",
        nonce: "n",
        fileName: "gone.txt",
        fileSize: 1,
        mimeType: "text/plain",
        contentMD5: "m",
        status: "downloaded",
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/drops`,
      cookies: owner.cookies,
    });

    expect(response.statusCode).toBe(200);
    const { drops } = response.json();
    expect(drops).toHaveLength(2);
    expect(drops[0].id).toBe(older.id);
    expect(drops.map((drop: { fileName: string }) => drop.fileName)).not.toContain("gone.txt");
  });

  it("rejects a non-owner from listing another user's queue", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "queueowner2");
    const intruder = await registerAndGetCookie(server, "queueintruder");

    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId,
        slug: "private-queue",
        mode: "permanent",
        recipientPublicKey: owner.publicKey,
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/drops`,
      cookies: intruder.cookies,
    });

    expect(response.statusCode).toBe(403);
  });

  describe("GET /api/links/:slug never leaks an owned link's drop", () => {
    async function createOwnedLinkWithDrop(
      ownerId: string,
      slug: string,
      visibility: "public" | "contacts-only",
      status: "uploading" | "uploaded"
    ) {
      const link = await prisma.link.create({
        data: { ownerId, slug, mode: "permanent", visibility, recipientPublicKey: `${slug}-pubkey` },
      });
      const drop = await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: "c2VuZGVy",
          s3Key: `${link.id}/secret-drop`,
          nonce: "bm9uY2U=",
          fileName: "salary-2026.pdf",
          fileSize: 1024,
          mimeType: "application/pdf",
          contentMD5: "bWQ1",
          message: "secret plaintext note",
          status,
        },
      });
      return { link, drop };
    }

    function expectNoLeak(body: string, drop: { id: string }) {
      expect(body).not.toContain(drop.id);
      expect(body).not.toContain("salary-2026.pdf");
      expect(body).not.toContain("secret plaintext note");
    }

    it("returns drop: null to an anonymous stranger on a contacts-only owned link with an in-progress drop", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim");
      const { link, drop } = await createOwnedLinkWithDrop(owner.userId, "leak-contacts", "contacts-only", "uploading");

      const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });

      expect(response.statusCode).toBe(200);
      expect(response.json().drop).toBeNull();
      expectNoLeak(response.body, drop);
    });

    it("returns drop: null on a public owned link with an uploaded drop, including to a logged-in non-owner", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim2");
      const stranger = await registerAndGetCookie(server, "leakstranger");
      const { link, drop } = await createOwnedLinkWithDrop(owner.userId, "leak-public", "public", "uploaded");

      const anon = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });
      expect(anon.json().drop).toBeNull();
      expectNoLeak(anon.body, drop);

      const loggedIn = await server.inject({ method: "GET", url: `/api/links/${link.slug}`, cookies: stranger.cookies });
      expect(loggedIn.json().drop).toBeNull();
      expectNoLeak(loggedIn.body, drop);
    });

    it("returns drop: null on a user's default link (slug = username)", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim3");
      const link = await prisma.link.findFirstOrThrow({ where: { ownerId: owner.userId, isDefault: true } });
      const drop = await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: "c2VuZGVy",
          s3Key: `${link.id}/secret-drop`,
          nonce: "bm9uY2U=",
          fileName: "salary-2026.pdf",
          fileSize: 1024,
          mimeType: "application/pdf",
          contentMD5: "bWQ1",
          message: "secret plaintext note",
          status: "uploading",
        },
      });

      const response = await server.inject({ method: "GET", url: `/api/links/leakvictim3` });

      expect(response.statusCode).toBe(200);
      expect(response.json().drop).toBeNull();
      expectNoLeak(response.body, drop);
    });

    it("returns drop: null on an owned link with no drops (unchanged)", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim4");
      const link = await prisma.link.create({
        data: { ownerId: owner.userId, slug: "leak-empty", mode: "permanent", recipientPublicKey: "k" },
      });

      const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });

      expect(response.json().drop).toBeNull();
    });

    it("still returns the real drop for an anonymous link (Plan 1 regression guard)", async () => {
      const server = buildServer();
      const { link, drop } = await createLinkWithDrop("anon-with-drop", new Date(Date.now() + 60_000));

      const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isAnonymous).toBe(true);
      expect(body.drop).toMatchObject({ id: drop.id, status: "uploaded", fileName: "report.pdf" });
    });
  });
});
