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

import {
  canReceive,
  deleteLinkIfExists,
  hasEverHadMessage,
  isLinkInactive,
  recomputeDeliveryStatus,
  shouldMaskAsNotFound,
  toDropSummary,
  toLinkStatusResponse,
} from "./links";

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
    lastSenderOpenedAt: null,
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
    "linkId",
    "slug",
    "mode",
    "recipientPublicKey",
    "drop",
    "isAnonymous",
    "codewords",
    "codewordLocale",
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
      "recipientAllowContactRequests",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(response, key)).toBe(false);
    }
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("includes recipientAllowContactRequests: %s reflecting owner.allowContactRequests", async (_label, allowContactRequests) => {
    const owner = await makeOwner({ username: `allow-${allowContactRequests}`, allowContactRequests });
    const link = { ...makeLink({ ownerId: owner.id, recipientPublicKey: owner.publicKey }), drops: [] };

    const response = await toLinkStatusResponse(link);

    expect(response.recipientAllowContactRequests).toBe(allowContactRequests);
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

  describe("finding C1: a claimed sender-initiated link exposes its drop like an anonymous link, except to the owner", () => {
    it("exposes the drop to a non-owner (anonymous caller) on a claimed sender-initiated link", async () => {
      const owner = await makeOwner({ username: "initiator", email: "initiator@example.com" });
      const drop = makeDrop({ linkId: "link1" });
      const link = {
        ...makeLink({ ownerId: owner.id, recipientPublicKey: "claimant-key" }),
        drops: [drop],
      };

      const response = await toLinkStatusResponse(link, undefined);

      expect(response.drop).not.toBeNull();
      expect(response.drop?.id).toBe(drop.id);
    });

    it("still hides the drop from the initiator/owner themselves on a claimed sender-initiated link", async () => {
      const owner = await makeOwner({ username: "initiator2", email: "initiator2@example.com" });
      const drop = makeDrop({ linkId: "link1" });
      const link = {
        ...makeLink({ ownerId: owner.id, recipientPublicKey: "claimant-key" }),
        drops: [drop],
      };

      const response = await toLinkStatusResponse(link, owner.id);

      expect(response.drop).toBeNull();
    });

    it("still hides the drop on a NORMAL owned link even when userId is the true owner (no regression)", async () => {
      const owner = await makeOwner({ username: "normalowner", email: "normalowner@example.com" });
      const drop = makeDrop({ linkId: "link1" });
      const link = {
        ...makeLink({ ownerId: owner.id, recipientPublicKey: owner.publicKey }),
        drops: [drop],
      };

      const response = await toLinkStatusResponse(link, owner.id);

      expect(response.drop).toBeNull();
    });
  });

  // docs/STATUS.md gap 2: a claimed sender-initiated link's `owner` row is the
  // INITIATOR (sender), not the real recipient — so recipient* must never be
  // derived from it, regardless of the initiator's own emailVerified/totpEnabled
  // status. Whoever reads this response (the initiator themselves, or anyone
  // else) must never see the sender's own identity mislabeled as "recipient".
  describe("gap 2: a claimed sender-initiated link never exposes recipient* fields", () => {
    it("omits every recipient* key even when the initiator is emailVerified and shows their email", async () => {
      const owner = await makeOwner({
        username: "initiatorverified",
        email: "initiatorverified@example.com",
        emailVerified: true,
        totpEnabled: true,
        showEmailOnPublicProfile: true,
      });
      const link = {
        ...makeLink({ ownerId: owner.id, isDefault: true, recipientPublicKey: "claimant-key" }),
        drops: [],
      };

      const response = await toLinkStatusResponse(link);

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

    it("still shows recipient* fields for a NORMAL owned link with a verified owner (no regression)", async () => {
      const owner = await makeOwner({
        username: "normalownerverified",
        email: "normalownerverified@example.com",
        emailVerified: true,
        showEmailOnPublicProfile: true,
      });
      const link = {
        ...makeLink({ ownerId: owner.id, isDefault: true, recipientPublicKey: owner.publicKey }),
        drops: [],
      };

      const response = await toLinkStatusResponse(link);

      expect(response.recipientName).toBe(owner.name);
      expect(response.recipientEmailVerified).toBe(true);
    });
  });

  // docs/STATUS.md gap 3: a claimed sender-initiated link is `mode:
  // "permanent"` and can receive more than one drop over its lifetime, but
  // this function's singular `drop` field only ever surfaced `link.drops[0]`
  // (an arbitrary element — the underlying query has no ordering guarantee),
  // so a second file sent to an already-claimed link was invisible to the
  // claimant. `drops` (plural) must list every outstanding one.
  describe("gap 3: a claimed sender-initiated link's claimant sees every outstanding drop", () => {
    it("lists every non-terminal drop, oldest first, for a non-owner caller on a claimed sender-initiated link", async () => {
      const owner = await makeOwner({ username: "multidropinitiator", email: "multidropinitiator@example.com" });
      const older = makeDrop({ id: "drop-older", createdAt: new Date("2026-01-01T00:00:00.000Z") });
      const newer = makeDrop({ id: "drop-newer", createdAt: new Date("2026-01-02T00:00:00.000Z") });
      const link = {
        ...makeLink({ ownerId: owner.id, recipientPublicKey: "claimant-key" }),
        // Deliberately inserted out of chronological order, matching the
        // underlying query's lack of an ordering guarantee.
        drops: [newer, older],
      };

      const response = await toLinkStatusResponse(link, undefined);

      expect(response.drops?.map((d) => d.id)).toEqual(["drop-older", "drop-newer"]);
      // The legacy singular field stays populated too, for any consumer still
      // reading it — mirroring drops[0].
      expect(response.drop?.id).toBe("drop-older");
    });

    it("excludes already-delivered/shredded drops from the drops list", async () => {
      const owner = await makeOwner({ username: "multidropinitiator2", email: "multidropinitiator2@example.com" });
      const outstanding = makeDrop({ id: "drop-outstanding", fileEnvelopeStatus: "sealed" });
      const delivered = makeDrop({ id: "drop-delivered", fileEnvelopeStatus: "delivered" });
      const shredded = makeDrop({ id: "drop-shredded", fileEnvelopeStatus: "shredded" });
      const link = {
        ...makeLink({ ownerId: owner.id, recipientPublicKey: "claimant-key" }),
        drops: [delivered, outstanding, shredded],
      };

      const response = await toLinkStatusResponse(link, undefined);

      expect(response.drops?.map((d) => d.id)).toEqual(["drop-outstanding"]);
    });

    it("never sets drops for the initiator/owner's own view of a claimed sender-initiated link", async () => {
      const owner = await makeOwner({ username: "multidropinitiator3", email: "multidropinitiator3@example.com" });
      const drop = makeDrop({ id: "drop1" });
      const link = {
        ...makeLink({ ownerId: owner.id, recipientPublicKey: "claimant-key" }),
        drops: [drop],
      };

      const response = await toLinkStatusResponse(link, owner.id);

      expect(response.drops).toBeUndefined();
    });

    it("never sets drops for a NORMAL owned link or a plain anonymous link (no regression)", async () => {
      const owner = await makeOwner({ username: "multidropnormalowner", email: "multidropnormalowner@example.com" });
      const drop = makeDrop({ id: "drop1" });
      const ownedLink = {
        ...makeLink({ ownerId: owner.id, recipientPublicKey: owner.publicKey }),
        drops: [drop],
      };
      const anonymousLink = { ...makeLink({ ownerId: null, recipientPublicKey: "anon-key" }), drops: [drop] };

      expect((await toLinkStatusResponse(ownedLink, owner.id)).drops).toBeUndefined();
      expect((await toLinkStatusResponse(anonymousLink, undefined)).drops).toBeUndefined();
    });
  });
});

describe("isLinkInactive", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("is true for a revoked link even with no expiry", async () => {
    const link = await prisma.link.create({
      data: { slug: "revoked-test", mode: "permanent", visibility: "public", recipientPublicKey: "pk", revokedAt: new Date(), retentionDays: 7 },
    });
    expect(await isLinkInactive(link)).toBe(true);
  });

  it("is true for an owned link whose owner is unverified", async () => {
    const owner = await prisma.user.create({
      data: {
        email: "unverified@example.com", username: "unverified", name: "U", passwordHash: "h", passwordSalt: "s",
        passwordWrappedPrivateKey: "w", recoveryWrappedPrivateKey: "r", publicKey: "pk", storageQuotaBytes: 1000n,
        emailVerified: false,
      },
    });
    const link = await prisma.link.create({
      data: { slug: "unverified-owner-link", mode: "permanent", visibility: "public", recipientPublicKey: owner.publicKey, ownerId: owner.id, retentionDays: 7 },
    });
    expect(await isLinkInactive(link)).toBe(true);
  });

  it("is false for an active, non-revoked, verified-owner link", async () => {
    const owner = await prisma.user.create({
      data: {
        email: "verified@example.com", username: "verified", name: "V", passwordHash: "h", passwordSalt: "s",
        passwordWrappedPrivateKey: "w", recoveryWrappedPrivateKey: "r", publicKey: "pk2", storageQuotaBytes: 1000n,
        emailVerified: true,
      },
    });
    const link = await prisma.link.create({
      data: { slug: "active-link", mode: "permanent", visibility: "public", recipientPublicKey: owner.publicKey, ownerId: owner.id, retentionDays: 7 },
    });
    expect(await isLinkInactive(link)).toBe(false);
  });

  it("is false for an anonymous (ownerless) link with no expiry/revocation", async () => {
    const link = await prisma.link.create({
      data: { slug: "anon-link", mode: "one-time", visibility: "public", recipientPublicKey: "pk3", retentionDays: 7 },
    });
    expect(await isLinkInactive(link)).toBe(false);
  });
});

describe("canReceive", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("is always true for an anonymous link, regardless of caller identity", async () => {
    const link = makeLink({ ownerId: null });

    expect(await canReceive(link, undefined)).toBe(true);
    expect(await canReceive(link, "some-random-id")).toBe(true);
  });

  it("is true only for the true owner on a normal owned link (default/custom) — non-owner denied", async () => {
    const owner = await makeOwner({ username: "normalowner2", email: "normalowner2@example.com" });
    const link = makeLink({ ownerId: owner.id, recipientPublicKey: owner.publicKey });

    expect(await canReceive(link, owner.id)).toBe(true);
    expect(await canReceive(link, "intruder-id")).toBe(false);
    expect(await canReceive(link, undefined)).toBe(false);
  });

  it("is true only for a non-owner on a claimed sender-initiated link — the initiator/owner is denied", async () => {
    const owner = await makeOwner({ username: "initiator3", email: "initiator3@example.com" });
    const link = makeLink({ ownerId: owner.id, recipientPublicKey: "claimant-key" });

    expect(await canReceive(link, owner.id)).toBe(false);
    expect(await canReceive(link, "claimant-session-id")).toBe(true);
    expect(await canReceive(link, undefined)).toBe(true);
  });

  it("is true only for the owner on an UNCLAIMED sender-initiated link (nothing to receive yet)", async () => {
    const owner = await makeOwner({ username: "initiator4", email: "initiator4@example.com" });
    const link = makeLink({ ownerId: owner.id, recipientPublicKey: null });

    expect(await canReceive(link, owner.id)).toBe(true);
    expect(await canReceive(link, "stranger-id")).toBe(false);
  });
});

