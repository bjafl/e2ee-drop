// apps/api/src/lib/links.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { deleteLinkIfExists } from "./links";

describe("deleteLinkIfExists", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("deletes an existing link", async () => {
    const link = await prisma.link.create({
      data: { slug: "to-delete", mode: "one-time", recipientPublicKey: "x" },
    });

    await deleteLinkIfExists(link.id);

    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
  });

  it("does not throw when called twice for the same id (lost race with another deleter)", async () => {
    const link = await prisma.link.create({
      data: { slug: "already-gone", mode: "one-time", recipientPublicKey: "x" },
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
