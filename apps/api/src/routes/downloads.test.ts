// apps/api/src/routes/downloads.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const { deleteObjectMock } = vi.hoisted(() => ({ deleteObjectMock: vi.fn() }));

// /complete HEAD-verifies the upload in storage; these tests never PUT real
// bytes, so report every object as present (see completeVerification.test.ts
// for the real check). deleteObject is mocked so complete-download tests can
// assert it was (or was not) called, without touching real MinIO.
vi.mock("../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/storage")>()),
  objectHasSize: vi.fn().mockResolvedValue(true),
  deleteObject: deleteObjectMock,
}));

import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { chargedBytes } from "../lib/quota";
import { subscribeToLink, subscribeToOwner, type DropEvent } from "../lib/dropEvents";

// Creates an anonymous link with a single drop against the current schema
// (mirrors the reveal-message suite's createLinkWithMessage below). Calling
// /complete afterward (default) advances fileUploadStatus to "complete", the
// state download-url/complete-download/download-failed all require.
async function createLinkWithDrop(
  server: ReturnType<typeof buildServer>,
  opts: { uploaded?: boolean; message?: { encryptedMessage: string; messageNonce: string } | null } = {}
) {
  const { uploaded = true, message = null } = opts;
  const createRes = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "cmVjaXBpZW50" },
  });
  const { slug } = createRes.json();

  const uploadRes = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: {
      senderPublicKey: "c2VuZGVy",
      archiveNonce: "YXJjaGl2ZQ==",
      ...(message ?? {}),
      encryptedMetadata: "bWV0YWRhdGE=",
      metadataNonce: "bWV0YW5vbmNl",
      metadata: { fileSize: 1024, contentMD5: "bWQ1" },
    },
  });
  const { dropId } = uploadRes.json();

  if (uploaded) {
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
  }

  return { slug, dropId };
}

describe("download-url route", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("issues a download url once the drop is uploaded", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server);

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      downloadUrl: expect.any(String),
      archiveNonce: expect.any(String),
      senderPublicKey: expect.any(String),
      contentMD5: expect.any(String),
    });
  });

  it("no longer requires or advances any drop status", async () => {
    // A drop's deliveryStatus is "sent" once uploaded (set by /complete on an
    // anonymous link) and download-url performs no gating or side effect on
    // it — no more "uploaded" -> "downloading" CAS.
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);

    const before = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(before?.deliveryStatus).toBe("sent");
    expect(before?.fileEnvelopeStatus).toBe("sealed");

    const res = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(res.statusCode).toBe(200);
    const after = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(after?.deliveryStatus).toBe("sent");
    expect(after?.fileEnvelopeStatus).toBe("sealed");
  });

  it("allows re-issuing a download url any number of times", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server);

    const first = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    const second = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().downloadUrl).toContain("http");
  });

  it("rejects a download-url request while the drop is still uploading", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server, { uploaded: false });

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

  it("returns 404 for a nonexistent slug", async () => {
    const server = buildServer();

    const response = await server.inject({ method: "GET", url: "/api/links/does-not-exist/download-url" });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an expired link even if a drop was uploaded before it expired", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-download-test",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/drop1`,
        archiveNonce: "YXJjaGl2ZQ==",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        contentMD5: "bWQ1",
        fileUploadStatus: "complete",
      },
    });

    const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}/download-url` });

    expect(response.statusCode).toBe(404);
    // Deletion is cleanup's job: deleting the row here would lose the drop's s3Key
    // and orphan the uploaded object in storage forever.
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
    expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(1);
  });
});

// Owned-link access control and queue selection (Plan 3 Task 7 established
// pattern). Authenticated requests use a REAL registered user's session
// cookie — there is no fake user-id header in this codebase's auth plugin.
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

async function createQueuedDrop(linkId: string, key: string, fileUploadStatus: "uploading" | "complete" = "complete") {
  return prisma.drop.create({
    data: {
      linkId,
      senderPublicKey: "c2VuZGVy",
      s3Key: `${linkId}/${key}`,
      archiveNonce: "YXJjaGl2ZQ==",
      contentMD5: "bWQ1",
      encryptedMetadata: "bWV0YWRhdGE=",
      metadataNonce: "bWV0YW5vbmNl",
      fileSize: 1024,
      fileUploadStatus,
    },
  });
}

