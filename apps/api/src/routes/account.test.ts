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
import { accountDeletionRateLimiter } from "../lib/rateLimit";

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
    // accountDeletionRateLimiter (lib/rateLimit.ts) is a module-level Map
    // shared across every test in this file — clear it so one test's
    // attempts can't carry over and spuriously 429 the next.
    accountDeletionRateLimiter.clear();

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

  it("rejects an object-typed authKey with 400 (not 500) via the route's JSON-schema body validation", async () => {
    const server = await buildTestServer(userId);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { authKey: {} },
    });

    expect(response.statusCode).toBe(400);
    expect(cascadeDeleteUserLinks).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
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

  it("allows legitimate traffic well under the rate limit (regression guard against an overly strict window)", async () => {
    const server = await buildTestServer(userId);

    // 3 attempts is comfortably under the 5/15min limit (lib/rateLimit.ts).
    for (let i = 0; i < 3; i++) {
      const response = await server.inject({
        method: "DELETE",
        url: "/api/account",
        payload: { authKey: "wrong-string" },
      });
      expect(response.statusCode).toBe(403);
    }

    // A final, correct attempt still succeeds.
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { authKey: CORRECT_AUTH_KEY },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rate-limits repeated deletion attempts for the same user with 429, without affecting a different user", async () => {
    const otherUser = await createTestUser("other-victim@example.com", "other-victim");

    const server = await buildTestServer(userId);
    for (let i = 0; i < 5; i++) {
      const response = await server.inject({
        method: "DELETE",
        url: "/api/account",
        payload: { authKey: "wrong-string" },
      });
      expect(response.statusCode).toBe(403);
    }

    const blocked = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { authKey: CORRECT_AUTH_KEY },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: expect.any(String) });
    // The rate limit rejected the request before the handler ran at all —
    // the account must still exist, unaffected by the correct authKey.
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();

    // A different authenticated user has their own bucket and is unaffected.
    const otherServer = await buildTestServer(otherUser.id);
    const otherResponse = await otherServer.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { authKey: "wrong-string" },
    });
    expect(otherResponse.statusCode).toBe(403);
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
