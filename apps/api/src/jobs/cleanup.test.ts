// apps/api/src/jobs/cleanup.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("../lib/storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { deleteObject } from "../lib/storage";
import { UPLOAD_RESERVATION_WINDOW_MS, chargedBytes } from "../lib/quota";
import {
  runCleanup,
  sweepExpiredDrops,
  sweepAbandonedUploads,
  pruneExpiredPasswordResetTokens,
  purgeAuditExpiredRows,
} from "./cleanup";

const deleteObjectMock = vi.mocked(deleteObject);

describe("runCleanup", () => {
  const dropDefaults = {
    senderPublicKey: "c2VuZGVy",
    archiveNonce: "bm9uY2U=",
    encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
    metadataNonce: "bWV0YWRhdGEtbm9uY2U=",
    fileSize: 1024,
    contentMD5: "bWQ1",
  };

  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany({ where: { username: { startsWith: "run-cleanup-" } } });
    deleteObjectMock.mockClear();
  });

  async function createOwner(suffix: string, used: bigint) {
    return prisma.user.create({
      data: {
        email: `run-cleanup-${suffix}@example.com`,
        username: `run-cleanup-${suffix}`,
        name: "Q",
        passwordHash: "h",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
        storageQuotaBytes: 10_000_000,
        storageUsedBytes: used,
      },
    });
  }

  it("scrubs an expired one-time link's drop instead of deleting the row", async () => {
    const link = await prisma.link.create({
      data: {
        slug: "expired-scrub",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/a`,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "sealed",
      },
    });

    const result = await runCleanup();

    expect(result.scrubbedLinks).toBe(1);
    const persistedLink = await prisma.link.findUnique({ where: { slug: "expired-scrub" } });
    expect(persistedLink).not.toBeNull(); // row survives
    const persistedDrop = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(persistedDrop.fileEnvelopeStatus).toBe("shredded");
    expect(persistedDrop.contentDeletedAt).not.toBeNull();
  });

  it("treats an owned expired one-time link identically to an anonymous one", async () => {
    const owner = await createOwner("owned-ot", 100_000n);
    const link = await prisma.link.create({
      data: {
        ownerId: owner.id,
        slug: "expired-owned",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/a`,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "sealed",
      },
    });

    const before = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    await runCleanup();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });

    expect(after.storageUsedBytes).toBeLessThan(before.storageUsedBytes);
    const persistedLink = await prisma.link.findUnique({ where: { slug: "expired-owned" } });
    expect(persistedLink).not.toBeNull(); // row survives — this is the behavior change from today
  });

  it("does not re-scrub a drop that is already delivered", async () => {
    const link = await prisma.link.create({
      data: {
        slug: "expired-delivered",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/already-delivered`,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "delivered",
        messageEnvelopeStatus: "delivered",
      },
    });

    const result = await runCleanup();

    expect(result.scrubbedLinks).toBe(0);
    expect(deleteObjectMock).not.toHaveBeenCalledWith(drop.s3Key);
  });

  it("leaves a still-uploading drop on an expired one-time link alone (sweepAbandonedUploads' job, not this sweep's)", async () => {
    const link = await prisma.link.create({
      data: {
        slug: "expired-uploading",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/still-uploading`,
        fileUploadStatus: "uploading",
      },
    });

    const result = await runCleanup();

    expect(result.scrubbedLinks).toBe(0);
    const persistedDrop = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(persistedDrop.contentDeletedAt).toBeNull();
    expect(persistedDrop.fileEnvelopeStatus).toBe("sealed"); // untouched, still at default
    expect(deleteObjectMock).not.toHaveBeenCalledWith(drop.s3Key);
  });

  it("deletes an expired one-time link that never received any drop (finding I3)", async () => {
    const unused = await prisma.link.create({
      data: {
        slug: "expired-unused",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    // Controls: a not-yet-expired unused one-time link, and an unused permanent-mode link,
    // must both survive — only expired, drop-less ONE-TIME links are removed.
    const notExpired = await prisma.link.create({
      data: {
        slug: "unexpired-unused",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const permanent = await prisma.link.create({
      data: { slug: "perm-unused", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });

    const result = await runCleanup();

    expect(result.scrubbedLinks).toBe(0); // nothing scrubbed — this deletion isn't counted there
    expect(await prisma.link.findUnique({ where: { id: unused.id } })).toBeNull();
    expect(await prisma.link.findUnique({ where: { id: notExpired.id } })).not.toBeNull();
    expect(await prisma.link.findUnique({ where: { id: permanent.id } })).not.toBeNull();
  });

  it("never clobbers a concurrent complete-download's 'delivered', nor releases its quota twice (finding I2)", async () => {
    // Reproduces the TOCTOU window inside scrubDropContent: its snapshot findUnique sees the
    // file side still "sealed", then — before its owner-locked scrub transaction runs — a
    // concurrent complete-download wins its own CAS (fileEnvelopeStatus -> "delivered") and
    // releases the owner's charge for this drop. The scrub's per-field CAS must re-check the
    // LIVE fileEnvelopeStatus, leave "delivered" alone, and NOT release quota a second time —
    // while still independently shredding the still-unrevealed message.
    const fileSize = dropDefaults.fileSize;
    const owner = await createOwner("i2-race", chargedBytes(fileSize));
    const link = await prisma.link.create({
      data: {
        ownerId: owner.id,
        slug: "expired-i2-race",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/i2-race`,
        encryptedMessage: "cipher-message",
        messageNonce: "msg-nonce",
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "sealed",
        messageEnvelopeStatus: "sealed",
      },
    });

    const originalFindUnique = prisma.drop.findUnique.bind(prisma.drop);
    const findUniqueSpy = vi.spyOn(prisma.drop, "findUnique").mockImplementationOnce(((args: unknown) =>
      (async () => {
        const row = await originalFindUnique(args as never);
        // Simulate complete-download landing right here: exactly its CAS, then exactly its
        // winner-only quota release (routes/downloads.ts).
        const { count } = await prisma.drop.updateMany({
          where: { id: drop.id, fileEnvelopeStatus: { notIn: ["delivered", "shredded"] } },
          data: { fileEnvelopeStatus: "delivered", contentDeletedAt: new Date() },
        });
        expect(count).toBe(1);
        await prisma.user.update({
          where: { id: owner.id },
          data: { storageUsedBytes: { decrement: chargedBytes(fileSize) } },
        });
        return row;
      })()) as typeof prisma.drop.findUnique);

    try {
      await runCleanup();
      expect(findUniqueSpy).toHaveBeenCalled(); // the race really was injected into scrubDropContent
    } finally {
      // Not findUniqueSpy.mockRestore(): on a Prisma model delegate (whose methods come from
      // a proxy, not an own property) vitest 2's restore leaves prisma.drop.findUnique
      // undefined for every later test in this file. Put the bound original back directly.
      (prisma.drop as { findUnique: unknown }).findUnique = originalFindUnique;
    }

    const persisted = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(persisted.fileEnvelopeStatus).toBe("delivered"); // not clobbered back to "shredded"
    expect(persisted.messageEnvelopeStatus).toBe("shredded"); // independent CAS still resolved it
    expect(persisted.encryptedMessage).toBeNull();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.storageUsedBytes).toBe(0n); // released once (by complete-download), not twice
  });
});

describe("sweepExpiredDrops", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    deleteObjectMock.mockClear();
  });

  const dropDefaults = {
    senderPublicKey: "c2VuZGVy",
    archiveNonce: "bm9uY2U=",
    encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
    metadataNonce: "bWV0YWRhdGEtbm9uY2U=",
    fileSize: 1024,
    contentMD5: "bWQ1",
  };

  it("scrubs a permanent link's expired drop instead of deleting it", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-1", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    const oldDrop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/old`,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "sealed",
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago, default retention is 7
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.scrubbedDrops).toBe(1);
    const persistedDrop = await prisma.drop.findUniqueOrThrow({ where: { id: oldDrop.id } });
    expect(persistedDrop.fileEnvelopeStatus).toBe("shredded");
    expect(persistedDrop.contentDeletedAt).not.toBeNull();
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull(); // row survives
  });

  it("keeps a drop that is still within the retention window", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-2", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    const freshDrop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/fresh`,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "sealed",
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.scrubbedDrops).toBe(0);
    const persistedDrop = await prisma.drop.findUniqueOrThrow({ where: { id: freshDrop.id } });
    expect(persistedDrop.contentDeletedAt).toBeNull();
    expect(persistedDrop.fileEnvelopeStatus).toBe("sealed");
    expect(deleteObjectMock).not.toHaveBeenCalledWith(freshDrop.s3Key);
  });

  it("honors a link's own retentionDays override over the global default", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-3", mode: "permanent", recipientPublicKey: "x", retentionDays: 1 },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/short-retention`,
        fileUploadStatus: "complete",
        fileEnvelopeStatus: "sealed",
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago, override is 1 day
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.scrubbedDrops).toBe(1);
    const persistedDrop = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(persistedDrop.fileEnvelopeStatus).toBe("shredded");
    expect(persistedDrop.contentDeletedAt).not.toBeNull();
  });

  it("leaves a still-uploading drop past its retention window alone (sweepAbandonedUploads' job, not this sweep's)", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-4", mode: "permanent", recipientPublicKey: "x", retentionDays: 1 },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/still-uploading`,
        fileUploadStatus: "uploading",
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago, override is 1 day
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.scrubbedDrops).toBe(0);
    const persistedDrop = await prisma.drop.findUniqueOrThrow({ where: { id: drop.id } });
    expect(persistedDrop.contentDeletedAt).toBeNull();
    expect(persistedDrop.fileEnvelopeStatus).toBe("sealed"); // untouched, still at default
    expect(deleteObjectMock).not.toHaveBeenCalledWith(drop.s3Key);
  });
});

describe("sweepAbandonedUploads", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    deleteObjectMock.mockClear();
  });

  const dropDefaults = {
    senderPublicKey: "c2VuZGVy",
    archiveNonce: "bm9uY2U=",
    encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
    metadataNonce: "bWV0YWRhdGEtbm9uY2U=",
    fileSize: 1024,
    contentMD5: "bWQ1",
  };

  async function createLink(slug: string) {
    return prisma.link.create({
      data: { slug, mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt: new Date(Date.now() + 60_000) },
    });
  }

  it("deletes a stale uploading drop past the reservation window", async () => {
    const link = await createLink("stale-uploading");
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/stale`,
        fileUploadStatus: "uploading",
        createdAt: new Date(Date.now() - UPLOAD_RESERVATION_WINDOW_MS - 60_000),
      },
    });

    const result = await sweepAbandonedUploads();

    expect(result.deletedDrops).toBe(1);
    expect(await prisma.drop.findUnique({ where: { id: drop.id } })).toBeNull();
    // Finding I2: the row was the only record of s3Key — deleting it without
    // also deleting the object would orphan it in storage forever.
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(drop.s3Key);
  });

  it("does not touch a recent uploading drop still inside its reservation window", async () => {
    const link = await createLink("fresh-uploading");
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/fresh`,
        fileUploadStatus: "uploading",
        createdAt: new Date(),
      },
    });

    const result = await sweepAbandonedUploads();

    expect(result.deletedDrops).toBe(0);
    expect(await prisma.drop.findUnique({ where: { id: drop.id } })).not.toBeNull();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("does not touch a complete drop regardless of age", async () => {
    const link = await createLink("old-complete");
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/complete`,
        fileUploadStatus: "complete",
        createdAt: new Date(Date.now() - UPLOAD_RESERVATION_WINDOW_MS - 60_000),
      },
    });

    const result = await sweepAbandonedUploads();

    expect(result.deletedDrops).toBe(0);
    expect(await prisma.drop.findUnique({ where: { id: drop.id } })).not.toBeNull();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("storage quota release", () => {
  // Every owner starts with BASELINE bytes charged for drops that are not part
  // of the test, so an over- or under-release is visible as an exact mismatch.
  const BASELINE = 100_000n;

  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany({ where: { username: { startsWith: "quota-cleanup-" } } });
  });

  async function createOwner(suffix: string, used: bigint) {
    return prisma.user.create({
      data: {
        email: `quota-cleanup-${suffix}@example.com`,
        username: `quota-cleanup-${suffix}`,
        name: "Q",
        passwordHash: "h",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
        storageQuotaBytes: 10_000_000,
        storageUsedBytes: used,
      },
    });
  }

  // `status` here is the old, pre-migration Drop.status value the test cases
  // document (e.g. "downloading"). It maps to the new fileUploadStatus the
  // same way lib/quota.ts's isChargedStatus does: anything but "uploading" is
  // charged ("complete"); deliveryStatus/envelope fields don't matter to
  // cleanup.ts or quota.ts and are left at their schema defaults.
  function dropData(linkId: string, name: string, fileSize: number, status: string, createdAt = new Date()) {
    return {
      linkId,
      senderPublicKey: "s",
      s3Key: `${linkId}/${name}`,
      archiveNonce: "n",
      encryptedMetadata: "e",
      metadataNonce: "m",
      fileSize,
      contentMD5: "m",
      fileUploadStatus: status === "uploading" ? "uploading" : "complete",
      createdAt,
    };
  }

  async function used(userId: string) {
    return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).storageUsedBytes;
  }

  it("runCleanup releases an owned expired one-time link's charged drop (fileSize + 16)", async () => {
    const owner = await createOwner("ot-charged", BASELINE + 516n);
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "quota-ot-1", mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.drop.create({ data: dropData(link.id, "a", 500, "downloaded") });

    await runCleanup();

    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull(); // row survives, scrubbed not deleted
    expect(await used(owner.id)).toBe(BASELINE);
  });

  it("runCleanup does not release anything for a never-confirmed (uploading) drop", async () => {
    const owner = await createOwner("ot-uploading", BASELINE);
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "quota-ot-2", mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.drop.create({ data: dropData(link.id, "a", 500, "uploading") });

    await runCleanup();

    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull(); // row survives, scrubbed not deleted
    expect(await used(owner.id)).toBe(BASELINE);
  });

  it("runCleanup leaves anonymous expired links' cleanup unchanged and touches no user", async () => {
    const bystander = await createOwner("anon-bystander", BASELINE);
    const link = await prisma.link.create({
      data: { slug: "quota-anon-ot", mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.drop.create({ data: dropData(link.id, "a", 500, "uploaded") });

    await runCleanup();

    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull(); // row survives, scrubbed not deleted
    expect(await used(bystander.id)).toBe(BASELINE);
  });

  it("sweepExpiredDrops releases exactly the charged, retention-expired drops on an owned permanent link", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // Charged: 300+16 (uploaded, expired), 400+16 (downloading, expired), 900+16 (uploaded, fresh).
    const owner = await createOwner("perm", BASELINE + 316n + 416n + 916n);
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "quota-perm", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    const uploadedOld = await prisma.drop.create({ data: dropData(link.id, "uploaded-old", 300, "uploaded", old) });
    const downloadingOld = await prisma.drop.create({ data: dropData(link.id, "downloading-old", 400, "downloading", old) });
    // Still "uploading" and past retention — left alone here (sweepAbandonedUploads' job), so it
    // stays uncharged and untouched rather than being scrubbed.
    const uploadingOld = await prisma.drop.create({ data: dropData(link.id, "uploading-old", 700, "uploading", old) });
    const fresh = await prisma.drop.create({ data: dropData(link.id, "uploaded-fresh", 900, "uploaded") });

    const result = await sweepExpiredDrops();

    expect(result.scrubbedDrops).toBe(2);
    // Rows survive as the audit trail — scrubbed, not deleted.
    expect((await prisma.drop.findMany({ where: { linkId: link.id } })).map((d) => d.id).sort()).toEqual(
      [uploadedOld.id, downloadingOld.id, uploadingOld.id, fresh.id].sort()
    );
    const persistedUploadedOld = await prisma.drop.findUniqueOrThrow({ where: { id: uploadedOld.id } });
    expect(persistedUploadedOld.contentDeletedAt).not.toBeNull();
    expect(persistedUploadedOld.fileEnvelopeStatus).toBe("shredded");
    const persistedDownloadingOld = await prisma.drop.findUniqueOrThrow({ where: { id: downloadingOld.id } });
    expect(persistedDownloadingOld.contentDeletedAt).not.toBeNull();
    expect(persistedDownloadingOld.fileEnvelopeStatus).toBe("shredded");
    const persistedUploadingOld = await prisma.drop.findUniqueOrThrow({ where: { id: uploadingOld.id } });
    expect(persistedUploadingOld.contentDeletedAt).toBeNull();
    expect(persistedUploadingOld.fileEnvelopeStatus).toBe("sealed");
    const persistedFresh = await prisma.drop.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(persistedFresh.contentDeletedAt).toBeNull();
    expect(await used(owner.id)).toBe(BASELINE + 916n);
  });
});

describe("purgeAuditExpiredRows", () => {
  const dropDefaults = {
    senderPublicKey: "c2VuZGVy",
    archiveNonce: "bm9uY2U=",
    encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
    metadataNonce: "bWV0YWRhdGEtbm9uY2U=",
    fileSize: 1024,
    contentMD5: "bWQ1",
    fileUploadStatus: "complete",
    fileEnvelopeStatus: "shredded",
  };

  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  const AUDIT_RETENTION_DAYS = 30; // env.ts default

  it("hard-deletes a drop whose contentDeletedAt is past the audit retention window", async () => {
    const link = await prisma.link.create({
      data: { slug: "audit-expired", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/audit-expired`,
        contentDeletedAt: new Date(Date.now() - (AUDIT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
      },
    });

    const result = await purgeAuditExpiredRows();

    expect(result.purgedDrops).toBe(1);
    expect(await prisma.drop.findUnique({ where: { id: drop.id } })).toBeNull();
  });

  it("does not purge a drop scrubbed within the retention window", async () => {
    const link = await prisma.link.create({
      data: { slug: "audit-fresh", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/audit-fresh`,
        contentDeletedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    });

    const result = await purgeAuditExpiredRows();

    expect(result.purgedDrops).toBe(0);
    expect(await prisma.drop.findUnique({ where: { id: drop.id } })).not.toBeNull();
  });

  it("also purges the Link when its sole one-time drop is purged", async () => {
    const link = await prisma.link.create({
      data: {
        slug: "audit-one-time",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/audit-one-time`,
        contentDeletedAt: new Date(Date.now() - (AUDIT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
      },
    });

    const result = await purgeAuditExpiredRows();

    expect(result.purgedDrops).toBe(1);
    expect(result.purgedLinks).toBe(1);
    expect(await prisma.link.findUnique({ where: { slug: "audit-one-time" } })).toBeNull();
  });

  it("never purges a permanent link's own row, only its expired drops", async () => {
    const link = await prisma.link.create({
      data: { slug: "audit-permanent", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/audit-permanent`,
        contentDeletedAt: new Date(Date.now() - (AUDIT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
      },
    });

    const result = await purgeAuditExpiredRows();

    expect(result.purgedDrops).toBe(1);
    expect(result.purgedLinks).toBe(0);
    expect(await prisma.link.findUnique({ where: { slug: "audit-permanent" } })).not.toBeNull();
  });

  it("tolerates a drop already removed by a concurrent path between the scan and the delete", async () => {
    // Reproduces the actual TOCTOU window: findMany() sees the row, then — before
    // purgeAuditExpiredRows' per-row deleteMany runs — a concurrent DELETE /api/links/:slug
    // on this drop's one-time link removes both rows via the schema's onDelete: Cascade
    // (Drop.linkId -> Link). purgeAuditExpiredRows must not throw, and must report this
    // row as not purged by IT (already gone via the concurrent path), consistent with the
    // deleteMany-based fix: a zero-row match is silently skipped rather than throwing P2025.
    const link = await prisma.link.create({
      data: {
        slug: "audit-toctou",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/audit-toctou`,
        contentDeletedAt: new Date(Date.now() - (AUDIT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
      },
    });

    const originalFindMany = prisma.drop.findMany.bind(prisma.drop);
    const findManySpy = vi.spyOn(prisma.drop, "findMany").mockImplementationOnce(((args: unknown) =>
      (async () => {
        const rows = await originalFindMany(args as never);
        // Simulate the concurrent DELETE /api/links/:slug landing right here, between this
        // findMany and purgeAuditExpiredRows' subsequent per-row delete loop.
        await prisma.link.delete({ where: { id: link.id } });
        return rows;
      })()) as typeof prisma.drop.findMany);

    try {
      const result = await purgeAuditExpiredRows();
      expect(result.purgedDrops).toBe(0); // gone by the time this sweep's deleteMany ran
      expect(result.purgedLinks).toBe(0); // cascaded away by the concurrent delete, not by this sweep
      expect(await prisma.link.findUnique({ where: { slug: "audit-toctou" } })).toBeNull();
    } finally {
      findManySpy.mockRestore();
    }
  });
});

describe("pruneExpiredPasswordResetTokens", () => {
  beforeEach(async () => {
    await prisma.passwordResetToken.deleteMany();
    await prisma.user.deleteMany({ where: { username: "reset-token-owner" } });
  });

  it("deletes expired password-reset tokens and keeps unexpired ones", async () => {
    const user = await prisma.user.create({
      data: {
        email: "reset-token-owner@example.com",
        username: "reset-token-owner",
        name: "T",
        passwordHash: "h",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
        storageQuotaBytes: 1000,
      },
    });
    const expired = await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: "expired-hash", expiresAt: new Date(Date.now() - 1000) },
    });
    const fresh = await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: "fresh-hash", expiresAt: new Date(Date.now() + 60_000) },
    });

    const result = await pruneExpiredPasswordResetTokens();

    expect(result.deletedTokens).toBe(1);
    expect(await prisma.passwordResetToken.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.passwordResetToken.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });
});
