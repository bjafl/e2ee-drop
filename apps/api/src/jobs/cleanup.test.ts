// apps/api/src/jobs/cleanup.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("../lib/storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { deleteObject } from "../lib/storage";
import { UPLOAD_RESERVATION_WINDOW_MS } from "../lib/quota";
import { runCleanup, sweepExpiredDrops, sweepAbandonedUploads, pruneExpiredPasswordResetTokens } from "./cleanup";

const deleteObjectMock = vi.mocked(deleteObject);

describe("runCleanup", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("deletes expired one-time links and their drops", async () => {
    await prisma.link.create({
      data: {
        slug: "expired-link",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.link.create({
      data: {
        slug: "fresh-link",
        mode: "one-time",
        recipientPublicKey: "x",
        retentionDays: 7,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await runCleanup();

    expect(result.deletedLinks).toBe(1);
    expect(await prisma.link.findFirst({ where: { slug: "expired-link" } })).toBeNull();
    expect(await prisma.link.findFirst({ where: { slug: "fresh-link" } })).not.toBeNull();
  });
});

describe("sweepExpiredDrops", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  const dropDefaults = {
    senderPublicKey: "c2VuZGVy",
    archiveNonce: "bm9uY2U=",
    encryptedMetadata: "ZW5jcnlwdGVkLW1ldGFkYXRh",
    metadataNonce: "bWV0YWRhdGEtbm9uY2U=",
    fileSize: 1024,
    contentMD5: "bWQ1",
  };

  it("deletes a drop on a permanent link once it is older than the global retention default", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-1", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    const oldDrop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/old`,
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago, default retention is 7
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.deletedDrops).toBe(1);
    expect(await prisma.drop.findUnique({ where: { id: oldDrop.id } })).toBeNull();
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
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
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.deletedDrops).toBe(0);
    expect(await prisma.drop.findUnique({ where: { id: freshDrop.id } })).not.toBeNull();
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
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago, override is 1 day
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.deletedDrops).toBe(1);
    expect(await prisma.drop.findUnique({ where: { id: drop.id } })).toBeNull();
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

    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
    expect(await used(owner.id)).toBe(BASELINE);
  });

  it("runCleanup does not release anything for a never-confirmed (uploading) drop", async () => {
    const owner = await createOwner("ot-uploading", BASELINE);
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "quota-ot-2", mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.drop.create({ data: dropData(link.id, "a", 500, "uploading") });

    await runCleanup();

    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
    expect(await used(owner.id)).toBe(BASELINE);
  });

  it("runCleanup leaves anonymous expired links' cleanup unchanged and touches no user", async () => {
    const bystander = await createOwner("anon-bystander", BASELINE);
    const link = await prisma.link.create({
      data: { slug: "quota-anon-ot", mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.drop.create({ data: dropData(link.id, "a", 500, "uploaded") });

    await runCleanup();

    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
    expect(await used(bystander.id)).toBe(BASELINE);
  });

  it("sweepExpiredDrops releases exactly the charged, retention-expired drops on an owned permanent link", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // Charged: 300+16 (uploaded, expired), 400+16 (downloading, expired), 900+16 (uploaded, fresh).
    const owner = await createOwner("perm", BASELINE + 316n + 416n + 916n);
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "quota-perm", mode: "permanent", recipientPublicKey: "x", retentionDays: 7 },
    });
    await prisma.drop.create({ data: dropData(link.id, "uploaded-old", 300, "uploaded", old) });
    await prisma.drop.create({ data: dropData(link.id, "downloading-old", 400, "downloading", old) });
    await prisma.drop.create({ data: dropData(link.id, "uploading-old", 700, "uploading", old) });
    const fresh = await prisma.drop.create({ data: dropData(link.id, "uploaded-fresh", 900, "uploaded") });

    const result = await sweepExpiredDrops();

    expect(result.deletedDrops).toBe(3);
    expect((await prisma.drop.findMany({ where: { linkId: link.id } })).map((d) => d.id)).toEqual([fresh.id]);
    expect(await used(owner.id)).toBe(BASELINE + 916n);
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
