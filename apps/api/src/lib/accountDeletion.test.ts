// apps/api/src/lib/accountDeletion.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("./storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { cascadeDeleteUserLinks } from "./accountDeletion";
import { deleteObject } from "./storage";

async function createTestUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `user-${suffix}@example.com`,
      username: `user-${suffix}`,
      name: "Test User",
      passwordHash: "hash",
      passwordSalt: "salt",
      passwordWrappedPrivateKey: "wrapped",
      recoveryWrappedPrivateKey: "recovery",
      publicKey: "pubkey",
      storageQuotaBytes: 1000,
    },
  });
}

describe("cascadeDeleteUserLinks", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    vi.clearAllMocks();
  });

  it("deletes all of a user's links, their drops, and the drops' MinIO objects, leaving the user row intact", async () => {
    const user = await createTestUser("a");
    const otherUser = await createTestUser("b");

    const link = await prisma.link.create({
      data: { ownerId: user.id, slug: "mine", mode: "permanent", recipientPublicKey: "x" },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "s",
        s3Key: `${link.id}/drop1`,
        nonce: "n",
        fileName: "f",
        fileSize: 1,
        mimeType: "text/plain",
        contentMD5: "m",
      },
    });
    const otherLink = await prisma.link.create({
      data: { ownerId: otherUser.id, slug: "theirs", mode: "permanent", recipientPublicKey: "y" },
    });

    await cascadeDeleteUserLinks(user.id);

    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
    expect(await prisma.link.findUnique({ where: { id: otherLink.id } })).not.toBeNull();
    expect(deleteObject).toHaveBeenCalledWith(`${link.id}/drop1`);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it("returns storageUsedBytes to 0 by releasing exactly the charged drops, and leaves other users alone", async () => {
    // Charged (status != "uploading") drops: 10+16, 20+16, 30+16 = 108 bytes.
    const user = await prisma.user.create({
      data: {
        email: "quota-cascade@example.com",
        username: "quota-cascade",
        name: "Q",
        passwordHash: "h",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
        storageQuotaBytes: 1000,
        storageUsedBytes: 108,
      },
    });
    const other = await createTestUser("other");
    await prisma.user.update({ where: { id: other.id }, data: { storageUsedBytes: 555 } });

    const perm = await prisma.link.create({
      data: { ownerId: user.id, slug: "cascade-perm", mode: "permanent", recipientPublicKey: "x" },
    });
    const oneTime = await prisma.link.create({
      data: {
        ownerId: user.id,
        slug: "cascade-ot",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const base = { senderPublicKey: "s", nonce: "n", fileName: "f", mimeType: "text/plain", contentMD5: "m" };
    await prisma.drop.createMany({
      data: [
        { ...base, linkId: perm.id, s3Key: `${perm.id}/a`, fileSize: 10, status: "uploaded" },
        { ...base, linkId: perm.id, s3Key: `${perm.id}/b`, fileSize: 20, status: "downloaded" },
        { ...base, linkId: perm.id, s3Key: `${perm.id}/c`, fileSize: 999, status: "uploading" },
        { ...base, linkId: oneTime.id, s3Key: `${oneTime.id}/d`, fileSize: 30, status: "downloading" },
      ],
    });

    await cascadeDeleteUserLinks(user.id);

    expect(await prisma.link.count({ where: { ownerId: user.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).storageUsedBytes).toBe(0n);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).storageUsedBytes).toBe(555n);

    // Idempotent: a retry after everything is gone releases nothing more.
    await cascadeDeleteUserLinks(user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).storageUsedBytes).toBe(0n);
  });
});
