// apps/api/src/jobs/cleanup.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("../lib/storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { runCleanup } from "./cleanup";

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
