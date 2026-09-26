// apps/api/src/lib/links.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, type Drop, type Link } from "@e2ee-drop/db";

// toLinkStatusResponse must not derive codewords for an unclaimed link (no
// recipientPublicKey to derive from) — wrap the real implementation so tests
// can assert it was never called, following routes/links.test.ts's
// vi.hoisted + vi.mock(importOriginal) pattern for wrapping a real dependency.
const { deriveCodewordsSpy } = vi.hoisted(() => ({ deriveCodewordsSpy: vi.fn() }));

vi.mock("./codewords", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codewords")>();
  return {
    ...actual,
    deriveCodewords: (...args: Parameters<typeof actual.deriveCodewords>) => {
      deriveCodewordsSpy(...args);
      return actual.deriveCodewords(...args);
    },
  };
});

import { deleteLinkIfExists, toDropSummary, toLinkStatusResponse } from "./links";

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    id: "link1",
    ownerId: null,
    slug: "link-slug",
    mode: "permanent",
    visibility: "public",
    recipientPublicKey: "recipient-pk",
    codewordLocale: "en",
    retentionDays: 7,
    isDefault: false,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    ownerNote: null,
    ...overrides,
  };
}

function makeDrop(overrides: Partial<Drop> = {}): Drop {
  const now = new Date();
  return {
    id: "drop1",
    linkId: "link1",
    senderPublicKey: "sender-pk",
    senderUserId: null,
    s3Key: "link1/drop1",
    archiveNonce: "archive-nonce",
    contentMD5: "hash",
    encryptedMessage: "cipher",
    messageNonce: "msg-nonce",
    messageRevealedAt: null,
    encryptedMetadata: "meta-cipher",
    metadataNonce: "meta-nonce",
    fileSize: 1024,
    fileUploadStatus: "complete",
    reservationSenderKey: null,
    deliveryStatus: "sent",
    messageEnvelopeStatus: "sealed",
    fileEnvelopeStatus: "sealed",
    contentDeletedAt: null,
    createdAt: now,
    ...overrides,
  };
}

describe("deleteLinkIfExists", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("deletes an existing link", async () => {
    const link = await prisma.link.create({
      data: { slug: "to-delete", mode: "one-time", recipientPublicKey: "x", retentionDays: 7 },
    });

    await deleteLinkIfExists(link.id);

    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
  });

  it("does not throw when called twice for the same id (lost race with another deleter)", async () => {
    const link = await prisma.link.create({
      data: { slug: "already-gone", mode: "one-time", recipientPublicKey: "x", retentionDays: 7 },
    });

    await deleteLinkIfExists(link.id);
    // Row is already gone here — a second caller (cleanup job vs. a route handler,
    // or two concurrent requests) racing to delete the same expired link must not
    // see this throw Prisma's P2025 "record not found".
    await expect(deleteLinkIfExists(link.id)).resolves.toBeUndefined();
  });

  it("does not throw when called for an id that never existed", async () => {
    await expect(deleteLinkIfExists("nonexistent-id")).resolves.toBeUndefined();
  });
});

describe("toDropSummary", () => {
  it("reports hasMessage true while encryptedMessage is still present", () => {
    const drop = makeDrop();
    const summary = toDropSummary(drop, { retentionDays: 7 });
    expect(summary.hasMessage).toBe(true);
  });

  it("reports hasMessage false once the message has been revealed and scrubbed", () => {
    const drop = makeDrop({ encryptedMessage: null, messageNonce: null, messageEnvelopeStatus: "delivered" });
    const summary = toDropSummary(drop, { retentionDays: 7 });
    expect(summary.hasMessage).toBe(false);
  });

  it("computes contentExpiresAt as createdAt + retentionDays", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const drop = makeDrop({ createdAt });
    const summary = toDropSummary(drop, { retentionDays: 3 });
    expect(summary.contentExpiresAt).toBe(createdAt.getTime() + 3 * 24 * 60 * 60 * 1000);
  });
});

