// apps/api/src/jobs/cleanup.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("../lib/storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { runCleanup, sweepExpiredDrops } from "./cleanup";

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
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.link.create({
      data: {
        slug: "fresh-link",
        mode: "one-time",
        recipientPublicKey: "x",
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
    nonce: "bm9uY2U=",
    fileName: "report.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
    contentMD5: "bWQ1",
    status: "uploaded" as const,
  };

  it("deletes a drop on a permanent link once it is older than the global retention default", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-1", mode: "permanent", recipientPublicKey: "x" },
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
      data: { slug: "perm-2", mode: "permanent", recipientPublicKey: "x" },
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
