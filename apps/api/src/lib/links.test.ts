// apps/api/src/lib/links.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, type Drop } from "@e2ee-drop/db";
import { deleteLinkIfExists, toDropSummary } from "./links";

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