// Registration creates the owner's default permanent link with slug === username.
// isLinkInactive (now wired into download-url/complete-download/download-failed/
// reveal-message by this fix) treats an unverified owner's links as inactive, so
// every owned-link test using this helper needs a verified owner or these
// receive-side routes would 404 for a reason unrelated to what's being tested —
// same fix-up commit 9f7b591 already applied to upload-url/complete/claim.
async function ownedLinkWithQueue(server: ReturnType<typeof buildServer>, username: string) {
  const owner = await registerAndGetCookie(server, username);
  await prisma.user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
  const link = (await prisma.link.findUnique({ where: { slug: username } }))!;
  const first = await createQueuedDrop(link.id, "first");
  const second = await createQueuedDrop(link.id, "second");
  return { owner, link, first, second };
}

describe("owned-link download-url route", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
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

  it("rejects another authenticated user even with a correct dropId, without touching either drop", async () => {
    const server = buildServer();
    const { link, second } = await ownedLinkWithQueue(server, "dlowner");
    const intruder = await registerAndGetCookie(server, "intruder");

    const response = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/download-url?dropId=${second.id}`,
      cookies: intruder.cookies,
    });

    expect(response.statusCode).toBe(403);
    expect((await prisma.drop.findUnique({ where: { id: second.id } }))?.fileUploadStatus).toBe("complete");
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
    expect(response.json().contentMD5).toBe(second.contentMD5);
    // No status side effect on either drop — see "no longer requires or advances any drop status".
    expect((await prisma.drop.findUnique({ where: { id: second.id } }))?.fileEnvelopeStatus).toBe("sealed");
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.fileEnvelopeStatus).toBe("sealed");
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
  });
});

describe("complete-download route", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("marks fileEnvelopeStatus delivered, deletes the object, and derives deliveryStatus", async () => {
    const server = buildServer();
    // No message on this drop, so deliveryStatus should derive straight to "delivered".
    const { slug, dropId } = await createLinkWithDrop(server);
    const before = await prisma.drop.findUnique({ where: { id: dropId } });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete-download`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ completed: true });
    expect(deleteObjectMock).toHaveBeenCalledWith(before!.s3Key);
    const after = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(after?.fileEnvelopeStatus).toBe("delivered");
    expect(after?.contentDeletedAt).not.toBeNull();
    expect(after?.deliveryStatus).toBe("delivered");
  });

  it("derives partial_delivery when the drop still carries an unrevealed message", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, {
      message: { encryptedMessage: "c2VjcmV0", messageNonce: "bm9uY2U=" },
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete-download`,
    });

    expect(res.statusCode).toBe(200);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.deliveryStatus).toBe("partial_delivery");
  });

  // Finding I4: deliveryStatus must be derived fresh, not from a snapshot taken
  // before this call's own CAS — otherwise the entirely normal "download, then
  // reveal" / "reveal, then download" sequences leave it permanently wrong.
  it("converges on delivered when the file is downloaded before the message is revealed", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, {
      message: { encryptedMessage: "c2VjcmV0", messageNonce: "bm9uY2U=" },
    });

    const downloadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete-download`,
    });
    expect(downloadRes.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: dropId } }))?.deliveryStatus).toBe("partial_delivery");

    const revealRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
    });
    expect(revealRes.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: dropId } }))?.deliveryStatus).toBe("delivered");
  });

  it("converges on delivered when the message is revealed before the file is downloaded", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, {
      message: { encryptedMessage: "c2VjcmV0", messageNonce: "bm9uY2U=" },
    });

    const revealRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
    });
    expect(revealRes.statusCode).toBe(200);
    // Neither envelope has resolved the *file* side yet, so this stays whatever
    // it was before (still "sent") — only complete-download below finishes it.
    expect((await prisma.drop.findUnique({ where: { id: dropId } }))?.deliveryStatus).not.toBe("delivered");

    const downloadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete-download`,
    });
    expect(downloadRes.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: dropId } }))?.deliveryStatus).toBe("delivered");
  });

  // Finding I3: the old (now-removed) /downloaded route rejected a drop still
  // "uploading"; complete-download lost that guard in the rewrite.
  it("rejects completing a download while the drop is still uploading, and never deletes", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, { uploaded: false });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete-download`,
    });

    expect(res.statusCode).toBe(403);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileEnvelopeStatus).toBe("sealed");
  });

  it("is idempotent-safe against a second call: reports completed:false and does not delete again", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);
    const url = `/api/links/${slug}/drops/${dropId}/complete-download`;

    const first = await server.inject({ method: "POST", url });
    const second = await server.inject({ method: "POST", url });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ completed: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ completed: false });
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });

  it("resolves true concurrency to exactly one winner, both reporting the object as gone", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);
    const url = `/api/links/${slug}/drops/${dropId}/complete-download`;

    const [a, b] = await Promise.all([
      server.inject({ method: "POST", url }),
      server.inject({ method: "POST", url }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const completedFlags = [a.json().completed, b.json().completed].sort();
    expect(completedFlags).toEqual([false, true]);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileEnvelopeStatus).toBe("delivered");
    expect(drop?.deliveryStatus).toBe("delivered");
  });

  it("retries successfully after a previously reported download-failed", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/download-failed` });
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete-download`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ completed: true });
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileEnvelopeStatus).toBe("delivered");
  });

  it("complete-download's deliveryStatus derivation survives a concurrent reveal-message", async () => {
    const server = buildServer();
    // Drop has a message, fileEnvelopeStatus "sealed", messageEnvelopeStatus "sealed".
    const { slug, dropId } = await createLinkWithDrop(server, {
      message: { encryptedMessage: "c2VjcmV0", messageNonce: "bm9uY2U=" },
    });
    // Fire both calls "concurrently" (Promise.all) against the test server.
    await Promise.all([
      server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/reveal-message` }),
      server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete-download` }),
    ]);
    const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    // Whichever order the two calls actually completed in, both envelopes end up delivered,
    // and the derived overall status must reflect that — not get stuck at partial_delivery from
    // one call's stale read of the other's not-yet-committed state.
    expect(status.json().drop.deliveryStatus).toBe("delivered");
  });

  it("returns 404 for a nonexistent drop and never calls deleteObject", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/does-not-exist/complete-download`,
    });

    expect(res.statusCode).toBe(404);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a drop that belongs to a different link, without touching it", async () => {
    const server = buildServer();
    const { dropId } = await createLinkWithDrop(server);
    const { slug: otherSlug } = await createLinkWithDrop(server);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${otherSlug}/drops/${dropId}/complete-download`,
    });

    expect(res.statusCode).toBe(404);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileEnvelopeStatus).toBe("sealed");
  });

  it("returns 404 for an expired link", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-complete-download-test",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const drop = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/drop1`,
        archiveNonce: "YXJjaGl2ZQ==",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        contentMD5: "bWQ1",
        fileUploadStatus: "complete",
      },
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/complete-download`,
    });

    expect(res.statusCode).toBe(404);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("owned-link complete-download route", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("rejects a non-owner completing an owned link's drop, and never deletes", async () => {
    const server = buildServer();
    const { link, first } = await ownedLinkWithQueue(server, "cdowner");
    const intruder = await registerAndGetCookie(server, "intruder");
    const url = `/api/links/${link.slug}/drops/${first.id}/complete-download`;

    const anonymous = await server.inject({ method: "POST", url });
    const otherUser = await server.inject({ method: "POST", url, cookies: intruder.cookies });

    expect(anonymous.statusCode).toBe(403);
    expect(otherUser.statusCode).toBe(403);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.fileEnvelopeStatus).toBe("sealed");
  });

  it("lets the owner complete one queued drop without affecting the others", async () => {
    const server = buildServer();
    const { owner, link, first, second } = await ownedLinkWithQueue(server, "cdowner");

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${first.id}/complete-download`,
      cookies: owner.cookies,
    });

    expect(response.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.fileEnvelopeStatus).toBe("delivered");
    expect((await prisma.drop.findUnique({ where: { id: second.id } }))?.fileEnvelopeStatus).toBe("sealed");
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(first.s3Key);
  });

  // Finding C1: complete-download used to never release the owner's quota at all, so every
  // successfully delivered drop kept counting against the owner's storage forever.
  it("releases exactly chargedBytes(fileSize) of the owner's quota when its CAS wins, and nothing on a repeat call", async () => {
    const server = buildServer();
    const { owner, link, first, second } = await ownedLinkWithQueue(server, "cdquota");
    // Both queued drops are "complete", i.e. charged at /complete.
    await prisma.user.update({
      where: { id: owner.userId },
      data: { storageUsedBytes: chargedBytes(first.fileSize) + chargedBytes(second.fileSize) },
    });
    const url = `/api/links/${link.slug}/drops/${first.id}/complete-download`;

    const response = await server.inject({ method: "POST", url, cookies: owner.cookies });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ completed: true });
    const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(afterFirst.storageUsedBytes).toBe(chargedBytes(second.fileSize)); // decreased by exactly one drop's charge

    const repeat = await server.inject({ method: "POST", url, cookies: owner.cookies });

    expect(repeat.json()).toEqual({ completed: false });
    const afterRepeat = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(afterRepeat.storageUsedBytes).toBe(chargedBytes(second.fileSize)); // not released twice
  });

  // This file previously had zero SSE emission of any kind: neither a sender
  // watching UploadPage.tsx's live status view nor a link owner's inbox ever
  // saw a live update when a recipient completed a download. Proves both
  // channels now fire with a "drop-updated" event carrying the fully-derived
  // post-recompute state (see complete-download's implementation).
  it("emits drop-updated on both the link-keyed and owner-keyed SSE channels when the CAS wins", async () => {
    const server = buildServer();
    const { owner, link, first } = await ownedLinkWithQueue(server, "cdsseowner");

    const linkEvents: DropEvent[] = [];
    const ownerEvents: DropEvent[] = [];
    const unsubLink = subscribeToLink(link.id, (event) => linkEvents.push(event));
    const unsubOwner = subscribeToOwner(owner.userId, (event) => ownerEvents.push(event));

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${first.id}/complete-download`,
      cookies: owner.cookies,
    });

    unsubLink();
    unsubOwner();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ completed: true });
    expect(linkEvents).toHaveLength(1);
    expect(linkEvents[0]).toMatchObject({
      type: "drop-updated",
      drop: { id: first.id, fileEnvelopeStatus: "delivered", deliveryStatus: "delivered" },
    });
    expect(ownerEvents).toEqual(linkEvents);
  });

  // A lost race (second call, count !== 1) must not re-emit — the winner
  // already did.
  it("does not emit on a losing complete-download call (count !== 1)", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    const url = `/api/links/${slug}/drops/${dropId}/complete-download`;

    await server.inject({ method: "POST", url });

    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));
    const second = await server.inject({ method: "POST", url });
    unsubscribe();

    expect(second.json()).toEqual({ completed: false });
    expect(events).toHaveLength(0);
  });
});

describe("download-failed route", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("marks fileEnvelopeStatus delivery_failed and never deletes the object", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/download-failed`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(deleteObjectMock).not.toHaveBeenCalled();
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileEnvelopeStatus).toBe("delivery_failed");
    expect(drop?.contentDeletedAt).toBeNull();
  });

  it("never deletes the object even when called repeatedly", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);
    const url = `/api/links/${slug}/drops/${dropId}/download-failed`;

    await server.inject({ method: "POST", url });
    const second = await server.inject({ method: "POST", url });

    expect(second.statusCode).toBe(200);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("does not clobber an already-completed download back to delivery_failed", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);

    const complete = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete-download`,
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toEqual({ completed: true });

    const failed = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/download-failed`,
    });

    expect(failed.statusCode).toBe(200);
    // The object was already deleted by complete-download; download-failed must
    // never delete anything itself, and must not overwrite "delivered".
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.fileEnvelopeStatus).toBe("delivered");
  });

  it("true concurrency against complete-download never leaves the object undeleted while marked delivered, nor clobbers a delivered drop to delivery_failed", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);

    const [completeRes, failedRes] = await Promise.all([
      server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete-download` }),
      server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/download-failed` }),
    ]);

    expect(completeRes.statusCode).toBe(200);
    expect(failedRes.statusCode).toBe(200);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    // complete-download's CAS is allowed to overwrite "delivery_failed" (a
    // retry-after-failure), so regardless of interleaving the drop converges
    // on "delivered" — and since complete-download always calls deleteObject
    // whenever it isn't short-circuited by its own already-terminal fast
    // path, the object was in fact deleted.
    expect(drop?.fileEnvelopeStatus).toBe("delivered");
    expect(deleteObjectMock).toHaveBeenCalledWith(drop!.s3Key);
  });

  it("returns 404 for an expired link", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-download-failed-test",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/does-not-exist/download-failed`,
    });

    expect(res.statusCode).toBe(404);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  // This route previously never checked its updateMany's count for anything —
  // it unconditionally reported { ok: true }. Proves the link-keyed SSE
  // channel now fires a "drop-updated" event when the CAS actually matches a
  // row.
  it("emits drop-updated on the link-keyed SSE channel when the CAS matches a row", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);
    const link = (await prisma.link.findUnique({ where: { slug } }))!;

    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/download-failed`,
    });

    unsubscribe();

    expect(res.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "drop-updated",
      drop: { id: dropId, fileEnvelopeStatus: "delivery_failed" },
    });
  });

  // New coverage this fix specifically needs: since the route previously never
  // checked the updateMany count, a call against a dropId that never matches a
  // row (nonexistent here) must never emit on either channel.
  it("does not emit on either SSE channel when the count-check gate is not satisfied (nonexistent dropId)", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server);
    const link = (await prisma.link.findUnique({ where: { slug } }))!;

    const linkEvents: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => linkEvents.push(event));

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/does-not-exist/download-failed`,
    });

    unsubscribe();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(linkEvents).toHaveLength(0);
  });

  // Same count-check gate, but against an already-terminal ("delivered") drop
  // rather than a missing one — the updateMany's WHERE excludes terminal
  // statuses, so count is 0 here too, and this must not emit either.
  it("does not emit when the drop is already terminal (delivered), matching zero rows", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server);
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete-download` });
    const link = (await prisma.link.findUnique({ where: { slug } }))!;

    const linkEvents: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => linkEvents.push(event));

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/download-failed`,
    });

    unsubscribe();

    expect(res.statusCode).toBe(200);
    // No re-emission for this terminal-drop call — the earlier complete-download
    // already emitted its own drop-updated event before this subscription began.
    expect(linkEvents).toHaveLength(0);
  });
});

