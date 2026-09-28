// apps/api/src/routes/links.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

const { deleteObjectMock } = vi.hoisted(() => ({ deleteObjectMock: vi.fn() }));

vi.mock("../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/storage")>()),
  deleteObject: deleteObjectMock,
}));

import { buildServer } from "../server";
import { env } from "../env";
import { chargedBytes } from "../lib/quota";
import { subscribeToLink, type DropEvent } from "../lib/dropEvents";
import { deriveCodewords } from "../lib/codewords";
import { fakePublicKey } from "../test/fakeKeys";

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
      publicKey: fakePublicKey(username),
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return {
    userId: response.json().userId as string,
    publicKey: fakePublicKey(username),
    cookies: { e2ee_drop_session: cookie.value },
  };
}

// Creates a Drop against the current schema. Mirrors the fields uploads.ts's
// /complete route actually writes, with fileUploadStatus/deliveryStatus set
// directly to their post-upload values so these tests don't need to drive a
// full upload-url + complete round trip just to reach that state.
async function createLinkWithDrop(slug: string, expiresAt: Date) {
  const link = await prisma.link.create({
    data: { slug, mode: "one-time", recipientPublicKey: fakePublicKey("x"), retentionDays: 7, expiresAt },
  });
  const drop = await prisma.drop.create({
    data: {
      linkId: link.id,
      senderPublicKey: fakePublicKey("c2VuZGVy"),
      s3Key: `${link.id}/drop1`,
      archiveNonce: "YXJjaGl2ZQ==",
      contentMD5: "bWQ1",
      encryptedMetadata: "bWV0YWRhdGE=",
      metadataNonce: "bWV0YS1ub25jZQ==",
      fileSize: 1024,
      fileUploadStatus: "complete",
      deliveryStatus: "sent",
    },
  });
  return { link, drop };
}

// Mirrors the fields uploads.ts's /complete route actually writes, with
// deliveryStatus set directly to "sent" so these tests don't need to
// drive a full upload-url + complete round trip just to reach that state.
async function createSentDrop(linkId: string) {
  return prisma.drop.create({
    data: {
      linkId,
      senderPublicKey: fakePublicKey("c2VuZGVy"),
      s3Key: `${linkId}/sent-drop`,
      archiveNonce: "bm9uY2U=",
      contentMD5: "bWQ1",
      encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
      metadataNonce: "bWV0YS1ub25jZQ==",
      fileSize: 1024,
      fileUploadStatus: "complete",
      deliveryStatus: "sent",
    },
  });
}

