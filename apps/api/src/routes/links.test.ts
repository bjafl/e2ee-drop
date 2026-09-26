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
import { subscribeToLink, type DropEvent } from "../lib/dropEvents";

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

// Creates a Drop against the current schema. Mirrors the fields uploads.ts's
// /complete route actually writes, with fileUploadStatus/deliveryStatus set
// directly to their post-upload values so these tests don't need to drive a
// full upload-url + complete round trip just to reach that state.
async function createLinkWithDrop(slug: string, expiresAt: Date) {
  const link = await prisma.link.create({
    data: { slug, mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt },
  });
  const drop = await prisma.drop.create({
    data: {
      linkId: link.id,
      senderPublicKey: "c2VuZGVy",
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
      senderPublicKey: "c2VuZGVy",
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

  it("rejects a numeric recipientPublicKey on POST /api/links with 400 (not 500) via the route's JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: 12345 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects retentionDays above the anonymous one-time link's own expiry", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "pk", retentionDays: 999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stores ownerNote on an anonymous link and returns it from GET", async () => {
    const server = buildServer();
    const create = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "pk", ownerNote: "please send the invoice" },
    });
    expect(create.statusCode).toBe(200);
    const { slug } = create.json();
    const get = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(get.json().ownerNote).toBe("please send the invoice");
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
        retentionDays: 7,
      },
    });
    const older = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "a",
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
        senderPublicKey: "b",
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
        senderPublicKey: "c",
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
          senderPublicKey: "c2VuZGVy",
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

    it("returns drop: null to an anonymous stranger on a contacts-only owned link with an in-progress drop", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim");
      const { link, drop } = await createOwnedLinkWithDrop(
        owner.userId,
        "leak-contacts",
        "contacts-only",
        "uploading",
        owner.publicKey
      );

      const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });

      expect(response.statusCode).toBe(200);
      expect(response.json().drop).toBeNull();
      expectNoLeak(response.body, drop);
    });

    it("returns drop: null on a public owned link with an uploaded drop, including to a logged-in non-owner", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "leakvictim2");
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
      const link = await prisma.link.findFirstOrThrow({ where: { ownerId: owner.userId, isDefault: true } });
      const drop = await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: "c2VuZGVy",
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
          recipientPublicKey: "x",
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
          recipientPublicKey: "x",
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
        payload: { recipientPublicKey: "claimant-pubkey" },
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
        payload: { recipientPublicKey: "claimant-pubkey" },
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
  });

  describe("POST /api/links/request", () => {
    it("creates an unclaimed link owned by the authenticated user", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "requester");

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
  });

  describe("POST /api/links/:slug/claim", () => {
    it("claims an unclaimed link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner1");
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
        payload: { recipientPublicKey: "recipient-pk" },
      });
      expect(res.statusCode).toBe(200);
      const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
      expect(status.json().recipientPublicKey).toBe("recipient-pk");
    });

    it("rejects claiming an already-claimed link", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner2");
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
        payload: { recipientPublicKey: "first" },
      });
      const second = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: "second" },
      });
      expect(second.statusCode).toBe(409);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      expect(link.recipientPublicKey).toBe("first");
    });

    it("rejects claiming a link that already had a recipient key (recipient-initiated flow)", async () => {
      const server = buildServer();
      const createRes = await server.inject({
        method: "POST",
        url: "/api/links",
        payload: { recipientPublicKey: "already-set" },
      });
      const { slug } = createRes.json();

      const res = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: "x" },
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
        payload: { recipientPublicKey: "x" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("resolves true concurrency to exactly one winner", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimowner4");
      const requestRes = await server.inject({
        method: "POST",
        url: "/api/links/request",
        payload: {},
        cookies: owner.cookies,
      });
      const { slug } = requestRes.json();
      const url = `/api/links/${slug}/claim`;

      const [a, b] = await Promise.all([
        server.inject({ method: "POST", url, payload: { recipientPublicKey: "racer-a" } }),
        server.inject({ method: "POST", url, payload: { recipientPublicKey: "racer-b" } }),
      ]);

      const statusCodes = [a.statusCode, b.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      expect(["racer-a", "racer-b"]).toContain(link.recipientPublicKey);
    });

    // Finding I6: design spec §4.2 — /send/:slug detects a claim over the
    // existing per-link SSE channel. Only emitted once the CAS actually wins.
    it("emits a link-claimed SSE event once the claim CAS wins, and not on a losing claim", async () => {
      const server = buildServer();
      const owner = await registerAndGetCookie(server, "claimeventowner");
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
        payload: { recipientPublicKey: "claimant-pubkey" },
      });
      const second = await server.inject({
        method: "POST",
        url: `/api/links/${slug}/claim`,
        payload: { recipientPublicKey: "someone-elses-key" },
      });
      unsubscribe();

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(events).toEqual([{ type: "link-claimed", recipientPublicKey: "claimant-pubkey" }]);
    });
  });

  // Finding C1 end-to-end: the sender-initiated flow must actually deliver
  // something — the claimant (not the initiator) can see the drop via the
  // same unauthenticated GET the anonymous flow uses.
  describe("finding C1: sender-initiated flow is reachable end-to-end via GET /api/links/:slug", () => {
    async function requestAndClaim(server: ReturnType<typeof buildServer>, username: string) {
      const initiator = await registerAndGetCookie(server, username);
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
        payload: { recipientPublicKey: "claimant-pubkey" },
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
      const anon = await server.inject({ method: "POST", url: "/api/links", payload: { recipientPublicKey: "anon-pk" } });
      const slug = anon.json().slug as string;
      const { cookies } = await registerAndGetCookie(server, "someuser");
      const revoke = await server.inject({ method: "POST", url: `/api/links/${slug}/revoke`, cookies });
      expect(revoke.statusCode).toBe(403);
    });
  });
});