describe("owned-link download-failed route", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("rejects a non-owner reporting a failure on an owned link's drop", async () => {
    const server = buildServer();
    const { link, first } = await ownedLinkWithQueue(server, "dfowner");
    const intruder = await registerAndGetCookie(server, "intruder");
    const url = `/api/links/${link.slug}/drops/${first.id}/download-failed`;

    const anonymous = await server.inject({ method: "POST", url });
    const otherUser = await server.inject({ method: "POST", url, cookies: intruder.cookies });

    expect(anonymous.statusCode).toBe(403);
    expect(otherUser.statusCode).toBe(403);
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.fileEnvelopeStatus).toBe("sealed");
  });

  it("lets the owner report a failure on one queued drop without affecting the others", async () => {
    const server = buildServer();
    const { owner, link, first, second } = await ownedLinkWithQueue(server, "dfowner");

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${first.id}/download-failed`,
      cookies: owner.cookies,
    });

    expect(response.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: first.id } }))?.fileEnvelopeStatus).toBe("delivery_failed");
    expect((await prisma.drop.findUnique({ where: { id: second.id } }))?.fileEnvelopeStatus).toBe("sealed");
  });
});

describe("reveal-message route", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  // Creates an anonymous link with a single drop, optionally carrying a sealed
  // message envelope. Uses upload-url directly (rather than createLinkWithDrop,
  // which never sends encryptedMessage/messageNonce) so tests can control
  // whether the drop has a message to reveal.
  async function createLinkWithMessage(
    server: ReturnType<typeof buildServer>,
    message: { encryptedMessage: string; messageNonce: string } | null
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
      payload: {
        senderPublicKey: "c2VuZGVy",
        archiveNonce: "YXJjaGl2ZQ==",
        ...(message ?? {}),
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        metadata: { fileSize: 1024, contentMD5: "bWQ1" },
      },
    });
    const { dropId } = uploadRes.json();
    return { slug, dropId };
  }

  it("reveals the message once and scrubs it", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithMessage(server, {
      encryptedMessage: "c2VjcmV0IG1lc3NhZ2U=",
      messageNonce: "bXNnbm9uY2U=",
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      encryptedMessage: "c2VjcmV0IG1lc3NhZ2U=",
      messageNonce: "bXNnbm9uY2U=",
    });

    const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(status.json().drop.hasMessage).toBe(false);

    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.encryptedMessage).toBeNull();
    expect(drop?.messageNonce).toBeNull();
    expect(drop?.messageRevealedAt).not.toBeNull();
    expect(drop?.messageEnvelopeStatus).toBe("delivered");
  });

  it("a second reveal call fails", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithMessage(server, {
      encryptedMessage: "c2VjcmV0IG1lc3NhZ2U=",
      messageNonce: "bXNnbm9uY2U=",
    });

    const first = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
    });
    const second = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
  });

  it("concurrent reveal calls resolve to exactly one winner", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithMessage(server, {
      encryptedMessage: "c2VjcmV0IG1lc3NhZ2U=",
      messageNonce: "bXNnbm9uY2U=",
    });

    const [a, b] = await Promise.all([
      server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/reveal-message` }),
      server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/reveal-message` }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.encryptedMessage).toBeNull();
    expect(drop?.messageNonce).toBeNull();
  });

  it("404s for a drop with no message", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithMessage(server, null);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s for a nonexistent drop id", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithMessage(server, null);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/does-not-exist/reveal-message`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s for a nonexistent link slug", async () => {
    const server = buildServer();

    const res = await server.inject({
      method: "POST",
      url: `/api/links/does-not-exist/drops/does-not-exist/reveal-message`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s for an expired link even if the drop has a message", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-reveal-test",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const drop = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/drop1`,
        archiveNonce: "YXJjaGl2ZQ==",
        encryptedMessage: "c2VjcmV0",
        messageNonce: "bm9uY2U=",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        contentMD5: "bWQ1",
        fileUploadStatus: "complete",
      },
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/reveal-message`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("reveal-message also advances deliveryStatus toward partial_delivery/delivered", async () => {
    const server = buildServer();
    const createRes = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50" },
    });
    const { slug } = createRes.json();

    // Drop has a message and an already-"delivered" fileEnvelopeStatus (file downloaded first)
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    const drop = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/with-message`,
        archiveNonce: "YXJjaGl2ZQ==",
        contentMD5: "bWQ1",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        fileUploadStatus: "complete",
        encryptedMessage: "c2VjcmV0",
        messageNonce: "bm9uY2U=",
        fileEnvelopeStatus: "delivered",
      },
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${drop.id}/reveal-message`,
    });
    expect(res.statusCode).toBe(200);
    const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(status.json().drop.deliveryStatus).toBe("delivered");
  });

  // Same pre-existing gap as complete-download: this route never emitted on
  // either SSE channel. Proves the link-keyed channel now fires a
  // "drop-updated" event with the fully-derived post-recompute state once the
  // reveal CAS wins.
  it("emits drop-updated on the link-keyed SSE channel once the reveal CAS wins", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithMessage(server, {
      encryptedMessage: "c2VjcmV0IG1lc3NhZ2U=",
      messageNonce: "bXNnbm9uY2U=",
    });
    const link = (await prisma.link.findUnique({ where: { slug } }))!;

    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
    });

    unsubscribe();

    expect(res.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "drop-updated",
      drop: { id: dropId, messageEnvelopeStatus: "delivered", hasMessage: false },
    });
  });

  // A losing reveal call (409, count !== 1) must not emit — the winner already did.
  it("does not emit on a losing reveal-message call (count !== 1)", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithMessage(server, {
      encryptedMessage: "c2VjcmV0IG1lc3NhZ2U=",
      messageNonce: "bXNnbm9uY2U=",
    });
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    const url = `/api/links/${slug}/drops/${dropId}/reveal-message`;

    await server.inject({ method: "POST", url });

    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));
    const second = await server.inject({ method: "POST", url });
    unsubscribe();

    expect(second.statusCode).toBe(409);
    expect(events).toHaveLength(0);
  });
});

