// apps/api/src/lib/sessions.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { createSession, getUserIdFromSession, deleteSession, deleteAllUserSessions, generateSessionId } from "./sessions";

async function createTestUser() {
  return prisma.user.create({
    data: {
      email: `u-${Date.now()}@example.com`,
      username: `u-${Date.now()}`,
      name: "T",
      passwordHash: "h",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k",
      storageQuotaBytes: 1000,
    },
  });
}

describe("sessions", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  it("creates a session and resolves the user id from it", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);
    expect(await getUserIdFromSession(session.id)).toBe(user.id);
  });

  it("uses a 256-bit random base64url id, not a cuid, and round-trips create/lookup/delete", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);
    // 32 bytes -> 43 base64url chars (no padding). A cuid v1 is 25 chars starting with "c".
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(session.id, "base64url")).toHaveLength(32);
    const stored = await prisma.session.findUnique({ where: { id: session.id } });
    expect(stored?.userId).toBe(user.id);
    expect(await getUserIdFromSession(session.id)).toBe(user.id);
    await deleteSession(session.id);
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await getUserIdFromSession(session.id)).toBeNull();
  });

  it("generates distinct ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, generateSessionId));
    expect(ids.size).toBe(1000);
  });

  it("returns null for an unknown session id", async () => {
    expect(await getUserIdFromSession("does-not-exist")).toBeNull();
  });

  it("deletes a single session", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);
    await deleteSession(session.id);
    expect(await getUserIdFromSession(session.id)).toBeNull();
  });

  it("deletes all sessions for a user", async () => {
    const user = await createTestUser();
    const a = await createSession(user.id);
    const b = await createSession(user.id);
    await deleteAllUserSessions(user.id);
    expect(await getUserIdFromSession(a.id)).toBeNull();
    expect(await getUserIdFromSession(b.id)).toBeNull();
  });

  it("tolerates two concurrent lookups racing to lazy-delete the same expired session", async () => {
    const user = await createTestUser();
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() - 1000) },
    });

    // Both requests see the row before either deletes it — the loser of the
    // delete race would otherwise see Prisma throw P2025 ("record not
    // found"), the same class of race deleteLinkIfExists (lib/links.ts)
    // guards against. Neither call should throw; both should resolve null.
    const [a, b] = await Promise.all([
      getUserIdFromSession(session.id),
      getUserIdFromSession(session.id),
    ]);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });
});