// Finding F6: unifies the masking rule GET /:slug and upload-url already
// apply inline, so every other route reading a link on a caller's behalf
// (downloads.ts, events.ts, links.ts's GET .../drops and DELETE /:slug) can
// reuse the exact same decision instead of re-deriving it.
describe("shouldMaskAsNotFound", () => {
  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("is always false for an anonymous (ownerless) link, regardless of caller identity", async () => {
    const link = makeLink({ ownerId: null, visibility: "contacts-only" });

    expect(await shouldMaskAsNotFound(link, undefined)).toBe(false);
    expect(await shouldMaskAsNotFound(link, "some-random-id")).toBe(false);
  });

  it("is false for the true owner, even on their own contacts-only link", async () => {
    const owner = await makeOwner({ username: "maskowner1", email: "maskowner1@example.com" });
    const link = makeLink({ ownerId: owner.id, visibility: "contacts-only" });

    expect(await shouldMaskAsNotFound(link, owner.id)).toBe(false);
  });

  it("is true for a non-contact, non-owner caller on a contacts-only link", async () => {
    const owner = await makeOwner({ username: "maskowner2", email: "maskowner2@example.com" });
    const stranger = await makeOwner({ username: "maskstranger2", email: "maskstranger2@example.com" });
    const link = makeLink({ ownerId: owner.id, visibility: "contacts-only" });

    expect(await shouldMaskAsNotFound(link, stranger.id)).toBe(true);
  });

  it("is true for an anonymous (no session) caller on a contacts-only link — an anonymous caller can never be a contact", async () => {
    const owner = await makeOwner({ username: "maskowner3", email: "maskowner3@example.com" });
    const link = makeLink({ ownerId: owner.id, visibility: "contacts-only" });

    expect(await shouldMaskAsNotFound(link, undefined)).toBe(true);
    expect(await shouldMaskAsNotFound(link, null)).toBe(true);
  });

  it("is false for an accepted contact on a contacts-only link", async () => {
    const owner = await makeOwner({ username: "maskowner4", email: "maskowner4@example.com" });
    const friend = await makeOwner({ username: "maskfriend4", email: "maskfriend4@example.com" });
    await prisma.contact.create({ data: { userId: friend.id, contactUserId: owner.id, status: "accepted" } });
    const link = makeLink({ ownerId: owner.id, visibility: "contacts-only" });

    expect(await shouldMaskAsNotFound(link, friend.id)).toBe(false);
  });

  it("is false for a non-owner, non-contact caller on a PUBLIC link — visibility alone never masks a public link", async () => {
    const owner = await makeOwner({ username: "maskowner5", email: "maskowner5@example.com" });
    const stranger = await makeOwner({ username: "maskstranger5", email: "maskstranger5@example.com" });
    const link = makeLink({ ownerId: owner.id, visibility: "public" });

    expect(await shouldMaskAsNotFound(link, stranger.id)).toBe(false);
  });

  it("is true for a caller with an active block relationship, even on a PUBLIC link — a block overrides visibility", async () => {
    const owner = await makeOwner({ username: "maskowner6", email: "maskowner6@example.com" });
    const blocker = await makeOwner({ username: "maskblocker6", email: "maskblocker6@example.com" });
    await prisma.contact.create({
      data: { userId: blocker.id, contactUserId: owner.id, status: "blocked", blockedByUserId: blocker.id },
    });
    const link = makeLink({ ownerId: owner.id, visibility: "public" });

    expect(await shouldMaskAsNotFound(link, blocker.id)).toBe(true);
  });

  it("is true for the other direction of a block relationship too (owner blocked the caller)", async () => {
    const owner = await makeOwner({ username: "maskowner7", email: "maskowner7@example.com" });
    const blocked = await makeOwner({ username: "maskblocked7", email: "maskblocked7@example.com" });
    await prisma.contact.create({
      data: { userId: owner.id, contactUserId: blocked.id, status: "blocked", blockedByUserId: owner.id },
    });
    const link = makeLink({ ownerId: owner.id, visibility: "public" });

    expect(await shouldMaskAsNotFound(link, blocked.id)).toBe(true);
  });

  it("is true for a block even between parties who were previously accepted contacts on a contacts-only link", async () => {
    const owner = await makeOwner({ username: "maskowner8", email: "maskowner8@example.com" });
    const friend = await makeOwner({ username: "maskfriend8", email: "maskfriend8@example.com" });
    await prisma.contact.create({
      data: { userId: friend.id, contactUserId: owner.id, status: "blocked", blockedByUserId: owner.id },
    });
    const link = makeLink({ ownerId: owner.id, visibility: "contacts-only" });

    expect(await shouldMaskAsNotFound(link, friend.id)).toBe(true);
  });
});

