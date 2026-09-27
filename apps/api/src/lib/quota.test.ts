import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import {
  chargedBytes,
  deleteDropReleasingQuota,
  deleteLinkReleasingQuota,
  isChargedStatus,
  scrubDropContent,
} from "./quota";

describe("isChargedStatus", () => {
  it("is false for uploading (in-flight, not yet charged)", () => {
    expect(isChargedStatus("uploading")).toBe(false);
  });

  it("is true for complete (charged on /complete)", () => {
    expect(isChargedStatus("complete")).toBe(true);
  });

  it("is false for reserved (not yet a real transfer attempt)", () => {
    expect(isChargedStatus("reserved")).toBe(false);
  });
});

describe("scrubDropContent", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  async function createOwner(suffix: string, storageUsedBytes = 0n) {
    return prisma.user.create({
      data: {
        email: `scrub-${suffix}@example.com`,
        username: `scrub-${suffix}`,
        name: "Test Owner",
        passwordHash: "hash",
        passwordSalt: "salt",
        passwordWrappedPrivateKey: "wrapped",
        recoveryWrappedPrivateKey: "recovery",
        publicKey: "pubkey",
        storageQuotaBytes: 1_000_000n,
        storageUsedBytes,
      },
    });
  }

  // Inserts a real Link + Drop (scrubDropContent always re-reads the row fresh from the DB).
  // Mirrors the required-field shape other lib tests in this file/links.test.ts already insert
  // with; only the fields the scrub decision/write actually reads are overridable per test.
  async function createDrop(ownerId: string | null, overrides: Record<string, unknown> = {}) {
    const link = await prisma.link.create({
      data: {
        ownerId,
        slug: `scrub-${Math.random().toString(36).slice(2)}`,
        mode: "permanent",
        recipientPublicKey: "x",
        retentionDays: 7,
      },
    });
    const drop = await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "sender-pk",
        s3Key: `${link.id}/drop1`,
        archiveNonce: "archive-nonce",
        contentMD5: "hash",
        encryptedMessage: "cipher-message",
        messageNonce: "msg-nonce",
        encryptedMetadata: "meta-cipher",
        metadataNonce: "meta-nonce",
        fileSize: 100,
        fileUploadStatus: "complete",
        messageEnvelopeStatus: "sealed",
        fileEnvelopeStatus: "sealed",
        ...overrides,
      },
    });
    return { link, drop };
  }

  it("nulls ciphertext columns and sets shredded for a sealed drop", async () => {
    const { drop } = await createDrop(null);

    const result = await scrubDropContent(drop.id);

    expect(result).toEqual({ ownerId: null, s3Key: expect.any(String) });
    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.encryptedMessage).toBeNull();
    expect(updated.messageNonce).toBeNull();
    expect(updated.messageEnvelopeStatus).toBe("shredded");
    expect(updated.fileEnvelopeStatus).toBe("shredded");
    expect(updated.contentDeletedAt).not.toBeNull();
  });

  it("does not overwrite an already-delivered envelope with shredded", async () => {
    const { drop } = await createDrop(null, {
      messageEnvelopeStatus: "delivered",
      fileEnvelopeStatus: "sealed",
    });

    await scrubDropContent(drop.id);

    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.messageEnvelopeStatus).toBe("delivered");
    expect(updated.fileEnvelopeStatus).toBe("shredded");
  });

  it("returns null and does nothing when both envelopes are already terminal", async () => {
    const { drop } = await createDrop(null, {
      fileEnvelopeStatus: "delivered",
      messageEnvelopeStatus: "shredded",
    });

    const result = await scrubDropContent(drop.id);

    expect(result).toBeNull();
  });

  it("releases owner quota for a charged owned drop", async () => {
    const fileSize = 100;
    const owner = await createOwner("charged", chargedBytes(fileSize));
    const { drop } = await createDrop(owner.id, { fileSize, fileUploadStatus: "complete" });

    const before = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    await scrubDropContent(drop.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });

    expect(after.storageUsedBytes).toBeLessThan(before.storageUsedBytes);
  });

  it("does not touch quota for an anonymous drop", async () => {
    const { drop } = await createDrop(null);

    const result = await scrubDropContent(drop.id);

    expect(result!.ownerId).toBeNull();
  });

  it("returns null and does not reset contentDeletedAt for a message-less drop whose file was already delivered", async () => {
    // Drop with encryptedMessage: null, messageEnvelopeStatus: "sealed" (default, no message ever),
    // fileEnvelopeStatus: "delivered", contentDeletedAt already set to some past timestamp (from the
    // original complete-download call).
    const { drop } = await createDrop(null, {
      encryptedMessage: null,
      messageNonce: null,
      messageEnvelopeStatus: "sealed",
      fileEnvelopeStatus: "delivered",
      contentDeletedAt: new Date(Date.now() - 60_000),
    });

    const before = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    const result = await scrubDropContent(drop.id);
    expect(result).toBeNull();
    const after = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(after.contentDeletedAt?.getTime()).toBe(before.contentDeletedAt?.getTime()); // untouched, not reset
    expect(after.messageEnvelopeStatus).toBe("sealed"); // never touched — there was never a message
  });

  it("shreds only the message, and releases no quota, for an owned drop whose file was already delivered", async () => {
    // The file side's charge was already released when complete-download's CAS won; a later
    // scrub that only resolves the still-unrevealed message must not release it again.
    const owner = await createOwner("msg-only", 0n);
    const { drop } = await createDrop(owner.id, { fileEnvelopeStatus: "delivered", messageEnvelopeStatus: "sealed" });

    const result = await scrubDropContent(drop.id);

    expect(result).not.toBeNull();
    const updated = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(updated.fileEnvelopeStatus).toBe("delivered");
    expect(updated.messageEnvelopeStatus).toBe("shredded");
    expect(updated.encryptedMessage).toBeNull();
    expect(updated.contentDeletedAt).not.toBeNull();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.storageUsedBytes).toBe(0n);
  });
});

