// apps/api/src/routes/account.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { prisma } from "@e2ee-drop/db";
import { hashPassword } from "../lib/passwordAuth";

vi.mock("../lib/accountDeletion", () => ({
  cascadeDeleteUserLinks: vi.fn().mockResolvedValue(undefined),
}));

import { cascadeDeleteUserLinks } from "../lib/accountDeletion";
import { registerAccountRoutes } from "./account";

async function buildTestServer(userId: string) {
  const server = Fastify();
  server.decorate("requireAuth", async (request: any) => {
    request.user = { id: userId };
  });
  registerAccountRoutes(server);
  return server;
}

// A backend-only test doesn't derive authKey via the real client-side
// Argon2id/HKDF pipeline (see apps/web/src/lib/keyWrapping.ts) — it only
// needs hashPassword() used consistently as the stored hash and the same
// arbitrary string sent back as authKey for the success case, mirroring the
// established pattern in auth.test.ts/passwordReset.test.ts.
const CORRECT_AUTH_KEY = "some-arbitrary-string";

async function createTestUser(email: string, username: string) {
  return prisma.user.create({
    data: {
      email,
      username,
      name: "Delete Me",
      passwordHash: await hashPassword(CORRECT_AUTH_KEY),
      publicKey: "cHVibGlj",
      passwordWrappedPrivateKey: "d3JhcHBlZA==",
      recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
      passwordSalt: "c2FsdA==",
      storageQuotaBytes: 1000,
    },
  });
}

describe("DELETE /api/account", () => {
  let userId: string;

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    vi.mocked(cascadeDeleteUserLinks).mockClear().mockResolvedValue(undefined);

    const user = await createTestUser("delete-me@example.com", "delete-me");
    userId = user.id;
  });

  it("deletes the account, its sessions, and both directions of its contacts when the authKey is correct", async () => {
    await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 60_000) } });
    const otherUser = await createTestUser("other@example.com", "other-user");
    await prisma.contact.create({ data: { userId, contactUserId: otherUser.id, status: "pending" } });
    await prisma.contact.create({ data: { userId: otherUser.id, contactUserId: userId, status: "pending" } });

    const server = await buildTestServer(userId);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { authKey: CORRECT_AUTH_KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(cascadeDeleteUserLinks).toHaveBeenCalledWith(userId);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.session.findMany({ where: { userId } })).toHaveLength(0);
    expect(
      await prisma.contact.findMany({ where: { OR: [{ userId }, { contactUserId: userId }] } })
    ).toHaveLength(0);
    // the other user's own row is untouched
    expect(await prisma.user.findUnique({ where: { id: otherUser.id } })).not.toBeNull();
  });

  it("rejects deletion with the wrong authKey and leaves the account intact", async () => {
    const server = await buildTestServer(userId);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { authKey: "wrong-string" },
    });

    expect(response.statusCode).toBe(403);
    expect(cascadeDeleteUserLinks).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it("does not delete the user row if cascadeDeleteUserLinks fails", async () => {
    vi.mocked(cascadeDeleteUserLinks).mockRejectedValueOnce(new Error("MinIO unavailable"));

    const server = await buildTestServer(userId);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { authKey: CORRECT_AUTH_KEY },
    });

    expect(response.statusCode).toBe(500);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});
