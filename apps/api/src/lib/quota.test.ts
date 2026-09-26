import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { chargedBytes, isChargedStatus, scrubDropContent } from "./quota";

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
});