// Finding I5: reveal-message previously had no ownership check at all — a
// non-owner could reveal (and permanently scrub) an owned link's message.
// Same pattern as "owned-link download-failed route" above.
describe("owned-link reveal-message route", () => {
  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  async function createQueuedDropWithMessage(linkId: string) {
    return prisma.drop.create({
      data: {
        linkId,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${linkId}/with-message`,
        archiveNonce: "YXJjaGl2ZQ==",
        contentMD5: "bWQ1",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        fileUploadStatus: "complete",
        encryptedMessage: "c2VjcmV0",
        messageNonce: "bm9uY2U=",
      },
    });
  }

  it("rejects a non-owner revealing an owned link's message, and never scrubs it", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "revealowner");
    // isLinkInactive treats an unverified owner's link as inactive — verify so
    // this test's 403s come from the ownership check, not a 404 for an
    // unrelated reason.
    await prisma.user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
    const link = (await prisma.link.findUnique({ where: { slug: "revealowner" } }))!;
    const drop = await createQueuedDropWithMessage(link.id);
    const intruder = await registerAndGetCookie(server, "revealintruder");
    const url = `/api/links/${link.slug}/drops/${drop.id}/reveal-message`;

    const anonymous = await server.inject({ method: "POST", url });
    const otherUser = await server.inject({ method: "POST", url, cookies: intruder.cookies });

    expect(anonymous.statusCode).toBe(403);
    expect(otherUser.statusCode).toBe(403);
    expect((await prisma.drop.findUnique({ where: { id: drop.id } }))?.encryptedMessage).not.toBeNull();
  });

  it("lets the owner reveal their own link's message", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "revealowner2");
    await prisma.user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
    const link = (await prisma.link.findUnique({ where: { slug: "revealowner2" } }))!;
    const drop = await createQueuedDropWithMessage(link.id);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/reveal-message`,
      cookies: owner.cookies,
    });

    expect(res.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: drop.id } }))?.encryptedMessage).toBeNull();
  });
});