// Finding I1: the hard-delete helpers must not release a charge that was already released
// when the drop's file envelope first reached a terminal state (e.g. complete-download).
describe("deleteLinkReleasingQuota / deleteDropReleasingQuota never double-release", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  // Owner with one delivered drop (its charge already released at delivery) and one
  // still-sealed drop (still charged): storageUsedBytes reflects only the sealed one.
  async function seed(suffix: string) {
    const fileSize = 100;
    const owner = await prisma.user.create({
      data: {
        email: `release-${suffix}@example.com`,
        username: `release-${suffix}`,
        name: "Test Owner",
        passwordHash: "hash",
        passwordSalt: "salt",
        passwordWrappedPrivateKey: "wrapped",
        recoveryWrappedPrivateKey: "recovery",
        publicKey: "pubkey",
        storageQuotaBytes: 1_000_000n,
        storageUsedBytes: chargedBytes(fileSize),
      },
    });
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: `release-${suffix}`, mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    const base = {
      linkId: link.id,
      senderPublicKey: "sender-pk",
      archiveNonce: "archive-nonce",
      contentMD5: "hash",
      encryptedMetadata: "meta-cipher",
      metadataNonce: "meta-nonce",
      fileSize,
      fileUploadStatus: "complete",
    };
    const delivered = await prisma.drop.create({
      data: { ...base, s3Key: `${link.id}/delivered`, fileEnvelopeStatus: "delivered" },
    });
    const sealed = await prisma.drop.create({
      data: { ...base, s3Key: `${link.id}/sealed`, fileEnvelopeStatus: "sealed" },
    });
    return { owner, link, delivered, sealed, fileSize };
  }

  it("deleteDropReleasingQuota leaves quota unchanged for an already-delivered drop", async () => {
    const { owner, delivered, fileSize } = await seed("drop-delivered");

    expect(await deleteDropReleasingQuota(delivered.id, owner.id)).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.storageUsedBytes).toBe(chargedBytes(fileSize)); // unchanged
  });

  it("deleteDropReleasingQuota still releases a still-sealed charged drop", async () => {
    const { owner, sealed } = await seed("drop-sealed");

    await deleteDropReleasingQuota(sealed.id, owner.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.storageUsedBytes).toBe(0n);
  });

  it("deleteLinkReleasingQuota releases only the still-charged drop, not the delivered one", async () => {
    const { owner, link } = await seed("link");

    await deleteLinkReleasingQuota(link);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.storageUsedBytes).toBe(0n); // exactly the sealed drop's charge, not two
    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
  });
});