describe("link routes", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    // Users too (same order as contacts.test.ts): several tests register
    // fixed usernames, which would collide on a re-run of this file alone.
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("creates a one-time link and can fetch it by slug", async () => {
    const server = buildServer();

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("cmVjaXBpZW50a2V5") },
    });
    expect(createResponse.statusCode).toBe(200);
    const { slug } = createResponse.json();
    expect(slug).toBeTruthy();

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(getResponse.statusCode).toBe(200);
    const body = getResponse.json();
    expect(body.recipientPublicKey).toBe(fakePublicKey("cmVjaXBpZW50a2V5"));
    expect(body.isAnonymous).toBe(true);
    expect(body.drop).toBeNull();
  });

  it("returns 404 for an unknown slug", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/links/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a numeric recipientPublicKey on POST /api/links with 400 (not 500) via the route's JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: 12345 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a recipientPublicKey that doesn't base64-decode to 32 bytes, instead of failing obscurely later", async () => {
    const server = buildServer();
    // "AAAA" base64-decodes to 3 bytes, not 32.
    const response = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "AAAA" },
    });
    expect(response.statusCode).toBe(400);
    expect(await prisma.link.count()).toBe(0);
  });

  it("rejects retentionDays above the anonymous one-time link's own expiry", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("pk"), retentionDays: 999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stores ownerNote on an anonymous link and returns it from GET", async () => {
    const server = buildServer();
    const create = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("pk"), ownerNote: "please send the invoice" },
    });
    expect(create.statusCode).toBe(200);
    const { slug } = create.json();
    const get = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(get.json().ownerNote).toBe("please send the invoice");
  });

  it("rejects an ownerNote over the 2000-char maxLength on POST /api/links with 400 (not 500) via JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("pk"), ownerNote: "a".repeat(2001) },
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts an ownerNote at the 2000-char maxLength on POST /api/links", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("pk"), ownerNote: "a".repeat(2000) },
    });
    expect(response.statusCode).toBe(200);
    const { slug } = response.json();
    const get = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(get.json().ownerNote).toHaveLength(2000);
  });

  it("deletes a link", async () => {
    const server = buildServer();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("cmVjaXBpZW50a2V5") },
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
      payload: { recipientPublicKey: fakePublicKey("cmVjaXBpZW50a2V5"), locale: "nb" },
    });
    const createBody = createResponse.json();
    expect(Array.isArray(createBody.codewords)).toBe(true);
    expect(createBody.codewords.length).toBeGreaterThan(0);

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${createBody.slug}` });
    const body = getResponse.json();

    expect(body.codewords).toEqual(createBody.codewords);
  });

  // Review finding F1: clients derive the phrase themselves from (their own
  // key, linkId, codewordLocale). Both responses must expose the latter two,
  // and the server's own `codewords` field must equal exactly what the
  // shared client-side derivation produces from them.
  it("exposes linkId and codewordLocale so clients can derive the same phrase locally", async () => {
    const server = buildServer();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("cmVjaXBpZW50a2V5"), locale: "nb" },
    });
    const createBody = createResponse.json();
    expect(createBody.codewordLocale).toBe("nb");

    const body = (await server.inject({ method: "GET", url: `/api/links/${createBody.slug}` })).json();
    expect(body.linkId).toBe(createBody.linkId);
    expect(body.codewordLocale).toBe("nb");
    expect(body.codewords).toEqual(
      await deriveCodewords(fakePublicKey("cmVjaXBpZW50a2V5"), createBody.linkId, "nb", env.CODEWORD_WORD_COUNT)
    );
  });

  it("returns the link's actual server-side expiresAt (epoch ms) on create", async () => {
    const server = buildServer();
    const before = Date.now();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("cmVjaXBpZW50a2V5") },
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
        publicKey: fakePublicKey("cHVia2V5"),
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

  // Task 11: DELETE /api/links/:slug now also succeeds for the authenticated
  // owner of an owned link, instead of unconditionally rejecting every owned
  // link (the test above covers the still-rejected unauthenticated case).
  describe("DELETE /api/links/:slug for an authenticated owner", () => {
    async function createOwnedDrop(linkId: string, key: string, fileEnvelopeStatus: "sealed" | "delivered" = "sealed") {
      return prisma.drop.create({
        data: {
          linkId,
          senderPublicKey: fakePublicKey("c2VuZGVy"),
          s3Key: `${linkId}/${key}`,
          archiveNonce: "bm9uY2U=",
          contentMD5: "bWQ1",
          encryptedMetadata: "bWV0YWRhdGE=",
          metadataNonce: "bWV0YS1ub25jZQ==",
          fileSize: 1024,
          fileUploadStatus: "complete",
          fileEnvelopeStatus,
        },
      });
    }

    it("allows the authenticated owner to delete their own link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "deleteowner1");
      const link = await prisma.link.create({
        data: { ownerId: owner.userId, slug: "owner-delete-me", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
      });

      const res = await server.inject({
        method: "DELETE",
        url: `/api/links/${link.slug}`,
        cookies: owner.cookies,
      });

      expect(res.statusCode).toBe(200);
    });

    it("deletes each still-present drop's storage object, releases only still-charged quota, then deletes the Link row", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "deleteowner2");
      const link = await prisma.link.create({
        data: { ownerId: owner.userId, slug: "owner-scrub-drops", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
      });
      const sealed = await createOwnedDrop(link.id, "sealed-drop", "sealed");
      const delivered = await createOwnedDrop(link.id, "delivered-drop", "delivered");
      // Quota fixture: both drops were charged at /complete, but the delivered drop's
      // charge was already released when its complete-download CAS won (lib/quota.ts
      // header invariant). So only the still-sealed drop is charged right now — and the
      // delete must release exactly that, never the delivered drop's charge a second time.
      await prisma.user.update({
        where: { id: owner.userId },
        data: { storageUsedBytes: chargedBytes(sealed.fileSize) },
      });

      const res = await server.inject({
        method: "DELETE",
        url: `/api/links/${link.slug}`,
        cookies: owner.cookies,
      });

      expect(res.statusCode).toBe(200);
      // The already-terminal (delivered) drop's object is already gone, so its
      // storage object is never touched here; only the still-sealed drop's object
      // is deleted.
      expect(deleteObjectMock).toHaveBeenCalledWith(sealed.s3Key);
      expect(deleteObjectMock).not.toHaveBeenCalledWith(delivered.s3Key);
      const found = await prisma.link.findUnique({ where: { slug: link.slug } });
      expect(found).toBeNull();
      expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(0);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
      expect(after.storageUsedBytes).toBe(0n);
    });

    it("refuses to let the owner delete their own default link (403)", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "deleteowner4");
      const defaultLink = await prisma.link.findFirstOrThrow({ where: { ownerId: owner.userId, isDefault: true } });
      await createOwnedDrop(defaultLink.id, "default-drop", "sealed");

      const res = await server.inject({
        method: "DELETE",
        url: `/api/links/${defaultLink.slug}`,
        cookies: owner.cookies,
      });

      expect(res.statusCode).toBe(403);
      expect(await prisma.link.findUnique({ where: { id: defaultLink.id } })).not.toBeNull();
      expect(await prisma.drop.count({ where: { linkId: defaultLink.id } })).toBe(1);
      expect(deleteObjectMock).not.toHaveBeenCalled();
    });

    it("still rejects a non-owner for an owned link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "deleteowner3");
      const intruder = await registerAndGetCookie(server, "deleteintruder");
      const link = await prisma.link.create({
        data: { ownerId: owner.userId, slug: "owner-not-yours", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
      });

      const res = await server.inject({
        method: "DELETE",
        url: `/api/links/${link.slug}`,
        cookies: intruder.cookies,
      });

      expect(res.statusCode).toBe(403);
      expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
      expect(deleteObjectMock).not.toHaveBeenCalled();
    });

    // Finding F6: DELETE must mask a contacts-only link from a non-contact
    // caller the same way GET /:slug and upload-url already do — a
    // distinguishing 403 leaks that a link with this slug exists and is
    // owned. shouldMaskAsNotFound (lib/links.ts) already returns false for
    // an anonymous link and for the true owner, so the two tests above and
    // below are unaffected.
    it("masks DELETE from a non-contact caller on a contacts-only link, byte-identical to a nonexistent slug", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "deleteownerco");
      await prisma.user.update({ where: { username: "deleteownerco" }, data: { emailVerified: true } });
      const link = await prisma.link.create({
        data: {
          ownerId: owner.userId,
          slug: "owner-delete-co",
          mode: "permanent",
          visibility: "contacts-only",
          recipientPublicKey: owner.publicKey,
          retentionDays: 7,
        },
      });
      const stranger = await registerAndGetCookie(server, "deletestrangerco");

      const masked = await server.inject({
        method: "DELETE",
        url: `/api/links/${link.slug}`,
        cookies: stranger.cookies,
      });
      const nonexistent = await server.inject({
        method: "DELETE",
        url: "/api/links/does-not-exist-deleteco",
        cookies: stranger.cookies,
      });

      expect(masked.statusCode).toBe(404);
      expect(masked.statusCode).toBe(nonexistent.statusCode);
      expect(masked.json()).toEqual(nonexistent.json());
      expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
      expect(deleteObjectMock).not.toHaveBeenCalled();
    });

    // The block-relationship arm of shouldMaskAsNotFound applies even to a
    // PUBLIC link — a block is a stronger signal than visibility. Confirms
    // DELETE picks up that branch too, not just contacts-only.
    it("masks DELETE from a caller with an active block relationship, even though the link is public", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "deleteownerblock");
      await prisma.user.update({ where: { username: "deleteownerblock" }, data: { emailVerified: true } });
      const link = await prisma.link.create({
        data: {
          ownerId: owner.userId,
          slug: "owner-delete-block",
          mode: "permanent",
          visibility: "public",
          recipientPublicKey: owner.publicKey,
          retentionDays: 7,
        },
      });
      const blocker = await registerAndGetCookie(server, "deleteblocker");
      await prisma.contact.create({
        data: { userId: blocker.userId, contactUserId: owner.userId, status: "blocked", blockedByUserId: blocker.userId },
      });

      const masked = await server.inject({
        method: "DELETE",
        url: `/api/links/${link.slug}`,
        cookies: blocker.cookies,
      });

      expect(masked.statusCode).toBe(404);
      expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
      expect(deleteObjectMock).not.toHaveBeenCalled();
    });

    it("anonymous-link deletion is unchanged", async () => {
      const server = buildServer();
      const { link: anonymousLink, drop } = await createLinkWithDrop("owner-delete-anon-unchanged", new Date(Date.now() + 60_000));

      const res = await server.inject({ method: "DELETE", url: `/api/links/${anonymousLink.slug}` });

      expect(res.statusCode).toBe(200);
      expect(deleteObjectMock).toHaveBeenCalledWith(drop.s3Key);
      expect(await prisma.link.findUnique({ where: { id: anonymousLink.id } })).toBeNull();
    });
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
        publicKey: fakePublicKey("b3duZXJrZXk="),
        storageQuotaBytes: BigInt(1024 * 1024 * 1024), // 1GB
      },
    });
    const ownedLink = await prisma.link.create({
      data: { ownerId: owner.id, slug: "ada", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });

    const ownedResponse = await server.inject({ method: "GET", url: `/api/links/${ownedLink.slug}` });
    const ownedBody = ownedResponse.json();
    expect(ownedBody.isAnonymous).toBe(false);
    expect(ownedBody.recipientName).toBe("Ada Lovelace");
    expect(ownedBody.recipientEmailVerified).toBe(true);

    const anonCreate = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("YW5vbg==") },
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
    await prisma.user.update({ where: { username: "customownera" }, data: { emailVerified: true } });

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
    await prisma.user.update({ where: { username: "customownerb" }, data: { emailVerified: true } });
    await prisma.user.update({ where: { username: "customownerc" }, data: { emailVerified: true } });

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
        retentionDays: 7,
      },
    });
    const older = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: fakePublicKey("a"),
        s3Key: "k1",
        archiveNonce: "bg==",
        contentMD5: "m",
        encryptedMetadata: "b2xkLnR4dA==",
        metadataNonce: "bg==",
        fileSize: 1,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: fakePublicKey("b"),
        s3Key: "k2",
        archiveNonce: "bg==",
        contentMD5: "m",
        encryptedMetadata: "bmV3LnR4dA==",
        metadataNonce: "bg==",
        fileSize: 1,
      },
    });
    const gone = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: fakePublicKey("c"),
        s3Key: "k3",
        archiveNonce: "bg==",
        contentMD5: "m",
        encryptedMetadata: "Z29uZS50eHQ=",
        metadataNonce: "bg==",
        fileSize: 1,
        fileEnvelopeStatus: "delivered",
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
    expect(drops.map((drop: { id: string }) => drop.id)).not.toContain(gone.id);
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
        retentionDays: 7,
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/drops`,
      cookies: intruder.cookies,
    });

    expect(response.statusCode).toBe(403);
  });

  // Finding F6: GET .../drops must mask a contacts-only link from a
  // non-contact caller the same way GET /:slug and upload-url already do —
  // a distinguishing 403 leaks that a link with this slug exists and is
  // owned.
  it("masks GET .../drops from a non-contact caller on a contacts-only link, byte-identical to a nonexistent slug", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "queueownerco");
    await prisma.user.update({ where: { username: "queueownerco" }, data: { emailVerified: true } });
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId,
        slug: "private-queue-co",
        mode: "permanent",
        visibility: "contacts-only",
        recipientPublicKey: owner.publicKey,
        retentionDays: 7,
      },
    });
    const stranger = await registerAndGetCookie(server, "queuestrangerco");

    const masked = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/drops`,
      cookies: stranger.cookies,
    });
    const nonexistent = await server.inject({
      method: "GET",
      url: "/api/links/does-not-exist-queueco/drops",
      cookies: stranger.cookies,
    });

    expect(masked.statusCode).toBe(404);
    expect(masked.statusCode).toBe(nonexistent.statusCode);
    expect(masked.json()).toEqual(nonexistent.json());
  });

  // The block-relationship arm applies even to a PUBLIC link.
  it("masks GET .../drops from a caller with an active block relationship, even though the link is public", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "queueownerblock");
    await prisma.user.update({ where: { username: "queueownerblock" }, data: { emailVerified: true } });
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId,
        slug: "private-queue-block",
        mode: "permanent",
        visibility: "public",
        recipientPublicKey: owner.publicKey,
        retentionDays: 7,
      },
    });
    const blocker = await registerAndGetCookie(server, "queueblocker");
    await prisma.contact.create({
      data: { userId: blocker.userId, contactUserId: owner.userId, status: "blocked", blockedByUserId: blocker.userId },
    });

    const masked = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/drops`,
      cookies: blocker.cookies,
    });

    expect(masked.statusCode).toBe(404);
  });

  // Task 2 brief's "Important" callout, and the reasoning re-verified against
  // current code before this task touched this route: a sender-initiated
  // request link (POST /api/links/request) is always created with
  // `visibility: "public"` (see that route in links.ts), so
  // shouldMaskAsNotFound never masks its claimant here (barring an actual
  // block relationship, a separate edge case) — the claimant's request must
  // still fall through unaffected to the existing 403 Forbidden below,
  // exactly as ReceivePage.tsx's loadSnapshot effect relies on (a 403 from
  // this exact route is how it detects "I claimed this link, I don't own
  // it" and falls back to the single-drop claimant view).
  it("still returns 403 (never masked to 404) for an authenticated non-owner on a claimed sender-initiated request link's GET .../drops", async () => {
    const server = buildServer();
    const initiator = await registerAndGetCookie(server, "initiatorclaimq");
    await prisma.user.update({ where: { username: "initiatorclaimq" }, data: { emailVerified: true } });
    const requestRes = await server.inject({
      method: "POST",
      url: "/api/links/request",
      payload: {},
      cookies: initiator.cookies,
    });
    const { slug } = requestRes.json();
    await server.inject({
      method: "POST",
      url: `/api/links/${slug}/claim`,
      payload: { recipientPublicKey: fakePublicKey("claimant-pubkey") },
    });
    const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
    expect(link.visibility).toBe("public");

    // The real claimant is anonymous (no session tied to the claim itself —
    // see POST /:slug/claim's own doc comment), so any OTHER authenticated,
    // non-owner account calling this owner-gated route reproduces exactly
    // the response ReceivePage.tsx's fallback logic depends on: a plain 403,
    // never masked, regardless of who is asking.
    const someoneElse = await registerAndGetCookie(server, "notclaimantq");

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${slug}/drops`,
      cookies: someoneElse.cookies,
    });

    expect(response.statusCode).toBe(403);
  });

  describe("POST /api/links/custom input validation", () => {
    it("rejects an unknown visibility (e.g. the typo contacts_only) with 400 instead of failing open to public", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "visowner");

      const response = await server.inject({
        method: "POST",
        url: "/api/links/custom",
        payload: { slug: "typo-link", mode: "permanent", visibility: "contacts_only" },
        cookies: owner.cookies,
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.link.findUnique({ where: { slug: "typo-link" } })).toBeNull();
    });

    it("accepts contacts-only and defaults an omitted visibility to public", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "visowner2");
      await prisma.user.update({ where: { username: "visowner2" }, data: { emailVerified: true } });

      const contactsOnly = await server.inject({
        method: "POST",
        url: "/api/links/custom",
        payload: {
          slug: "friends-only",
          mode: "permanent",
          visibility: "contacts-only",
          // resolveRetentionDays now caps a permanent link's retentionDays at
          // env.DROP_RETENTION_DAYS_MAX (design spec §4.4), unlike the old
          // MAX_RETENTION_DAYS check that only rejected values past the int4 range.
          retentionDays: env.DROP_RETENTION_DAYS_MAX,
        },
        cookies: owner.cookies,
      });
      expect(contactsOnly.statusCode).toBe(200);
      const created = await prisma.link.findUniqueOrThrow({ where: { slug: "friends-only" } });
      expect(created.visibility).toBe("contacts-only");
      expect(created.retentionDays).toBe(env.DROP_RETENTION_DAYS_MAX);

      const omitted = await server.inject({
        method: "POST",
        url: "/api/links/custom",
        payload: { slug: "no-visibility", mode: "permanent" },
        cookies: owner.cookies,
      });
      expect(omitted.statusCode).toBe(200);
      const defaulted = await prisma.link.findUniqueOrThrow({ where: { slug: "no-visibility" } });
      expect(defaulted.visibility).toBe("public");
      // Link.retentionDays is NOT NULL: an omitted value resolves to the global
      // default (resolveRetentionDays), never a literal null.
      expect(defaulted.retentionDays).toBe(env.DROP_RETENTION_DAYS_DEFAULT);
    });

    it.each([
      ["negative", -1],
      ["zero", 0],
      ["fractional", 1.5],
      ["string-typed", "30"],
      ["beyond-int4", 2_147_483_648],
    ])("rejects a %s retentionDays with 400", async (_label, retentionDays) => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "retowner");

      const response = await server.inject({
        method: "POST",
        url: "/api/links/custom",
        payload: { slug: "bad-retention", mode: "permanent", retentionDays },
        cookies: owner.cookies,
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.link.findUnique({ where: { slug: "bad-retention" } })).toBeNull();
    });

    it("rejects an ownerNote over the 2000-char maxLength with 400 (not 500) via JSON-schema body validation", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "notetoolongowner");

      const response = await server.inject({
        method: "POST",
        url: "/api/links/custom",
        payload: { slug: "note-too-long", mode: "permanent", ownerNote: "a".repeat(2001) },
        cookies: owner.cookies,
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.link.findUnique({ where: { slug: "note-too-long" } })).toBeNull();
    });

    it("accepts an ownerNote at the 2000-char maxLength", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "noteatlimitowner");
      await prisma.user.update({ where: { username: "noteatlimitowner" }, data: { emailVerified: true } });

      const response = await server.inject({
        method: "POST",
        url: "/api/links/custom",
        payload: { slug: "note-at-limit", mode: "permanent", ownerNote: "a".repeat(2000) },
        cookies: owner.cookies,
      });

      expect(response.statusCode).toBe(200);
      const created = await prisma.link.findUniqueOrThrow({ where: { slug: "note-at-limit" } });
      expect(created.ownerNote).toHaveLength(2000);
    });
  });

  it("rejects POST /api/links/custom from an unverified account", async () => {
    const server = buildServer();
    const { cookies } = await registerAndGetCookie(server, "unverified-creator");
    // emailVerified defaults to false — no update call, unlike the other tests in this file.
    const res = await server.inject({ method: "POST", url: "/api/links/custom", cookies, payload: { slug: "should-fail", mode: "permanent" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/verif/i);
  });

  describe("GET /api/links/:slug never leaks an owned link's drop", () => {
    async function createOwnedLinkWithDrop(
      ownerId: string,
      slug: string,
      visibility: "public" | "contacts-only",
      fileUploadStatus: "uploading" | "complete",
      // Matches how a real owned link is actually created (POST
      // /api/links/custom, createDefaultLinkForUser): recipientPublicKey is
      // always the owner's own real publicKey, never an unrelated value — a
      // link where it differs is what finding C1's canReceive/
      // isClaimedSenderInitiatedLink (lib/links.ts) treats as a claimed
      // sender-initiated link instead, so an arbitrary placeholder key here
      // would misrepresent this as that other, deliberately-more-open case.
      recipientPublicKey: string
    ) {
      const link = await prisma.link.create({
        data: { ownerId, slug, mode: "permanent", visibility, recipientPublicKey, retentionDays: 7 },
      });
      const drop = await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: fakePublicKey("c2VuZGVy"),
          s3Key: `${link.id}/secret-drop`,
          archiveNonce: "bm9uY2U=",
          contentMD5: "bWQ1",
          encryptedMetadata: "LEAKED-SALARY-METADATA-MARKER",
          metadataNonce: "bWV0YS1ub25jZQ==",
          fileSize: 1024,
          encryptedMessage: "LEAKED-MESSAGE-MARKER",
          messageNonce: "bWVzc2FnZS1ub25jZQ==",
          fileUploadStatus,
        },
      });
      return { link, drop };
    }

    function expectNoLeak(body: string, drop: { id: string }) {
      expect(body).not.toContain(drop.id);
      expect(body).not.toContain("LEAKED-SALARY-METADATA-MARKER");
      expect(body).not.toContain("LEAKED-MESSAGE-MARKER");
    }

    // Now that GET /:slug enforces contacts-only visibility (this plan's Task 4),
    // an anonymous stranger gets a plain 404 for a contacts-only link rather than
    // a 200 with drop: null — but the no-leak property must still hold on that
    // 404 body.
    it("404s a contacts-only owned link with an in-progress drop for an anonymous stranger, leaking nothing", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim");
      await prisma.user.update({ where: { username: "leakvictim" }, data: { emailVerified: true } });
      const { link, drop } = await createOwnedLinkWithDrop(
        owner.userId,
        "leak-contacts",
        "contacts-only",
        "uploading",
        owner.publicKey
      );

      const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });

      expect(response.statusCode).toBe(404);
      expectNoLeak(response.body, drop);
    });

    it("returns drop: null on a public owned link with an uploaded drop, including to a logged-in non-owner", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim2");
      await prisma.user.update({ where: { username: "leakvictim2" }, data: { emailVerified: true } });
      const stranger = await registerAndGetCookie(server, "leakstranger");
      const { link, drop } = await createOwnedLinkWithDrop(
        owner.userId,
        "leak-public",
        "public",
        "complete",
        owner.publicKey
      );

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
      await prisma.user.update({ where: { username: "leakvictim3" }, data: { emailVerified: true } });
      const link = await prisma.link.findFirstOrThrow({ where: { ownerId: owner.userId, isDefault: true } });
      const drop = await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: fakePublicKey("c2VuZGVy"),
          s3Key: `${link.id}/secret-drop`,
          archiveNonce: "bm9uY2U=",
          contentMD5: "bWQ1",
          encryptedMetadata: "LEAKED-SALARY-METADATA-MARKER",
          metadataNonce: "bWV0YS1ub25jZQ==",
          fileSize: 1024,
          encryptedMessage: "LEAKED-MESSAGE-MARKER",
          messageNonce: "bWVzc2FnZS1ub25jZQ==",
          fileUploadStatus: "uploading",
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
      await prisma.user.update({ where: { username: "leakvictim4" }, data: { emailVerified: true } });
      const link = await prisma.link.create({
        data: {
          ownerId: owner.userId,
          slug: "leak-empty",
          mode: "permanent",
          recipientPublicKey: owner.publicKey,
          retentionDays: 7,
        },
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
      expect(body.drop).toMatchObject({ id: drop.id, fileUploadStatus: "complete", deliveryStatus: "sent" });
    });
  });

  describe("POST /api/links/:slug/mark-receiver-opened", () => {
    it("advances deliveryStatus from sent to receiver_opened", async () => {
      const server = buildServer();
      const link = await prisma.link.create({
        data: {
          slug: "mark-opened-anon",
          mode: "one-time",
          recipientPublicKey: fakePublicKey("x"),
          retentionDays: 7,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await createSentDrop(link.id);

      const markResponse = await server.inject({
        method: "POST",
        url: `/api/links/${link.slug}/mark-receiver-opened`,
      });
      expect(markResponse.statusCode).toBe(200);

      const res = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });
      expect(res.json().drop.deliveryStatus).toBe("receiver_opened");
    });

    it("plain GET never advances deliveryStatus on its own", async () => {
      const server = buildServer();
      const link = await prisma.link.create({
        data: {
          slug: "no-side-effect-get",
          mode: "one-time",
          recipientPublicKey: fakePublicKey("x"),
          retentionDays: 7,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await createSentDrop(link.id);

      await server.inject({ method: "GET", url: `/api/links/${link.slug}` });
      const res = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });
      expect(res.json().drop.deliveryStatus).toBe("sent");
    });

    it("is a no-op for an owned link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "markopenedowner");
      const ownedLink = await prisma.link.create({
        data: {
          ownerId: owner.userId,
          slug: "mark-opened-owned",
          mode: "permanent",
          recipientPublicKey: owner.publicKey,
          retentionDays: 7,
        },
      });
      await createSentDrop(ownedLink.id);

      const markResponse = await server.inject({
        method: "POST",
        url: `/api/links/${ownedLink.slug}/mark-receiver-opened`,
      });
      expect(markResponse.statusCode).toBe(200);

      const res = await server.inject({
        method: "GET",
        url: `/api/links/${ownedLink.slug}/drops`,
        cookies: owner.cookies,
      });
      expect(res.json().drops[0].deliveryStatus).toBe("sent");
    });

    it("returns 404 for an unknown slug", async () => {
      const server = buildServer();
      const response = await server.inject({
        method: "POST",
        url: "/api/links/does-not-exist/mark-receiver-opened",
      });
      expect(response.statusCode).toBe(404);
    });

    // Finding C1: acts for a claimed sender-initiated link too (the claimant is
    // the real recipient there, unlike the link's owner/initiator).
    it("advances deliveryStatus for a non-owner on a claimed sender-initiated link", async () => {
      const server = buildServer();
      const initiator = await registerAndGetCookie(server, "markopenedinitiator");
      await prisma.user.update({ where: { username: "markopenedinitiator" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: initiator.cookies,
      });
      const { slug } = requestRes.json();
      await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("claimant-pubkey") },
      });
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      await createSentDrop(link.id);

      const markResponse = await server.inject({ method: "POST", url: `/api/links/${slug}/mark-receiver-opened` });
      expect(markResponse.statusCode).toBe(200);

      const res = await server.inject({ method: "GET", url: `/api/links/${slug}` });
      expect(res.json().drop.deliveryStatus).toBe("receiver_opened");
    });

    it("does not advance deliveryStatus when the caller is the initiator/owner of a claimed sender-initiated link", async () => {
      const server = buildServer();
      const initiator = await registerAndGetCookie(server, "markopenedinitiator2");
      await prisma.user.update({ where: { username: "markopenedinitiator2" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: initiator.cookies,
      });
      const { slug } = requestRes.json();
      await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("claimant-pubkey") },
      });
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      await createSentDrop(link.id);

      const markResponse = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/mark-receiver-opened`,
        cookies: initiator.cookies,
      });
      expect(markResponse.statusCode).toBe(200);

      // The initiator can't read `drop` back from GET /:slug (finding C1 keeps
      // that hidden from them), so check the underlying row directly.
      const drop = await prisma.drop.findFirstOrThrow({ where: { linkId: link.id } });
      expect(drop.deliveryStatus).toBe("sent");
    });

    it("advances the oldest still-outstanding drop, not an arbitrary/insertion-order one, on a multi-drop claimed link", async () => {
      // Regression test for the arbitrary `link.drops[0]` fix: a claimed
      // sender-initiated link (mode: "permanent") can accumulate more than
      // one outstanding drop over its lifetime, unlike a one-time anonymous
      // link. getLinkBySlug's `include: { drops: true }` carries no orderBy,
      // so array order is not guaranteed to reflect creation order — this
      // test creates the chronologically NEWER drop first (at the DB level)
      // and the chronologically OLDER one second, so a naive `drops[0]`
      // would pick the wrong (newer) one. The fix sorts by createdAt and
      // filters out delivered/shredded drops, mirroring toLinkStatusResponse's
      // own `relevantDrops` — the oldest still-outstanding drop is the one
      // that must advance.
      const server = buildServer();
      const initiator = await registerAndGetCookie(server, "markopenedmulti");
      await prisma.user.update({ where: { username: "markopenedmulti" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: initiator.cookies,
      });
      const { slug } = requestRes.json();
      await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("claimant-pubkey") },
      });
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });

      const dropDefaults = {
        linkId: link.id,
        senderPublicKey: fakePublicKey("c2VuZGVy"),
        archiveNonce: "bm9uY2U=",
        contentMD5: "bWQ1",
        encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
        metadataNonce: "bWV0YS1ub25jZQ==",
        fileSize: 1024,
        fileUploadStatus: "complete" as const,
        deliveryStatus: "sent" as const,
      };
      // Inserted FIRST in the DB, but chronologically NEWER (createdAt in the future).
      const newerDrop = await prisma.drop.create({
        data: { ...dropDefaults, s3Key: `${link.id}/newer`, createdAt: new Date(Date.now() + 60_000) },
      });
      // Inserted SECOND in the DB, but chronologically OLDER (createdAt in the past).
      const olderDrop = await prisma.drop.create({
        data: { ...dropDefaults, s3Key: `${link.id}/older`, createdAt: new Date(Date.now() - 60_000) },
      });
      // Also delivered/shredded drops (even older) must never be picked, whatever their createdAt.
      const deliveredDrop = await prisma.drop.create({
        data: {
          ...dropDefaults,
          s3Key: `${link.id}/delivered`,
          createdAt: new Date(Date.now() - 120_000),
          fileEnvelopeStatus: "delivered",
        },
      });

      const markResponse = await server.inject({ method: "POST", url: `/api/links/${slug}/mark-receiver-opened` });
      expect(markResponse.statusCode).toBe(200);

      const after = {
        newer: await prisma.drop.findUniqueOrThrow({ where: { id: newerDrop.id } }),
        older: await prisma.drop.findUniqueOrThrow({ where: { id: olderDrop.id } }),
        delivered: await prisma.drop.findUniqueOrThrow({ where: { id: deliveredDrop.id } }),
      };
      expect(after.older.deliveryStatus).toBe("receiver_opened");
      expect(after.newer.deliveryStatus).toBe("sent");
      expect(after.delivered.deliveryStatus).toBe("sent");
    });
  });

  describe("POST /api/links/:slug/mark-sender-opened", () => {
    it("updates Link.lastSenderOpenedAt", async () => {
      const server = buildServer();
      const { link } = await createLinkWithDrop("mark-sender-opened-basic", new Date(Date.now() + 60_000));
      const before = await prisma.link.findUniqueOrThrow({ where: { slug: link.slug } });
      expect(before.lastSenderOpenedAt).toBeNull();

      const response = await server.inject({
        method: "POST",
        url: `/api/links/${link.slug}/mark-sender-opened`,
      });
      expect(response.statusCode).toBe(200);

      const after = await prisma.link.findUniqueOrThrow({ where: { slug: link.slug } });
      expect(after.lastSenderOpenedAt).not.toBeNull();
    });

    it("does not create any Drop or touch deliveryStatus", async () => {
      const server = buildServer();
      const { link } = await createLinkWithDrop(
        "mark-sender-opened-no-side-effect",
        new Date(Date.now() + 60_000)
      );
      const before = await prisma.drop.count({ where: { linkId: link.id } });

      await server.inject({ method: "POST", url: `/api/links/${link.slug}/mark-sender-opened` });

      const after = await prisma.drop.count({ where: { linkId: link.id } });
      expect(after).toBe(before);
      const drop = await prisma.drop.findFirstOrThrow({ where: { linkId: link.id } });
      expect(drop.deliveryStatus).toBe("sent");
    });

    it("a second visit overwrites the earlier timestamp, not just the first", async () => {
      const server = buildServer();
      const { link } = await createLinkWithDrop("mark-sender-opened-overwrite", new Date(Date.now() + 60_000));

      await server.inject({ method: "POST", url: `/api/links/${link.slug}/mark-sender-opened` });
      const first = (await prisma.link.findUniqueOrThrow({ where: { slug: link.slug } })).lastSenderOpenedAt;
      await new Promise((r) => setTimeout(r, 5));
      await server.inject({ method: "POST", url: `/api/links/${link.slug}/mark-sender-opened` });
      const second = (await prisma.link.findUniqueOrThrow({ where: { slug: link.slug } })).lastSenderOpenedAt;

      expect(second!.getTime()).toBeGreaterThan(first!.getTime());
    });

    it("plain GET never touches lastSenderOpenedAt on its own", async () => {
      const server = buildServer();
      const { link } = await createLinkWithDrop("mark-sender-opened-get-noop", new Date(Date.now() + 60_000));

      await server.inject({ method: "GET", url: `/api/links/${link.slug}` });

      const after = await prisma.link.findUniqueOrThrow({ where: { slug: link.slug } });
      expect(after.lastSenderOpenedAt).toBeNull();
    });

    it("returns 404 for an unknown slug", async () => {
      const server = buildServer();
      const response = await server.inject({
        method: "POST",
        url: "/api/links/does-not-exist/mark-sender-opened",
      });
      expect(response.statusCode).toBe(404);
    });

    it("does not update lastSenderOpenedAt on a revoked (but not yet expired) link", async () => {
      // Regression test for the under-gating fix: this route used to check
      // only isLinkExpired, so a revoked-but-not-expired link (revokedAt set,
      // expiresAt still in the future) kept recording this telemetry field
      // even though the link is otherwise treated as gone everywhere else
      // (isLinkInactive — see GET /:slug, /claim). Now gated on
      // isLinkInactive, matching /revoke's neighbors (Task 1).
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "revoked-sender-opened-owner");
      await prisma.user.update({ where: { username: "revoked-sender-opened-owner" }, data: { emailVerified: true } });
      const link = await prisma.link.create({
        data: {
          ownerId: owner.userId,
          slug: "revoked-sender-opened",
          mode: "one-time",
          recipientPublicKey: owner.publicKey,
          retentionDays: 7,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: new Date(),
        },
      });
      expect(link.lastSenderOpenedAt).toBeNull();

      const response = await server.inject({
        method: "POST",
        url: `/api/links/${link.slug}/mark-sender-opened`,
      });
      expect(response.statusCode).toBe(404);

      const after = await prisma.link.findUniqueOrThrow({ where: { slug: link.slug } });
      expect(after.lastSenderOpenedAt).toBeNull();
    });
  });

  describe("POST /api/links/request", () => {
    it("creates an unclaimed link owned by the authenticated user", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "requester");
      await prisma.user.update({ where: { username: "requester" }, data: { emailVerified: true } });

      const res = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: { ownerNote: "please claim this" },
        cookies: owner.cookies,
      });
      expect(res.statusCode).toBe(200);
      const { slug } = res.json();
      expect(slug).toBeTruthy();

      const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
      expect(status.json().recipientPublicKey).toBeNull();
      expect(status.json().ownerNote).toBe("please claim this");

      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      expect(link.ownerId).toBe(owner.userId);
      expect(link.mode).toBe("permanent");
      expect(link.recipientPublicKey).toBeNull();
    });

    it("rejects an anonymous caller", async () => {
      // requireAuth (plugins/auth.ts) replies 403 for an unauthenticated caller — same as
      // every other requireAuth-protected route in this codebase (e.g. the "rejects a
      // non-owner..." test above, downloads.test.ts) — not 401.
      const server = buildServer();
      const res = await server.inject({ method: "POST", url: "/api/links/request", payload: {} });
      expect(res.statusCode).toBe(403);
    });

    it("rejects retentionDays above the global max", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "requesterbad");

      const res = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: { retentionDays: env.DROP_RETENTION_DAYS_MAX + 1 },
        cookies: owner.cookies,
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an ownerNote over the 2000-char maxLength with 400 (not 500) via JSON-schema body validation", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "requesternotetoolong");

      const res = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: { ownerNote: "a".repeat(2001) },
        cookies: owner.cookies,
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts an ownerNote at the 2000-char maxLength", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "requesternoteatlimit");
      await prisma.user.update({ where: { username: "requesternoteatlimit" }, data: { emailVerified: true } });

      const res = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: { ownerNote: "a".repeat(2000) },
        cookies: owner.cookies,
      });
      expect(res.statusCode).toBe(200);
      const { slug } = res.json();
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      expect(link.ownerNote).toHaveLength(2000);
    });
  });

  describe("POST /api/links/:slug/claim", () => {
    it("claims an unclaimed link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner1");
      await prisma.user.update({ where: { username: "claimowner1" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();

      const res = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("recipient-pk") },
      });
      expect(res.statusCode).toBe(200);
      const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
      expect(status.json().recipientPublicKey).toBe(fakePublicKey("recipient-pk"));
    });

    it("rejects a griefer claiming a request link with a malformed recipientPublicKey, leaving it unclaimed", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner1b");
      await prisma.user.update({ where: { username: "claimowner1b" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();

      // "AAAA" base64-decodes to 3 bytes, not 32 — without validation this
      // would permanently brick the link, since a request link has no
      // unclaim path.
      const res = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: "AAAA" },
      });
      expect(res.statusCode).toBe(400);

      // The link must still be claimable afterward — proving the rejected
      // attempt never won the CAS.
      const claim = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("real-claimant") },
      });
      expect(claim.statusCode).toBe(200);
    });

    it("rejects claiming an already-claimed link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner2");
      await prisma.user.update({ where: { username: "claimowner2" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();

      await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("first") },
      });
      const second = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("second") },
      });
      expect(second.statusCode).toBe(409);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      expect(link.recipientPublicKey).toBe(fakePublicKey("first"));
    });

    it("rejects claiming a link that already had a recipient key (recipient-initiated flow)", async () => {
      const server = buildServer();
      const createRes = await server.inject({
        method: "POST",
        url: "/api/links",
        payload: { recipientPublicKey: fakePublicKey("already-set") },
      });
      const { slug } = createRes.json();

      const res = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("x") },
      });
      expect(res.statusCode).toBe(409);
    });

    it("rejects a claim with a missing recipientPublicKey", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner3");
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();

      const res = await server.inject({ method: "POST", url: `/api/links/${slug}/claim`, payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown slug", async () => {
      const server = buildServer();
      const res = await server.inject({
        method: "POST",
        url: "/api/links/does-not-exist/claim",
        payload: { recipientPublicKey: fakePublicKey("x") },
      });
      expect(res.statusCode).toBe(404);
    });

    // Finding 2 (final review): the claim handler used to check only
    // isLinkExpired, so a revoked link could still be claimed even though
    // GET /api/links/:slug already 404s it.
    it("404s a claim attempt on a revoked link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner5");
      await prisma.user.update({ where: { username: "claimowner5" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();

      const revoke = await server.inject({ method: "POST", url: `/api/links/${slug}/revoke`, cookies: owner.cookies });
      expect(revoke.statusCode).toBe(200);

      const res = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("x") },
      });
      expect(res.statusCode).toBe(404);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      expect(link.recipientPublicKey).toBeNull();
    });

    it("resolves true concurrency to exactly one winner", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner4");
      await prisma.user.update({ where: { username: "claimowner4" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();
      const url = `/api/links/${slug}/claim`;

      const [a, b] = await Promise.all([
        server.inject({ method: "POST", url, payload: { recipientPublicKey: fakePublicKey("racer-a") } }),
        server.inject({ method: "POST", url, payload: { recipientPublicKey: fakePublicKey("racer-b") } }),
      ]);

      const statusCodes = [a.statusCode, b.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      expect([fakePublicKey("racer-a"), fakePublicKey("racer-b")]).toContain(link.recipientPublicKey);
    });

    // Finding I6: design spec §4.2 — /send/:slug detects a claim over the
    // existing per-link SSE channel. Only emitted once the CAS actually wins.
    it("emits a link-claimed SSE event once the claim CAS wins, and not on a losing claim", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimeventowner");
      await prisma.user.update({ where: { username: "claimeventowner" }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });

      const events: DropEvent[] = [];
      const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

      const first = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("claimant-pubkey") },
      });
      const second = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("someone-elses-key") },
      });
      unsubscribe();

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(events).toEqual([{ type: "link-claimed", recipientPublicKey: fakePublicKey("claimant-pubkey") }]);
    });
  });

  // Finding C1 end-to-end: the sender-initiated flow must actually deliver
  // something — the claimant (not the initiator) can see the drop via the
  // same unauthenticated GET the anonymous flow uses.
  describe("finding C1: sender-initiated flow is reachable end-to-end via GET /api/links/:slug", () => {
    async function requestAndClaim(server: ReturnType<typeof buildServer>, username: string) {
      const initiator = await registerAndGetCookie(server, username);
      await prisma.user.update({ where: { username }, data: { emailVerified: true } });
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: initiator.cookies,
      });
      const { slug } = requestRes.json();
      await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: fakePublicKey("claimant-pubkey") },
      });
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      return { initiator, slug, link };
    }

    it("exposes the drop to a non-owner caller once claimed", async () => {
      const server = buildServer();
      const { slug, link } = await requestAndClaim(server, "e2einitiator1");
      const drop = await createSentDrop(link.id);

      const res = await server.inject({ method: "GET", url: `/api/links/${slug}` });

      expect(res.statusCode).toBe(200);
      expect(res.json().drop).toMatchObject({ id: drop.id });
    });

    it("still hides the drop from the initiator/owner themselves once claimed", async () => {
      const server = buildServer();
      const { initiator, slug, link } = await requestAndClaim(server, "e2einitiator2");
      await createSentDrop(link.id);

      const res = await server.inject({ method: "GET", url: `/api/links/${slug}`, cookies: initiator.cookies });

      expect(res.statusCode).toBe(200);
      expect(res.json().drop).toBeNull();
    });

    // docs/STATUS.md gap 3: a request link is `mode: "permanent"`, so the
    // initiator can send more than one file to the same already-claimed
    // link — the claimant must see all of them, not just an arbitrary first
    // one (`link.drops[0]`, which the underlying query doesn't even order).
    it("exposes every outstanding drop (plural `drops`) to the claimant when the initiator sends more than one file", async () => {
      const server = buildServer();
      const { slug, link } = await requestAndClaim(server, "e2einitiator3");
      const first = await createSentDrop(link.id);
      const second = await createSentDrop(link.id);

      const res = await server.inject({ method: "GET", url: `/api/links/${slug}` });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.drops.map((d: { id: string }) => d.id).sort()).toEqual([first.id, second.id].sort());
      // The legacy singular field is still present too, for any consumer still reading it.
      expect(body.drop).not.toBeNull();
    });
  });

  describe("POST /api/links/:slug/revoke, /unrevoke, and PATCH /api/links/:slug", () => {
    it("lets the owner revoke and unrevoke their own link", async () => {
      const server = buildServer();
      const { cookies } = await registerAndGetCookie(server, "revoker");
      await prisma.user.update({ where: { username: "revoker" }, data: { emailVerified: true } });
      const create = await server.inject({
        method: "POST", url: "/api/links/custom", cookies,
        payload: { slug: "revoke-me", mode: "permanent" },
      });
      expect(create.statusCode).toBe(200);

      const revoke = await server.inject({ method: "POST", url: "/api/links/revoke-me/revoke", cookies });
      expect(revoke.statusCode).toBe(200);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug: "revoke-me" } });
      expect(link.revokedAt).not.toBeNull();

      const unrevoke = await server.inject({ method: "POST", url: "/api/links/revoke-me/unrevoke", cookies });
      expect(unrevoke.statusCode).toBe(200);
      const relinked = await prisma.link.findUniqueOrThrow({ where: { slug: "revoke-me" } });
      expect(relinked.revokedAt).toBeNull();
    });

    it("rejects revoke from a non-owner", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "owner1");
      await prisma.user.update({ where: { username: "owner1" }, data: { emailVerified: true } });
      await server.inject({ method: "POST", url: "/api/links/custom", cookies: owner.cookies, payload: { slug: "not-yours", mode: "permanent" } });

      const stranger = await registerAndGetCookie(server, "stranger1");
      const attempt = await server.inject({ method: "POST", url: "/api/links/not-yours/revoke", cookies: stranger.cookies });
      expect(attempt.statusCode).toBe(403);
    });

    // Finding F6: requireOwnedLink (the shared owner-check helper behind
    // revoke/unrevoke/PATCH) must mask a contacts-only link from a
    // non-contact caller the same way DELETE /:slug and GET .../drops
    // already do — a distinguishing 403 leaks that a link with this slug
    // exists and is owned/contacts-only. shouldMaskAsNotFound (lib/links.ts)
    // already returns false for the true owner, so the owner-only tests
    // above are unaffected, and "rejects revoke from a non-owner" above
    // (a public-visibility link, the default for /api/links/custom) confirms
    // masking does NOT apply when existence isn't secret.
    it("masks revoke from a non-contact caller on a contacts-only link, byte-identical to a nonexistent slug", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "revokeownerco");
      await prisma.user.update({ where: { username: "revokeownerco" }, data: { emailVerified: true } });
      const link = await prisma.link.create({
        data: {
          ownerId: owner.userId,
          slug: "owner-revoke-co",
          mode: "permanent",
          visibility: "contacts-only",
          recipientPublicKey: owner.publicKey,
          retentionDays: 7,
        },
      });
      const stranger = await registerAndGetCookie(server, "revokestrangerco");

      const masked = await server.inject({
        method: "POST",
        url: `/api/links/${link.slug}/revoke`,
        cookies: stranger.cookies,
      });
      const nonexistent = await server.inject({
        method: "POST",
        url: "/api/links/does-not-exist-revokeco/revoke",
        cookies: stranger.cookies,
      });

      expect(masked.statusCode).toBe(404);
      expect(masked.statusCode).toBe(nonexistent.statusCode);
      expect(masked.json()).toEqual(nonexistent.json());
      expect((await prisma.link.findUniqueOrThrow({ where: { id: link.id } })).revokedAt).toBeNull();
    });

    it("lets the owner change visibility via PATCH", async () => {
      const server = buildServer();
      const { cookies } = await registerAndGetCookie(server, "patcher");
      await prisma.user.update({ where: { username: "patcher" }, data: { emailVerified: true } });
      await server.inject({ method: "POST", url: "/api/links/custom", cookies, payload: { slug: "patch-me", mode: "permanent" } });

      const patch = await server.inject({ method: "PATCH", url: "/api/links/patch-me", cookies, payload: { visibility: "contacts-only" } });
      expect(patch.statusCode).toBe(200);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug: "patch-me" } });
      expect(link.visibility).toBe("contacts-only");
    });

    it("rejects an unowned (anonymous) link revoke with 403, never a silent success", async () => {
      const server = buildServer();
      const anon = await server.inject({ method: "POST", url: "/api/links", payload: { recipientPublicKey: fakePublicKey("anon-pk") } });
      const slug = anon.json().slug as string;
      const { cookies } = await registerAndGetCookie(server, "someuser");
      const revoke = await server.inject({ method: "POST", url: `/api/links/${slug}/revoke`, cookies });
      expect(revoke.statusCode).toBe(403);
    });

    // F2: revoke previously only set revokedAt, leaving a sealed, already-uploaded
    // drop's content (and message) fully reachable through download-url/reveal-message
    // until the passive cleanup sweep eventually caught it. Revoke now shreds such a
    // drop immediately (mirroring owner-cancel's scrubDropContent path exactly), and
    // downloads.ts's receive-side routes now gate on isLinkInactive (which covers
    // revokedAt), so both defenses apply here.
    it("shreds a sealed, complete drop on revoke, and 404s download-url/reveal-message on it afterward", async () => {
      const server = buildServer();
      const { cookies } = await registerAndGetCookie(server, "revoke-shred-owner");
      await prisma.user.update({ where: { username: "revoke-shred-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST", url: "/api/links/custom", cookies,
        payload: { slug: "revoke-shred-link", mode: "permanent" },
      });
      const link = await prisma.link.findUniqueOrThrow({ where: { slug: "revoke-shred-link" } });
      const drop = await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: fakePublicKey("c2VuZGVy"),
          s3Key: `${link.id}/revoke-shred-drop`,
          archiveNonce: "YXJjaGl2ZQ==",
          contentMD5: "bWQ1",
          encryptedMetadata: "bWV0YWRhdGE=",
          metadataNonce: "bWV0YS1ub25jZQ==",
          fileSize: 1024,
          fileUploadStatus: "complete",
          deliveryStatus: "sent",
          encryptedMessage: "c2VjcmV0",
          messageNonce: "bm9uY2U=",
        },
      });

      const revoke = await server.inject({ method: "POST", url: "/api/links/revoke-shred-link/revoke", cookies });
      expect(revoke.statusCode).toBe(200);

      expect(deleteObjectMock).toHaveBeenCalledWith(drop.s3Key);
      const after = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
      expect(after.fileEnvelopeStatus).toBe("shredded");
      // The row survives as an audit trail — never hard-deleted by revoke.
      expect(after.id).toBe(drop.id);

      // The owner is also this normal owned link's recipient (canReceive allows the
      // true owner here), so without isLinkInactive gating these receive-side routes
      // would still have served the (now-shredded) drop's stale metadata/message.
      const downloadUrl = await server.inject({
        method: "GET",
        url: `/api/links/revoke-shred-link/download-url?dropId=${drop.id}`,
        cookies,
      });
      expect(downloadUrl.statusCode).toBe(404);

      const reveal = await server.inject({
        method: "POST",
        url: `/api/links/revoke-shred-link/drops/${drop.id}/reveal-message`,
        cookies,
      });
      expect(reveal.statusCode).toBe(404);
    });

    // Task 1 is deliberately scoped to receive-side routes only: unrevoke, PATCH,
    // owner-cancel, and DELETE are true owner-management routes and must stay
    // reachable on a revoked link by design (an owner must always be able to
    // reverse or clean up their own revoked link).
    it("keeps unrevoke, PATCH, owner-cancel, and DELETE reachable on a revoked link", async () => {
      const server = buildServer();
      const { cookies } = await registerAndGetCookie(server, "revoke-mgmt-owner");
      await prisma.user.update({ where: { username: "revoke-mgmt-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST", url: "/api/links/custom", cookies,
        payload: { slug: "revoke-mgmt-link", mode: "permanent" },
      });
      const link = await prisma.link.findUniqueOrThrow({ where: { slug: "revoke-mgmt-link" } });

      const revoke = await server.inject({ method: "POST", url: "/api/links/revoke-mgmt-link/revoke", cookies });
      expect(revoke.statusCode).toBe(200);

      const unrevoke = await server.inject({ method: "POST", url: "/api/links/revoke-mgmt-link/unrevoke", cookies });
      expect(unrevoke.statusCode).toBe(200);
      expect((await prisma.link.findUniqueOrThrow({ where: { id: link.id } })).revokedAt).toBeNull();

      // Re-revoke, then confirm PATCH/owner-cancel/DELETE all still reach their own
      // logic on a revoked link (rather than being 404'd pre-emptively).
      await server.inject({ method: "POST", url: "/api/links/revoke-mgmt-link/revoke", cookies });

      const patch = await server.inject({
        method: "PATCH",
        url: "/api/links/revoke-mgmt-link",
        cookies,
        payload: { visibility: "contacts-only" },
      });
      expect(patch.statusCode).toBe(200);

      // Added after revoke, so revoke's own shred loop never touched it.
      const drop = await createSentDrop(link.id);
      const cancel = await server.inject({
        method: "POST",
        url: `/api/links/revoke-mgmt-link/drops/${drop.id}/owner-cancel`,
        cookies,
      });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json()).toEqual({ cancelled: true });
      expect((await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } })).fileEnvelopeStatus).toBe("shredded");

      const del = await server.inject({ method: "DELETE", url: "/api/links/revoke-mgmt-link", cookies });
      expect(del.statusCode).toBe(200);
      expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
    });
  });

  describe("GET /api/links/:slug enforces contacts-only visibility and link inactivity", () => {
    it("404s a contacts-only link for an anonymous requester", async () => {
      const server = buildServer();
      const { cookies } = await registerAndGetCookie(server, "co-owner");
      await prisma.user.update({ where: { username: "co-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies,
        payload: { slug: "co-link", mode: "permanent", visibility: "contacts-only" },
      });

      const anonView = await server.inject({ method: "GET", url: "/api/links/co-link" });
      expect(anonView.statusCode).toBe(404);
    });

    it("shows a contacts-only link to an accepted contact", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "co-owner2");
      await prisma.user.update({ where: { username: "co-owner2" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies: owner.cookies,
        payload: { slug: "co-link2", mode: "permanent", visibility: "contacts-only" },
      });

      const friend = await registerAndGetCookie(server, "co-friend");
      const req = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: friend.cookies,
        payload: { username: "co-owner2" },
      });
      await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/accept`, cookies: owner.cookies });

      const friendView = await server.inject({
        method: "GET",
        url: "/api/links/co-link2",
        cookies: friend.cookies,
      });
      expect(friendView.statusCode).toBe(200);
    });

    it("404s a revoked link on GET", async () => {
      const server = buildServer();
      const { cookies } = await registerAndGetCookie(server, "revoke-view");
      await prisma.user.update({ where: { username: "revoke-view" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies,
        payload: { slug: "revoke-view-link", mode: "permanent" },
      });
      await server.inject({ method: "POST", url: "/api/links/revoke-view-link/revoke", cookies });

      const view = await server.inject({ method: "GET", url: "/api/links/revoke-view-link" });
      expect(view.statusCode).toBe(404);
    });

    // Scope addition to this plan (decided post-final-review): a block
    // relationship must override visibility entirely, on BOTH public and
    // contacts-only links, and must produce a 404 byte-identical to a
    // genuinely nonexistent link — mirroring the masking discipline already
    // used for the POST /api/contacts path (contacts.test.ts's block tests).
    it("404s a PUBLIC link for a requester who blocked the owner", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "block-pub-owner");
      await prisma.user.update({ where: { username: "block-pub-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies: owner.cookies,
        payload: { slug: "block-pub-link", mode: "permanent", visibility: "public" },
      });

      const blocker = await registerAndGetCookie(server, "block-pub-blocker");
      const req = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: blocker.cookies,
        payload: { username: "block-pub-owner" },
      });
      const block = await server.inject({
        method: "POST",
        url: `/api/contacts/${req.json().id}/block`,
        cookies: blocker.cookies,
      });
      expect(block.statusCode).toBe(200);

      const view = await server.inject({
        method: "GET",
        url: "/api/links/block-pub-link",
        cookies: blocker.cookies,
      });
      expect(view.statusCode).toBe(404);
    });

    it("404s a PUBLIC link for a requester the owner blocked (other direction)", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "block-pub-owner2");
      await prisma.user.update({ where: { username: "block-pub-owner2" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies: owner.cookies,
        payload: { slug: "block-pub-link2", mode: "permanent", visibility: "public" },
      });

      const blocked = await registerAndGetCookie(server, "block-pub-blocked2");
      const req = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: owner.cookies,
        payload: { username: "block-pub-blocked2" },
      });
      const block = await server.inject({
        method: "POST",
        url: `/api/contacts/${req.json().id}/block`,
        cookies: owner.cookies,
      });
      expect(block.statusCode).toBe(200);

      const view = await server.inject({
        method: "GET",
        url: "/api/links/block-pub-link2",
        cookies: blocked.cookies,
      });
      expect(view.statusCode).toBe(404);
    });

    it("404s a CONTACTS-ONLY link for a block, even between parties who were previously accepted contacts", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "block-co-owner");
      await prisma.user.update({ where: { username: "block-co-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies: owner.cookies,
        payload: { slug: "block-co-link", mode: "permanent", visibility: "contacts-only" },
      });

      const friend = await registerAndGetCookie(server, "block-co-friend");
      const req = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: friend.cookies,
        payload: { username: "block-co-owner" },
      });
      await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/accept`, cookies: owner.cookies });

      // Confirm the contacts-only link is visible to the accepted contact
      // BEFORE the block, so the later 404 is provably caused by the block
      // check and not merely a duplicate of the existing non-contact 404.
      const beforeBlock = await server.inject({
        method: "GET",
        url: "/api/links/block-co-link",
        cookies: friend.cookies,
      });
      expect(beforeBlock.statusCode).toBe(200);

      const block = await server.inject({
        method: "POST",
        url: `/api/contacts/${req.json().id}/block`,
        cookies: owner.cookies,
      });
      expect(block.statusCode).toBe(200);

      const afterBlock = await server.inject({
        method: "GET",
        url: "/api/links/block-co-link",
        cookies: friend.cookies,
      });
      expect(afterBlock.statusCode).toBe(404);
    });

    it("GET/POST consistency: after a block, both the link GET and the contact POST look identical to a nonexistent target", async () => {
      // Mirrors contacts.test.ts's "blocks an incoming pending request, and
      // the blocked party sees the same error as a nonexistent user on
      // retry" pattern, extended to also assert the link GET side, in one
      // test that proves both paths are consistent WITH EACH OTHER, not
      // just individually correct.
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "consist-owner");
      await prisma.user.update({ where: { username: "consist-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies: owner.cookies,
        payload: { slug: "consist-link", mode: "permanent", visibility: "public" },
      });

      const blocked = await registerAndGetCookie(server, "consist-blocked");
      const req = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: blocked.cookies,
        payload: { username: "consist-owner" },
      });
      const block = await server.inject({
        method: "POST",
        url: `/api/contacts/${req.json().id}/block`,
        cookies: owner.cookies,
      });
      expect(block.statusCode).toBe(200);

      // (a) GET on the blocked party's link vs. GET on a genuinely nonexistent slug.
      const getBlocked = await server.inject({
        method: "GET",
        url: "/api/links/consist-link",
        cookies: blocked.cookies,
      });
      const getNonexistent = await server.inject({
        method: "GET",
        url: "/api/links/does-not-exist-slug",
        cookies: blocked.cookies,
      });
      expect(getBlocked.statusCode).toBe(getNonexistent.statusCode);
      expect(getBlocked.json()).toEqual(getNonexistent.json());

      // (b) POST /api/contacts to the blocked-against owner vs. POST to a
      // genuinely nonexistent username. Fix A doesn't touch this path, but
      // it's asserted here too so this single test proves consistency
      // across both endpoints, not just within each one.
      const postBlocked = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: blocked.cookies,
        payload: { username: "consist-owner" },
      });
      const postNonexistent = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: blocked.cookies,
        payload: { username: "does-not-exist-user" },
      });
      expect(postBlocked.statusCode).toBe(postNonexistent.statusCode);
      expect(postBlocked.json()).toEqual(postNonexistent.json());
    });

    it("does not affect an anonymous (no session) requester viewing a public link, even if a block exists between the owner and some other user", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "anon-owner");
      await prisma.user.update({ where: { username: "anon-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies: owner.cookies,
        payload: { slug: "anon-link", mode: "permanent", visibility: "public" },
      });

      const someone = await registerAndGetCookie(server, "anon-someone");
      const req = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: someone.cookies,
        payload: { username: "anon-owner" },
      });
      await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/block`, cookies: owner.cookies });

      // No cookies at all: an anonymous visitor with nothing to check a block
      // against must see the public link normally.
      const anonView = await server.inject({ method: "GET", url: "/api/links/anon-link" });
      expect(anonView.statusCode).toBe(200);
    });

    it("never 404s the link owner's own view, even in the presence of a block against some other user", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "self-owner");
      await prisma.user.update({ where: { username: "self-owner" }, data: { emailVerified: true } });
      await server.inject({
        method: "POST",
        url: "/api/links/custom",
        cookies: owner.cookies,
        payload: { slug: "self-link", mode: "permanent", visibility: "contacts-only" },
      });

      const someone = await registerAndGetCookie(server, "self-someone");
      const req = await server.inject({
        method: "POST",
        url: "/api/contacts",
        cookies: someone.cookies,
        payload: { username: "self-owner" },
      });
      await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/block`, cookies: owner.cookies });

      const ownerView = await server.inject({
        method: "GET",
        url: "/api/links/self-link",
        cookies: owner.cookies,
      });
      expect(ownerView.statusCode).toBe(200);
    });
  });

  describe("GET /api/links", () => {
    it("requires authentication", async () => {
      const server = buildServer();
      const response = await server.inject({ method: "GET", url: "/api/links" });
      expect(response.statusCode).toBe(403);
    });

    it("returns only the caller's own links, not another owner's or an anonymous one", async () => {
      const server = buildServer();
      const alice = await registerAndGetCookie(server, "alice-links-list");
      const bob = await registerAndGetCookie(server, "bob-links-list");

      await prisma.link.create({
        data: { ownerId: bob.userId, slug: "bobs-custom-link", mode: "permanent", recipientPublicKey: bob.publicKey, retentionDays: 7 },
      });
      await prisma.link.create({
        data: { slug: "anon-link-not-mine", mode: "one-time", recipientPublicKey: fakePublicKey("x"), expiresAt: new Date(Date.now() + 3600_000), retentionDays: 1 },
      });

      const response = await server.inject({
        method: "GET",
        url: "/api/links",
        cookies: alice.cookies,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { links: Array<{ slug: string }> };
      const slugs = body.links.map((l) => l.slug);
      expect(slugs).toContain("alice-links-list"); // the default link created at registration
      expect(slugs).not.toContain("bobs-custom-link");
      expect(slugs).not.toContain("anon-link-not-mine");
    });

    it("reports revokedAt and lastSenderOpenedAt when set, omits them when not", async () => {
      const server = buildServer();
      const carol = await registerAndGetCookie(server, "carol-links-list");
      const now = new Date();
      await prisma.link.update({
        where: { slug: "carol-links-list" },
        data: { lastSenderOpenedAt: now },
      });

      const response = await server.inject({ method: "GET", url: "/api/links", cookies: carol.cookies });
      const body = response.json() as { links: Array<{ slug: string; revokedAt?: number; lastSenderOpenedAt?: number }> };
      const mine = body.links.find((l) => l.slug === "carol-links-list")!;
      expect(mine.lastSenderOpenedAt).toBe(now.getTime());
      expect(mine.revokedAt).toBeUndefined();
    });

    // Review finding F1: the dashboard shows the owner a locally derived
    // phrase only for links whose recipient key is the owner's own —
    // never for a sender-initiated request link, whose recipient key (once
    // claimed) belongs to the claimant.
    it("reports recipientIsOwner, linkId and codewordLocale per link", async () => {
      const server = buildServer();
      const dave = await registerAndGetCookie(server, "dave-links-list");
      const custom = await prisma.link.create({
        data: { ownerId: dave.userId, slug: "daves-custom", mode: "permanent", recipientPublicKey: dave.publicKey, retentionDays: 7 },
      });
      await prisma.link.create({
        data: { ownerId: dave.userId, slug: "daves-request-unclaimed", mode: "permanent", recipientPublicKey: null, retentionDays: 7 },
      });
      await prisma.link.create({
        data: { ownerId: dave.userId, slug: "daves-request-claimed", mode: "permanent", recipientPublicKey: fakePublicKey("claimant-pk"), retentionDays: 7 },
      });

      const response = await server.inject({ method: "GET", url: "/api/links", cookies: dave.cookies });
      const body = response.json() as {
        links: Array<{ slug: string; linkId: string; codewordLocale: string; recipientIsOwner: boolean }>;
      };
      const bySlug = Object.fromEntries(body.links.map((l) => [l.slug, l]));
      expect(bySlug["dave-links-list"].recipientIsOwner).toBe(true); // default link
      expect(bySlug["daves-custom"].recipientIsOwner).toBe(true);
      expect(bySlug["daves-custom"].linkId).toBe(custom.id);
      expect(bySlug["daves-custom"].codewordLocale).toBe("en");
      expect(bySlug["daves-request-unclaimed"].recipientIsOwner).toBe(false);
      expect(bySlug["daves-request-claimed"].recipientIsOwner).toBe(false);
    });
  });
});
