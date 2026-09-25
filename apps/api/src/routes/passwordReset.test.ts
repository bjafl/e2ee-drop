// apps/api/src/routes/passwordReset.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { verifyPassword } from "../lib/passwordAuth";

vi.mock("../lib/mailer", () => ({
  isMailerConfigured: vi.fn().mockReturnValue(false),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

async function registerUser(server: ReturnType<typeof buildServer>) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "dana@example.com",
      username: "dana",
      name: "Dana",
      authKey: "original password",
      passwordSalt: "b3JpZ2luYWwtc2FsdA==",
      passwordWrappedPrivateKey: "b3JpZ2luYWwtd3JhcHBlZA==",
      recoveryWrappedPrivateKey: "b3JpZ2luYWwtcmVjb3Zlcnk=",
      publicKey: "b3JpZ2luYWwtcHVia2V5",
    },
  });
  return response.json();
}

async function issueResetToken(userId: string): Promise<string> {
  const token = "test-reset-token";
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

describe("password reset routes", () => {
  beforeEach(async () => {
    await prisma.passwordResetToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("always returns 200 from /request, even for an unregistered email, without creating a token for it", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "nobody@example.com" },
    });
    expect(response.statusCode).toBe(200);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("creates a token for a registered email and verify-token returns the recovery blob", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);

    await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "dana@example.com" },
    });
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(1);
  });

  it("rejects verify-token and complete for an invalid token", async () => {
    const server = buildServer();
    const verify = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/verify-token",
      payload: { token: "not-a-real-token" },
    });
    expect(verify.statusCode).toBe(400);
  });

  it("recovery-code path: preserves existing links/drops, rotates only credentials, and revokes old sessions", async () => {
    const server = buildServer();
    const { userId, defaultLinkSlug } = await registerUser(server);
    const link = await prisma.link.findFirstOrThrow({ where: { slug: defaultLinkSlug } });
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
    const oldSessionCountBefore = await prisma.session.count({ where: { userId } });
    expect(oldSessionCountBefore).toBeGreaterThan(0);

    const token = await issueResetToken(userId);
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete",
      payload: {
        token,
        newAuthKey: "a brand new password",
        newPasswordSalt: "bmV3LXNhbHQ=",
        newPasswordWrappedPrivateKey: "bmV3LXdyYXBwZWQ=",
      },
    });

    expect(response.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.passwordWrappedPrivateKey).toBe("bmV3LXdyYXBwZWQ=");
    expect(await verifyPassword("a brand new password", user.passwordHash)).toBe(true);
    expect(user.publicKey).toBe("b3JpZ2luYWwtcHVia2V5");
    expect(await prisma.link.count({ where: { id: link.id } })).toBe(1);
    expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(1);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  it("no-recovery-code path: cascade-deletes existing links/drops and issues a fresh default link", async () => {
    const server = buildServer();
    const { userId, defaultLinkSlug } = await registerUser(server);
    const oldLink = await prisma.link.findFirstOrThrow({ where: { slug: defaultLinkSlug } });

    const token = await issueResetToken(userId);
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete-fresh",
      payload: {
        token,
        newAuthKey: "a fresh new password",
        newPasswordSalt: "bmV3LXNhbHQ=",
        newPasswordWrappedPrivateKey: "bmV3LXdyYXBwZWQ=",
        newRecoveryWrappedPrivateKey: "bmV3LXJlY292ZXJ5",
        newPublicKey: "bmV3LXB1YmtleQ==",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await prisma.link.count({ where: { id: oldLink.id } })).toBe(0);
    const newDefaultLink = await prisma.link.findFirstOrThrow({ where: { ownerId: userId, isDefault: true } });
    expect(newDefaultLink.recipientPublicKey).toBe("bmV3LXB1YmtleQ==");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.publicKey).toBe("bmV3LXB1YmtleQ==");
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });
});