describe("hasEverHadMessage", () => {
  it("is false only for a drop that never had a message (default sealed status, no ciphertext)", () => {
    expect(hasEverHadMessage({ encryptedMessage: null, messageEnvelopeStatus: "sealed" })).toBe(false);
  });

  it("is true while a message is still sealed and its ciphertext is present", () => {
    expect(hasEverHadMessage({ encryptedMessage: "ciphertext", messageEnvelopeStatus: "sealed" })).toBe(true);
  });

  it("is true once a message has been delivered (ciphertext scrubbed)", () => {
    expect(hasEverHadMessage({ encryptedMessage: null, messageEnvelopeStatus: "delivered" })).toBe(true);
  });

  // The case lib/inbox.test.ts's Fix-4 regression test guards from the other
  // side (getInboxForUser's hadMessage, now delegating to this same helper).
  it("is true for a message that was shredded without ever being revealed (ciphertext scrubbed, never delivered)", () => {
    expect(hasEverHadMessage({ encryptedMessage: null, messageEnvelopeStatus: "shredded" })).toBe(true);
  });
});

describe("recomputeDeliveryStatus", () => {
  // Inserts a real Link + Drop (recomputeDeliveryStatus always re-reads the row fresh from the
  // DB, so an in-memory makeDrop() object won't do). Mirrors the required-field shape other
  // lib tests in this file/accountDeletion.test.ts already insert with; only the fields the CAS
  // derivation actually reads are overridable per test.
  async function createDrop(overrides: Partial<Drop> = {}) {
    const link = await prisma.link.create({
      data: { slug: `recompute-${Math.random().toString(36).slice(2)}`, mode: "one-time", recipientPublicKey: "x", retentionDays: 7 },
    });
    const drop = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "sender-pk",
        s3Key: `${link.id}/drop1`,
        archiveNonce: "archive-nonce",
        contentMD5: "hash",
        encryptedMetadata: "meta-cipher",
        metadataNonce: "meta-nonce",
        fileSize: 1024,
        fileUploadStatus: "complete",
        deliveryStatus: "sent",
        messageEnvelopeStatus: "sealed",
        fileEnvelopeStatus: "sealed",
        ...overrides,
      },
    });
    return { link, drop };
  }

  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("reaches delivered from fileEnvelopeStatus alone when there is no message", async () => {
    const { link, drop } = await createDrop({
      encryptedMessage: null,
      fileEnvelopeStatus: "delivered",
      deliveryStatus: "sent",
    });

    await recomputeDeliveryStatus(drop.id, link.id);

    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.deliveryStatus).toBe("delivered");
  });

  it("goes to partial_delivery when exactly one envelope is delivered and a message exists", async () => {
    const { link, drop } = await createDrop({
      encryptedMessage: "cipher-message",
      messageEnvelopeStatus: "sealed",
      fileEnvelopeStatus: "delivered",
      deliveryStatus: "receiver_opened",
    });

    await recomputeDeliveryStatus(drop.id, link.id);

    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.deliveryStatus).toBe("partial_delivery");
  });

  it("reaches delivered only once both envelopes are delivered", async () => {
    const { link, drop } = await createDrop({
      encryptedMessage: "cipher-message",
      messageEnvelopeStatus: "delivered",
      fileEnvelopeStatus: "delivered",
      deliveryStatus: "sent",
    });

    await recomputeDeliveryStatus(drop.id, link.id);

    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.deliveryStatus).toBe("delivered");
  });

  it("never regresses an already-delivered status", async () => {
    // fileEnvelopeStatus flipped back to "shredded" by a test setup that shouldn't happen in
    // practice — still must not regress deliveryStatus off of "delivered".
    const { link, drop } = await createDrop({
      encryptedMessage: null,
      messageEnvelopeStatus: "sealed",
      fileEnvelopeStatus: "shredded",
      deliveryStatus: "delivered",
    });

    await recomputeDeliveryStatus(drop.id, link.id);

    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.deliveryStatus).toBe("delivered");
  });

  it("does nothing when neither envelope is delivered yet", async () => {
    const { link, drop } = await createDrop({
      encryptedMessage: "cipher-message",
      messageEnvelopeStatus: "sealed",
      fileEnvelopeStatus: "sealed",
      deliveryStatus: "receiver_opened",
    });

    await recomputeDeliveryStatus(drop.id, link.id);

    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.deliveryStatus).toBe("receiver_opened");
  });

  it("caps at partial_delivery (not delivered) when the message was shredded without ever being delivered", async () => {
    // Drop with a message that's been shredded (scrubbed, never revealed): messageEnvelopeStatus:
    // "shredded", encryptedMessage: null (already scrubbed), fileEnvelopeStatus just set to
    // "delivered" (the file side succeeded), deliveryStatus starting below "partial_delivery"
    // (e.g. "sent" or "receiver_opened").
    const { link, drop } = await createDrop({
      encryptedMessage: null,
      messageEnvelopeStatus: "shredded",
      fileEnvelopeStatus: "delivered",
      deliveryStatus: "receiver_opened",
    });

    await recomputeDeliveryStatus(drop.id, link.id);

    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.deliveryStatus).toBe("partial_delivery");
  });
});