describe("owner-cancel route", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("owner-cancel scrubs a sealed drop's content", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "cancelowner1");
    const link = (await prisma.link.findUnique({ where: { slug: "cancelowner1" } }))!;
    const drop = await createQueuedDrop(link.id, "sealed", "complete");

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/owner-cancel`,
      cookies: owner.cookies,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: true });
    expect(deleteObjectMock).toHaveBeenCalledWith(drop.s3Key);
    const after = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(after.fileEnvelopeStatus).toBe("shredded");
  });

  it("rejects a non-owner", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "cancelowner2");
    const link = (await prisma.link.findUnique({ where: { slug: "cancelowner2" } }))!;
    const drop = await createQueuedDrop(link.id, "sealed", "complete");
    const intruder = await registerAndGetCookie(server, "cancelintruder2");

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/owner-cancel`,
      cookies: intruder.cookies,
    });

    expect(res.statusCode).toBe(403);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("is a no-op, not an error, on an already-delivered drop", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "cancelowner3");
    const link = (await prisma.link.findUnique({ where: { slug: "cancelowner3" } }))!;
    const drop = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/delivered`,
        archiveNonce: "YXJjaGl2ZQ==",
        contentMD5: "bWQ1",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "delivered",
        messageEnvelopeStatus: "delivered",
        encryptedMessage: "c2VjcmV0",
        messageNonce: "bm9uY2U=",
      },
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/owner-cancel`,
      cookies: owner.cookies,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: false });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("delegates to abandon semantics for a still-uploading drop", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "cancelowner4");
    const link = (await prisma.link.findUnique({ where: { slug: "cancelowner4" } }))!;
    const drop = await createQueuedDrop(link.id, "uploading", "uploading");

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/owner-cancel`,
      cookies: owner.cookies,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: true });
    const after = await prisma.drop.findUnique({ where: { id: drop.id } });
    expect(after).toBeNull(); // abandoned (row removed), not scrubbed-in-place
  });

  // This route previously never emitted on either SSE channel. Proves the
  // link-keyed channel now fires a "drop-updated" event once scrubDropContent
  // actually scrubs a sealed drop (the abandonDrop branch above deliberately
  // stays unchanged and un-instrumented — see uploads.ts's own /abandon route
  // for the same convention).
  it("emits drop-updated on the link-keyed SSE channel once scrubDropContent succeeds", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "cancelowner5");
    const link = (await prisma.link.findUnique({ where: { slug: "cancelowner5" } }))!;
    const drop = await createQueuedDrop(link.id, "sealed", "complete");

    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/owner-cancel`,
      cookies: owner.cookies,
    });

    unsubscribe();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "drop-updated",
      drop: { id: drop.id, fileEnvelopeStatus: "shredded" },
    });
  });

  // The no-op (already-delivered) branch above must not emit either — nothing
  // was scrubbed (result === null).
  it("does not emit when owner-cancel is a no-op on an already-delivered drop", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "cancelowner6");
    const link = (await prisma.link.findUnique({ where: { slug: "cancelowner6" } }))!;
    const drop = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/delivered6`,
        archiveNonce: "YXJjaGl2ZQ==",
        contentMD5: "bWQ1",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "delivered",
        messageEnvelopeStatus: "delivered",
        encryptedMessage: "c2VjcmV0",
        messageNonce: "bm9uY2U=",
      },
    });

    const events: DropEvent[] = [];
    const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/drops/${drop.id}/owner-cancel`,
      cookies: owner.cookies,
    });

    unsubscribe();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: false });
    expect(events).toHaveLength(0);
  });
});

