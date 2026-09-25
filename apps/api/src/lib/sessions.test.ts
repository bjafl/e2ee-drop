// apps/api/src/lib/sessions.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { createSession, getUserIdFromSession, deleteSession, deleteAllUserSessions } from "./sessions";

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
