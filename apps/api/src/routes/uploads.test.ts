// apps/api/src/routes/uploads.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

const { getSignedUploadUrlSpy, objectHasSizeSpy, deleteObjectSpy } = vi.hoisted(() => ({
  getSignedUploadUrlSpy: vi.fn(),
  objectHasSizeSpy: vi.fn(),
  deleteObjectSpy: vi.fn().mockResolvedValue(undefined),
}));

// /complete HEAD-verifies the upload (objectHasSize). These tests never PUT
// real bytes, so the spy reports every object as present unless a test says
// otherwise; completeVerification.test.ts exercises the real HEAD against
// bytes actually uploaded to MinIO. deleteObject is mocked so /abandon tests
// (finding I2) can assert it was — or was not — called, without touching
// real MinIO.
vi.mock("../lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/storage")>();
  getSignedUploadUrlSpy.mockImplementation(original.getSignedUploadUrl);
  return {
    ...original,
    getSignedUploadUrl: getSignedUploadUrlSpy,
    objectHasSize: objectHasSizeSpy,
    deleteObject: deleteObjectSpy,
  };
});

import { buildServer } from "../server";
import { subscribeToLink, type DropEvent } from "../lib/dropEvents";

// The brief this suite was drafted from used a placeholder `x-test-user-id`
// header to fake `request.user` in .inject() calls; that header doesn't exist
// in this codebase's real auth plugin (apps/api/src/plugins/auth.ts) —
// request.user is populated only from a signed SESSION_COOKIE_NAME cookie
// (see apps/api/src/lib/sessions.ts). Per contacts.test.ts's and
// links.test.ts's established pattern, each authenticated test here registers
// a REAL user via POST /api/auth/register and reuses that user's real session
// cookie.
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
  return { userId: response.json().userId as string, cookies: { e2ee_drop_session: cookie.value } };
}

const validMetadata = {
  fileSize: 1024,
  contentMD5: "bWQ1",
};

