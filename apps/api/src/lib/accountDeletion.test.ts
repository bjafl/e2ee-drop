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
});