describe("toLinkStatusResponse", () => {
  const BASE_RESPONSE_KEYS = [
    "slug",
    "mode",
    "recipientPublicKey",
    "drop",
    "isAnonymous",
    "codewords",
    "ownerNote",
    "retentionDays",
    "expiresAt",
  ].sort();

  beforeEach(async () => {
    deriveCodewordsSpy.mockClear();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  async function makeOwner(overrides: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
    return prisma.user.create({
      data: {
        email: "owner@example.com",
        emailVerified: true,
        username: "owner",
        name: "Owner Name",
        passwordHash: "x",
        passwordSalt: "x",
        passwordWrappedPrivateKey: "x",
        recoveryWrappedPrivateKey: "x",
        publicKey: "b3duZXJrZXk=",
        storageQuotaBytes: BigInt(1024 * 1024 * 1024), // 1GB
        ...overrides,
      },
    });
  }

  it("returns only the base response fields for an unverified owner — no recipient* keys at all", async () => {
    const owner = await makeOwner({ emailVerified: false, showEmailOnPublicProfile: true });
    const link = { ...makeLink({ ownerId: owner.id, recipientPublicKey: owner.publicKey }), drops: [] };

    const response = await toLinkStatusResponse(link);

    // Exactly the base field set — not just undefined values for the recipient* keys,
    // but the keys themselves absent (design spec §9/§6.4: an unverified owner is
    // shown exactly like an anonymous link).
    expect(Object.keys(response).sort()).toEqual(BASE_RESPONSE_KEYS);
    for (const key of [
      "recipientName",
      "recipientUsername",
      "recipientEmail",
      "recipientEmailVerified",
      "recipientTotpEnabled",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(response, key)).toBe(false);
    }
  });

  it("omits recipientEmail for a verified owner's default link when showEmailOnPublicProfile is false", async () => {
    const owner = await makeOwner({
      username: "hideemail",
      email: "hideemail@example.com",
      showEmailOnPublicProfile: false,
    });
    const link = { ...makeLink({ ownerId: owner.id, isDefault: true, recipientPublicKey: owner.publicKey }), drops: [] };

    const response = await toLinkStatusResponse(link);

    expect(Object.prototype.hasOwnProperty.call(response, "recipientEmail")).toBe(false);
  });

  it("includes recipientEmail for a verified owner's default link when showEmailOnPublicProfile is true", async () => {
    const owner = await makeOwner({
      username: "showemail",
      email: "showemail@example.com",
      showEmailOnPublicProfile: true,
    });
    const link = { ...makeLink({ ownerId: owner.id, isDefault: true, recipientPublicKey: owner.publicKey }), drops: [] };

    const response = await toLinkStatusResponse(link);

    expect(response.recipientEmail).toBe(owner.email);
  });

  it.each([
    ["false", false],
    ["true", true],
  ])(
    "includes recipientEmail for a non-default owned link regardless of showEmailOnPublicProfile (%s)",
    async (label, showEmailOnPublicProfile) => {
      const owner = await makeOwner({
        username: `nondefault-${label}`,
        email: `nondefault-${label}@example.com`,
        showEmailOnPublicProfile,
      });
      const link = {
        ...makeLink({ ownerId: owner.id, isDefault: false, recipientPublicKey: owner.publicKey }),
        drops: [],
      };

      const response = await toLinkStatusResponse(link);

      expect(response.recipientEmail).toBe(owner.email);
    }
  );

  it("returns codewords: [] and never calls deriveCodewords for an unclaimed link", async () => {
    const link = { ...makeLink({ ownerId: null, recipientPublicKey: null }), drops: [] };

    const response = await toLinkStatusResponse(link);

    expect(response.codewords).toEqual([]);
    expect(deriveCodewordsSpy).not.toHaveBeenCalled();
  });
});