// Body for POST /api/links/:slug/upload-url (RequestUploadUrlRequest, three-envelope shape —
// see packages/shared/src/api.ts). A test overrides only the field(s) it cares about.
function uploadPayload(overrides: Record<string, unknown> = {}) {
  return {
    senderPublicKey: "c2VuZGVy",
    archiveNonce: "YXJjaGl2ZS1ub25jZQ==",
    encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
    metadataNonce: "bWV0YWRhdGEtbm9uY2U=",
    metadata: validMetadata,
    ...overrides,
  };
}

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
    // Users too (same order as contacts.test.ts): several tests register
    // fixed usernames, which would collide on a re-run of this file alone.
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    objectHasSizeSpy.mockReset();
    objectHasSizeSpy.mockResolvedValue(true);
    deleteObjectSpy.mockReset();
    deleteObjectSpy.mockResolvedValue(undefined);
  });

  it("issues an upload url and creates a drop for a fresh link", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dropId).toBeTruthy();
    expect(body.uploadUrl).toContain("http");
  });

  it("rejects a numeric senderPublicKey with 400 (not 500) via the route's JSON-schema body validation", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload({ senderPublicKey: 12345 }),
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.drop.count({ where: { link: { slug } } })).toBe(0);
  });

  it("signs the upload url for exactly the NaCl box ciphertext length (fileSize + 16)", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    getSignedUploadUrlSpy.mockClear();

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
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
      payload: uploadPayload({ metadata: { ...validMetadata, fileSize } }),
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
      payload: uploadPayload({ metadata: { ...validMetadata, fileSize: 999_999_999_999 } }),
    });

    expect(response.statusCode).toBe(413);
  });

  it("rejects a second upload-url request once a drop already exists", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const first = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload({ senderPublicKey: "c2VuZGVyMg==" }),
    });
    expect(second.statusCode).toBe(409);

    const drops = await prisma.drop.findMany({ where: { link: { slug } } });
    expect(drops).toHaveLength(1);
  });

  it("allows a second upload-url request on a permanent link (queueing)", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: { slug: "permanent-queue-test", mode: "permanent", recipientPublicKey: "cmVjaXBpZW50", retentionDays: 7 },
    });

    const first = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload(),
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload({ senderPublicKey: "c2VuZGVyMg==" }),
    });
    expect(second.statusCode).toBe(200);

    const drops = await prisma.drop.findMany({ where: { linkId: link.id } });
    expect(drops).toHaveLength(2);
  });

  it("still rejects a second upload-url request on a one-time link", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const first = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload({ senderPublicKey: "c2VuZGVyMg==" }),
    });
    expect(second.statusCode).toBe(409);
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
          body: JSON.stringify(uploadPayload()),
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

  it("accepts every one of many concurrent upload-url requests on the same permanent link", async () => {
    // Real sockets for the same reason as the one-time race test above: inject()
    // doesn't reliably overlap handlers, and this needs genuinely concurrent inserts.
    const server = buildServer();
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const link = await prisma.link.create({
        data: { slug: "permanent-burst-test", mode: "permanent", recipientPublicKey: "cmVjaXBpZW50", retentionDays: 7 },
      });

      const fire = () =>
        fetch(`${baseUrl}/api/links/${link.slug}/upload-url`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(uploadPayload()),
        });

      const CONCURRENT_REQUESTS = 12;
      const responses = await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, fire));
      expect(responses.map((r) => r.status)).toEqual(Array(CONCURRENT_REQUESTS).fill(200));

      const dropIds = await Promise.all(responses.map(async (r) => (await r.json()).dropId as string));
      expect(new Set(dropIds).size).toBe(CONCURRENT_REQUESTS);

      const drops = await prisma.drop.findMany({ where: { linkId: link.id } });
      expect(drops).toHaveLength(CONCURRENT_REQUESTS);
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
    // validation (`!senderPublicKey || !archiveNonce || !metadata?.contentMD5 || ...`), not
    // just prove the guard exists.
    const server = buildServer();
    const slug = await createLink(server);

    const { archiveNonce: _omittedArchiveNonce, ...payloadWithoutArchiveNonce } = uploadPayload();

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: payloadWithoutArchiveNonce,
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
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload(),
    });

    expect(response.statusCode).toBe(404);
    // Deletion is cleanup's job: deleting the row here would lose the s3Key and
    // orphan any storage object belonging to the link.
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
  });

  it("accepts an opaque encryptedMessage/messageNonce pair without inspecting it", async () => {
    // The message is now opaque ciphertext (design spec §3.1/§5) — the server never reads or
    // sanitizes it (replaces the old "truncates a message..." test, which exercised the
    // removed sanitizeMessage()).
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload({ encryptedMessage: "ZW5jcnlwdGVkLW1lc3NhZ2U=", messageNonce: "bWVzc2FnZS1ub25jZQ==" }),
    });

    expect(response.statusCode).toBe(200);
    const drop = await prisma.drop.findFirst({ where: { link: { slug } } });
    expect(drop?.encryptedMessage).toBe("ZW5jcnlwdGVkLW1lc3NhZ2U=");
    expect(drop?.messageNonce).toBe("bWVzc2FnZS1ub25jZQ==");
  });

  it("rejects encryptedMessage without messageNonce (and vice versa)", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const missingNonce = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload({ encryptedMessage: "ZW5jcnlwdGVkLW1lc3NhZ2U=" }),
    });
    expect(missingNonce.statusCode).toBe(400);

    const missingMessage = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload({ messageNonce: "bWVzc2FnZS1ub25jZQ==" }),
    });
    expect(missingMessage.statusCode).toBe(400);

    expect(await prisma.drop.count({ where: { link: { slug } } })).toBe(0);
  });

  it("marks a drop as complete via the complete endpoint", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    const uploadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });
    const { dropId } = uploadRes.json();

    const completeRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete`,
    });
    expect(completeRes.statusCode).toBe(200);

    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileUploadStatus).toBe("complete");
  });

  it("sets deliveryStatus to sent when complete succeeds", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    const uploadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });
    const { dropId } = uploadRes.json();

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete`,
    });
    expect(res.statusCode).toBe(200);

    const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(status.json().drop.deliveryStatus).toBe("sent");
  });

  async function createLinkWithUploadingDrop(server: ReturnType<typeof buildServer>) {
    const slug = await createLink(server);
    const uploadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
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
    expect(drop?.fileUploadStatus).toBe("uploading");
  });

  it("answers a repeat complete on an already-complete drop idempotently with 200", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    const first = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ updated: true });

    const second = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ updated: false });
  });

  it("verifies the drop's object at its s3Key for exactly fileSize + 16 bytes, and 409s without changing it if absent", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    const { s3Key } = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    objectHasSizeSpy.mockResolvedValue(false);

    const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });

    expect(res.statusCode).toBe(409);
    expect(objectHasSizeSpy).toHaveBeenCalledWith(s3Key, validMetadata.fileSize + 16);
    expect((await prisma.drop.findUnique({ where: { id: dropId } }))?.fileUploadStatus).toBe("uploading");
  });

  it("does not re-run a late complete call on an already-complete drop", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    await prisma.drop.update({ where: { id: dropId }, data: { fileUploadStatus: "complete", deliveryStatus: "sent" } });

    const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });

    // Idempotent success (the drop did complete, earlier), not a regression.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: false });
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileUploadStatus).toBe("complete");
    expect(drop?.deliveryStatus).toBe("sent");
  });

  it("returns 404 when completing a drop on an expired link", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    await prisma.link.updateMany({ where: { slug }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });

    expect(res.statusCode).toBe(404);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileUploadStatus).toBe("uploading");
  });

  it("abandon deletes a still-uploading drop and frees a one-time link's slot", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });

    const abandon = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/abandon`,
    });
    expect(abandon.statusCode).toBe(200);
    expect(abandon.json()).toEqual({ abandoned: true });
    expect(await prisma.drop.findUnique({ where: { id: dropId } })).toBeNull();
    // Finding I2: a PUT can already have landed in storage by the time abandon is
    // called; without deleting the object, the row — the only record of its
    // s3Key — is gone the moment abandon succeeds, orphaning the object forever.
    expect(deleteObjectSpy).toHaveBeenCalledTimes(1);
    expect(deleteObjectSpy).toHaveBeenCalledWith(drop.s3Key);

    // A fresh upload-url call must now succeed again (the slot was freed).
    const retry = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });
    expect(retry.statusCode).toBe(200);
  });

  it("abandon does nothing to an already-complete drop, and never calls deleteObject", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    const complete = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
    expect(complete.statusCode).toBe(200);
    deleteObjectSpy.mockClear();

    const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/abandon` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ abandoned: false });
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileUploadStatus).toBe("complete");
    // Must never delete a completed drop's real, already-served object.
    expect(deleteObjectSpy).not.toHaveBeenCalled();
  });

  it("does nothing when abandoning via a link the drop does not belong to (scoped CAS, not a lookup), and never calls deleteObject", async () => {
    const server = buildServer();
    const { dropId } = await createLinkWithUploadingDrop(server);
    const otherSlug = await createLink(server);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${otherSlug}/drops/${dropId}/abandon`,
    });

    // The other link exists and is valid, so this is a harmless no-op (200, abandoned:false),
    // not a 404 — same reasoning as an unknown dropId (see the deleteMany's linkId scoping).
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ abandoned: false });
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileUploadStatus).toBe("uploading");
    expect(deleteObjectSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when abandoning a drop on an expired link, and never calls deleteObject", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithUploadingDrop(server);
    await prisma.link.updateMany({ where: { slug }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/abandon` });

    expect(res.statusCode).toBe(404);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileUploadStatus).toBe("uploading");
    expect(deleteObjectSpy).not.toHaveBeenCalled();
  });

  it("emits drop-created on upload-url and drop-updated(complete) on a successful complete only", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

    const uploadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });
    const { dropId } = uploadRes.json();
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
    // A second complete is an idempotent 200 (already "complete") and must not emit.
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
    // A rejected second upload on a one-time link must not emit either.
    await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });
    unsubscribe();

    // This route never emits "link-claimed" (that's POST /api/links/:slug/claim,
    // see routes/links.test.ts), so narrowing to the drop-carrying variants here
    // is safe and lets the map below access `.drop` without a per-element guard.
    const dropEvents = events as Exclude<DropEvent, { type: "link-claimed" }>[];
    expect(dropEvents.map((e) => [e.type, e.drop.id, e.drop.fileUploadStatus, e.drop.deliveryStatus])).toEqual([
      ["drop-created", dropId, "uploading", "sender_opened"],
      ["drop-updated", dropId, "complete", "sent"],
    ]);
  });

  it("rejects an anonymous sender on a contacts-only link", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "coowner");
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId, slug: "contacts-only-test", mode: "permanent",
        visibility: "contacts-only", recipientPublicKey: "coowner-pubkey", retentionDays: 7,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload(),
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects an authenticated but non-contact sender on a contacts-only link", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "coowner2");
    const stranger = await registerAndGetCookie(server, "stranger");
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId, slug: "contacts-only-test2", mode: "permanent",
        visibility: "contacts-only", recipientPublicKey: "coowner2-pubkey", retentionDays: 7,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload(),
      cookies: stranger.cookies,
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a sender whose contact request is still pending (not yet accepted)", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "coowner2b");
    const pendingSender = await registerAndGetCookie(server, "pendingsender");
    await prisma.contact.create({
      data: { userId: pendingSender.userId, contactUserId: owner.userId, status: "pending" },
    });
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId, slug: "contacts-only-pending-test", mode: "permanent",
        visibility: "contacts-only", recipientPublicKey: "coowner2b-pubkey", retentionDays: 7,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload(),
      cookies: pendingSender.cookies,
    });

    expect(response.statusCode).toBe(403);
  });

  it("allows an accepted contact to upload to a contacts-only link", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "coowner3");
    const friend = await registerAndGetCookie(server, "friend");
    await prisma.contact.create({ data: { userId: owner.userId, contactUserId: friend.userId, status: "accepted" } });
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId, slug: "contacts-only-test3", mode: "permanent",
        visibility: "contacts-only", recipientPublicKey: "coowner3-pubkey", retentionDays: 7,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      // senderPublicKey must match the authenticated account's own public key
      // (assertSenderIdentity, lib/senderIdentity.ts) — see registerAndGetCookie's
      // `${username}-pubkey` convention.
      payload: uploadPayload({ senderPublicKey: "friend-pubkey" }),
      cookies: friend.cookies,
    });

    expect(response.statusCode).toBe(200);
  });

  it("gives a stranger no drop id to hijack an accepted contact's in-progress upload on an owned link", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "hijackvictim");
    const friend = await registerAndGetCookie(server, "hijackfriend");
    await prisma.contact.create({ data: { userId: owner.userId, contactUserId: friend.userId, status: "accepted" } });
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId, slug: "hijack-test", mode: "permanent",
        visibility: "contacts-only", recipientPublicKey: "hijackvictim-pubkey", retentionDays: 7,
      },
    });

    const upload = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload({ senderPublicKey: "hijackfriend-pubkey" }),
      cookies: friend.cookies,
    });
    expect(upload.statusCode).toBe(200);
    const { dropId } = upload.json();

    // The stranger's only view of the link: it must not reveal the drop id.
    const status = await server.inject({ method: "GET", url: `/api/links/${link.slug}` });
    expect(status.json().drop).toBeNull();
    expect(status.body).not.toContain(dropId);

    // Without the id, a complete call can only name some other id, which the
    // link-scoped CAS rejects; the in-progress drop is untouched.
    const attack = await server.inject({ method: "POST", url: `/api/links/${link.slug}/drops/not-the-real-id/complete` });
    expect(attack.statusCode).toBe(404);
    expect((await prisma.drop.findUnique({ where: { id: dropId } }))?.fileUploadStatus).toBe("uploading");

    // The real sender's own complete still succeeds.
    const complete = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${dropId}/complete`,
      cookies: friend.cookies,
    });
    expect(complete.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: dropId } }))?.fileUploadStatus).toBe("complete");
  });

  it("still allows an anonymous sender on a public permanent link", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "coowner4");
    const link = await prisma.link.create({
      data: { ownerId: owner.userId, slug: "public-permanent-test", mode: "permanent", recipientPublicKey: "coowner4-pubkey", retentionDays: 7 },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: uploadPayload(),
    });

    expect(response.statusCode).toBe(200);
  });

  it("accepts a drop with no message envelope", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: uploadPayload(),
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects an authenticated upload whose senderPublicKey doesn't match the account", async () => {
    const server = buildServer();
    const sender = await registerAndGetCookie(server, "identitymismatch");
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      cookies: sender.cookies,
      payload: uploadPayload({ senderPublicKey: "not-the-users-key" }),
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts an authenticated upload whose senderPublicKey matches the account", async () => {
    const server = buildServer();
    const sender = await registerAndGetCookie(server, "identitymatch");
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      cookies: sender.cookies,
      payload: uploadPayload({ senderPublicKey: "identitymatch-pubkey" }),
    });

    expect(response.statusCode).toBe(200);
  });

  describe("rate limiting (uploadUrlRateLimiter: 20 per minute, keyed by sender IP)", () => {
    // test/setup.ts resets every limiter before each test, so the 12-request
    // concurrency tests above (and storageQuota.test.ts's) each start with a
    // fresh bucket and stay well under the limit.
    it("allows up to the limit, then 429s the same IP without reserving quota, while other senders to the same link are unaffected", async () => {
      const server = buildServer();
      const { userId } = await registerAndGetCookie(server, "inbox");
      const upload = (ip: string) =>
        server.inject({
          method: "POST",
          url: "/api/links/inbox/upload-url",
          remoteAddress: ip,
          payload: uploadPayload(),
        });

      // Legitimate traffic up to the limit is never rejected.
      for (let i = 0; i < 20; i++) {
        expect((await upload("203.0.113.40")).statusCode).toBe(200);
      }
      const blocked = await upload("203.0.113.40");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: expect.any(String) });
      // The throttled request created no drop, so reserved no quota.
      const link = await prisma.link.findFirstOrThrow({ where: { ownerId: userId } });
      expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(20);

      // A different sender to the SAME link has their own bucket.
      expect((await upload("198.51.100.40")).statusCode).toBe(200);
    });
  });
});