// Finding C1: POST /api/links/request + /claim previously shipped a flow that
// could never actually deliver anything — every receive-side route gated on
// `request.user?.id === link.ownerId`, but the owner of a sender-initiated
// link is the SENDER (the initiator who requested it), not the claimant who
// is supposed to receive. canReceive (lib/links.ts) fixes this structurally.
describe("sender-initiated link receive access (finding C1)", () => {
  beforeEach(async () => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  async function createClaimedSenderInitiatedLink(
    server: ReturnType<typeof buildServer>,
    initiatorUsername: string,
    claimantPublicKey = "claimant-pubkey"
  ) {
    const initiator = await registerAndGetCookie(server, initiatorUsername);
    // isLinkInactive (wired into the claim handler by this fix) treats an
    // unverified owner's links as inactive, so the claim below would 404
    // without this — these tests are about receive-side access, not
    // verification.
    await prisma.user.update({ where: { username: initiatorUsername }, data: { emailVerified: true } });
    const requestRes = await server.inject({
      method: "POST",
      url: "/api/links/request",
      payload: {},
      cookies: initiator.cookies,
    });
    const { slug } = requestRes.json();
    const claimRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/claim`,
      payload: { recipientPublicKey: claimantPublicKey },
    });
    expect(claimRes.statusCode).toBe(200);
    const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
    return { initiator, slug, link };
  }

  async function createDropOn(linkId: string, opts: { withMessage?: boolean } = {}) {
    return prisma.drop.create({
      data: {
        linkId,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${linkId}/sender-initiated-drop`,
        archiveNonce: "YXJjaGl2ZQ==",
        contentMD5: "bWQ1",
        encryptedMetadata: "bWV0YWRhdGE=",
        metadataNonce: "bWV0YW5vbmNl",
        fileSize: 1024,
        fileUploadStatus: "complete",
        deliveryStatus: "sent",
        ...(opts.withMessage ? { encryptedMessage: "c2VjcmV0", messageNonce: "bm9uY2U=" } : {}),
      },
    });
  }

  it("denies the initiator (owner) download-url access to their own claimed link", async () => {
    const server = buildServer();
    const { initiator, slug, link } = await createClaimedSenderInitiatedLink(server, "initiator1");
    await createDropOn(link.id);

    const res = await server.inject({
      method: "GET",
      url: `/api/links/${slug}/download-url`,
      cookies: initiator.cookies,
    });

    expect(res.statusCode).toBe(403);
  });

  it("allows the claimant (no session) download-url access once claimed", async () => {
    const server = buildServer();
    const { slug, link } = await createClaimedSenderInitiatedLink(server, "initiator2");
    await createDropOn(link.id);

    const res = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(res.statusCode).toBe(200);
  });

  it("denies the initiator complete-download access, and never deletes", async () => {
    const server = buildServer();
    const { initiator, slug, link } = await createClaimedSenderInitiatedLink(server, "initiator3");
    const drop = await createDropOn(link.id);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${drop.id}/complete-download`,
      cookies: initiator.cookies,
    });

    expect(res.statusCode).toBe(403);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect((await prisma.drop.findUnique({ where: { id: drop.id } }))?.fileEnvelopeStatus).toBe("sealed");
  });

  it("allows a non-owner complete-download once claimed", async () => {
    const server = buildServer();
    const { slug, link } = await createClaimedSenderInitiatedLink(server, "initiator4");
    const drop = await createDropOn(link.id);

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${drop.id}/complete-download`,
    });

    expect(res.statusCode).toBe(200);
    expect(deleteObjectMock).toHaveBeenCalledWith(drop.s3Key);
    expect((await prisma.drop.findUnique({ where: { id: drop.id } }))?.fileEnvelopeStatus).toBe("delivered");
  });

  it("denies the initiator reveal-message access, and never scrubs it", async () => {
    const server = buildServer();
    const { initiator, slug, link } = await createClaimedSenderInitiatedLink(server, "initiator5");
    const drop = await createDropOn(link.id, { withMessage: true });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${drop.id}/reveal-message`,
      cookies: initiator.cookies,
    });

    expect(res.statusCode).toBe(403);
    expect((await prisma.drop.findUnique({ where: { id: drop.id } }))?.encryptedMessage).not.toBeNull();
  });

  it("allows a non-owner reveal-message access once claimed", async () => {
    const server = buildServer();
    const { slug, link } = await createClaimedSenderInitiatedLink(server, "initiator6");
    const drop = await createDropOn(link.id, { withMessage: true });

    const res = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${drop.id}/reveal-message`,
    });

    expect(res.statusCode).toBe(200);
    expect((await prisma.drop.findUnique({ where: { id: drop.id } }))?.encryptedMessage).toBeNull();
  });

  it("still denies a non-owner on an UNCLAIMED sender-initiated link (nothing to receive yet)", async () => {
    const server = buildServer();
    const initiator = await registerAndGetCookie(server, "initiator7");
    await prisma.user.update({ where: { username: "initiator7" }, data: { emailVerified: true } });
    const requestRes = await server.inject({
      method: "POST",
      url: "/api/links/request",
      payload: {},
      cookies: initiator.cookies,
    });
    const { slug } = requestRes.json();
    const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
    const drop = await createDropOn(link.id);

    const res = await server.inject({
      method: "GET",
      url: `/api/links/${slug}/download-url`,
    });

    expect(res.statusCode).toBe(403);
    expect(drop).toBeTruthy(); // drop exists in DB but access is still denied pre-claim
  });

  it("still denies a stranger on a NORMAL owned link (custom, not sender-initiated) — no regression", async () => {
    const server = buildServer();
    const owner = await registerAndGetCookie(server, "normalowner1");
    // isLinkInactive treats an unverified owner's link as inactive — verify so
    // this test's 403s come from the ownership check, not a 404 for an
    // unrelated reason.
    await prisma.user.update({ where: { id: owner.userId }, data: { emailVerified: true } });
    const link = await prisma.link.create({
      data: {
        ownerId: owner.userId,
        slug: "normal-owned-link",
        mode: "permanent",
        recipientPublicKey: `normalowner1-pubkey`,
        retentionDays: 7,
      },
    });
    await createDropOn(link.id);

    const anonymous = await server.inject({ method: "GET", url: `/api/links/${link.slug}/download-url` });
    const stranger = await registerAndGetCookie(server, "normalstranger1");
    const strangerRes = await server.inject({
      method: "GET",
      url: `/api/links/${link.slug}/download-url`,
      cookies: stranger.cookies,
    });

    expect(anonymous.statusCode).toBe(403);
    expect(strangerRes.statusCode).toBe(403);
  });
});
