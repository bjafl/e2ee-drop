// apps/api/src/routes/passwordReset.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { verifyPassword, hashPassword } from "../lib/passwordAuth";
import { createDefaultLinkForUser } from "../lib/links";
import { isMailerConfigured, sendPasswordResetEmail } from "../lib/mailer";
import { env } from "../env";
import { encryptTotpSecret, generateTotpSecret } from "../lib/totp";
import { generateAndStoreBackupCodes } from "../lib/totpBackupCodes";
import { TOTP, Secret } from "otpauth";
import { fakePublicKey } from "../test/fakeKeys";

// registerUser() (below) now exercises routes/auth.ts's own best-effort
// verification-email side effect too, so sendVerificationEmail needs a stub
// here as well — otherwise it's undefined and every registerUser() call
// throws inside auth.ts's try/catch (silently swallowed there, but still
// worth a real stub rather than relying on that catch).
vi.mock("../lib/mailer", () => ({
  isMailerConfigured: vi.fn().mockReturnValue(false),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

// Pass-through spies, so individual tests can inject a failure mid-reset.
vi.mock("../lib/passwordAuth", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/passwordAuth")>();
  return { ...original, hashPassword: vi.fn(original.hashPassword) };
});
vi.mock("../lib/links", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/links")>();
  return { ...original, createDefaultLinkForUser: vi.fn(original.createDefaultLinkForUser) };
});

const completePayload = {
  newAuthKey: "a brand new password",
  newPasswordSalt: "bmV3LXNhbHQ=",
  newPasswordWrappedPrivateKey: "bmV3LXdyYXBwZWQ=",
};
const completeFreshPayload = {
  newAuthKey: "a fresh new password",
  newPasswordSalt: "bmV3LXNhbHQ=",
  newPasswordWrappedPrivateKey: "bmV3LXdyYXBwZWQ=",
  newRecoveryWrappedPrivateKey: "bmV3LXJlY292ZXJ5",
  newPublicKey: "bmV3LXB1YmtleQ==",
};

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
      publicKey: fakePublicKey("b3JpZ2luYWwtcHVia2V5"),
    },
  });
  const body = response.json();
  // routes/auth.ts's best-effort verification-email send is now
  // fire-and-forget (not awaited on the response path — see that file's
  // comment), so it can still be in flight when inject() resolves. Its
  // token row is written unconditionally, before the isMailerConfigured()
  // check that this file's tests below rely on the call count/order of
  // (e.g. a mockReturnValueOnce meant for a later call in the same test) —
  // wait for that row so the incidental call has fully settled before this
  // helper returns, and callers aren't racing it.
  await vi.waitFor(async () => {
    const token = await prisma.emailVerificationToken.findFirst({ where: { userId: body.userId } });
    expect(token).not.toBeNull();
  });
  // Extra margin: the token row is written just before the
  // isMailerConfigured() check in the same async function, so give that
  // continuation a macrotask tick to run before returning control.
  await new Promise((resolve) => setImmediate(resolve));
  return body;
}

async function issueResetToken(userId: string, token = "test-reset-token"): Promise<string> {
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

  it("finds the registered user and issues a token for a different case/whitespace variant of their email", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "  Dana@Example.COM  " },
    });

    expect(response.statusCode).toBe(200);
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(1);
  });

  it("reports emailDeliveryAvailable from server config only, identically for registered and unregistered emails", async () => {
    const server = buildServer();
    await registerUser(server);

    for (const configured of [false, true]) {
      vi.mocked(isMailerConfigured).mockReturnValue(configured);
      const bodies = [];
      for (const email of ["dana@example.com", "nobody@example.com"]) {
        const response = await server.inject({
          method: "POST",
          url: "/api/auth/password-reset/request",
          payload: { email },
        });
        expect(response.statusCode).toBe(200);
        bodies.push(response.json());
      }
      expect(bodies[0]).toEqual({ requested: true, emailDeliveryAvailable: configured });
      expect(bodies[1]).toEqual(bodies[0]);
    }
    vi.mocked(isMailerConfigured).mockReturnValue(false);
  });

  it("rate-limits /request per IP (5 per 15 min) identically for registered and unregistered emails", async () => {
    const server = buildServer();
    await registerUser(server);
    vi.mocked(sendPasswordResetEmail).mockClear();
    vi.mocked(isMailerConfigured).mockReturnValue(true);
    try {
      const request = (ip: string, email: string) =>
        server.inject({ method: "POST", url: "/api/auth/password-reset/request", remoteAddress: ip, payload: { email } });

      // Legitimate traffic up to the limit, mixing a real and an unknown email.
      for (const email of ["dana@example.com", "nobody@example.com", "dana@example.com", "nobody@example.com", "dana@example.com"]) {
        expect((await request("203.0.113.30", email)).statusCode).toBe(200);
      }
      expect(await prisma.passwordResetToken.count()).toBe(3);
      expect(vi.mocked(sendPasswordResetEmail)).toHaveBeenCalledTimes(3);

      // Once the IP is throttled, a registered and an unregistered email get
      // byte-identical 429s, and no token or email is produced — the limit
      // reveals nothing about which emails have accounts.
      const blockedRegistered = await request("203.0.113.30", "dana@example.com");
      const blockedUnknown = await request("203.0.113.30", "nobody@example.com");
      expect(blockedRegistered.statusCode).toBe(429);
      expect(blockedUnknown.statusCode).toBe(429);
      expect(blockedRegistered.body).toBe(blockedUnknown.body);
      expect(await prisma.passwordResetToken.count()).toBe(3);
      expect(vi.mocked(sendPasswordResetEmail)).toHaveBeenCalledTimes(3);

      // A different IP is unaffected.
      expect((await request("198.51.100.30", "dana@example.com")).statusCode).toBe(200);
    } finally {
      vi.mocked(isMailerConfigured).mockReturnValue(false);
    }
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

  it("emails a link to the token-consuming /reset-password/confirm page whose token verifies", async () => {
    const server = buildServer();
    await registerUser(server);

    // Registration itself now calls isMailerConfigured() as a best-effort
    // side effect (routes/auth.ts sends a verification email) — the "once"
    // override must be set AFTER registerUser() so it applies to the
    // /password-reset/request call under test below, not to that incidental
    // call inside registration.
    vi.mocked(isMailerConfigured).mockReturnValueOnce(true);
    vi.mocked(sendPasswordResetEmail).mockClear();

    await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "dana@example.com" },
    });

    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [to, resetUrl] = vi.mocked(sendPasswordResetEmail).mock.calls[0]!;
    expect(to).toBe("dana@example.com");
    const url = new URL(resetUrl);
    expect(url.origin + url.pathname).toBe(`${new URL(env.APP_URL).origin}/reset-password/confirm`);
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();

    const verify = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/verify-token",
      payload: { token },
    });
    expect(verify.statusCode).toBe(200);
  });

  it("still succeeds when the password reset email send throws (best-effort)", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);

    vi.mocked(isMailerConfigured).mockReturnValueOnce(true);
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(new Error("smtp down"));

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "dana@example.com" },
    });
    expect(response.statusCode).toBe(200);
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(1);
  });

  it("logs (via request.log.warn) when the best-effort email send fails, without blocking the response", async () => {
    const serverWithHook = buildServer();

    // request.log is a per-request pino child logger that generates its own
    // independent level methods (warn/info/etc.) rather than inheriting them
    // from server.log — spying on server.log.warn never observes a call made
    // through a request's own request.log.warn. Instead, wrap the actual
    // per-request instance via an onRequest hook, which runs early enough
    // (before the route handler) to patch the exact request.log the handler
    // and its later .catch() callback will both use.
    const warnCalls: unknown[][] = [];
    serverWithHook.addHook("onRequest", (request, _reply, done) => {
      const original = request.log.warn.bind(request.log);
      request.log.warn = (...args: Parameters<typeof original>) => {
        warnCalls.push(args);
        return original(...args);
      };
      done();
    });

    // Register a user on this server, then test the email send failure.
    await serverWithHook.inject({
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
        publicKey: fakePublicKey("b3JpZ2luYWwtcHVia2V5"),
      },
    });

    // Set up mocks for the password reset request: mailer is configured,
    // but the email send will fail.
    vi.mocked(isMailerConfigured).mockReturnValue(true);
    vi.mocked(sendPasswordResetEmail).mockClear();
    vi.mocked(sendPasswordResetEmail).mockRejectedValue(new Error("smtp down"));

    const start = Date.now();
    const response = await serverWithHook.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "dana@example.com" },
    });
    const elapsedMs = Date.now() - start;

    expect(response.statusCode).toBe(200);

    // The email send is fire-and-forget: the route kicks it off but does not
    // await it on the response path. Poll for the mock to be called.
    await vi.waitFor(() => {
      expect(vi.mocked(sendPasswordResetEmail)).toHaveBeenCalledTimes(1);
    });

    // The response must not wait on the (failing) mail send — it should
    // return promptly rather than only after the send's own rejection.
    expect(elapsedMs).toBeLessThan(500);

    // Wait for the error to be logged.
    await vi.waitFor(() => {
      expect(warnCalls).toHaveLength(1);
    });
    const [logArg, msgArg] = warnCalls[0];
    expect(msgArg).toBe("password reset email send failed");
    expect(logArg).toMatchObject({ err: expect.anything() });
    // Never logs the reset URL or token itself, only the error.
    expect(JSON.stringify(warnCalls)).not.toContain("/reset-password/confirm?token=");

    // Reset mocks for next tests.
    vi.mocked(isMailerConfigured).mockReturnValue(false);
    vi.mocked(sendPasswordResetEmail).mockResolvedValue(undefined);
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
        senderPublicKey: fakePublicKey("s"),
        s3Key: `${link.id}/drop1`,
        archiveNonce: "n",
        encryptedMetadata: "e",
        metadataNonce: "m",
        fileSize: 1,
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
    expect(user.publicKey).toBe(fakePublicKey("b3JpZ2luYWwtcHVia2V5"));
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
    // newPublicKey (unlike register's publicKey) is not currently validated by
    // lib/validation.ts (out of scope for this fix — see task report), so this
    // stays a plain placeholder rather than a real 32-byte key.
    expect(newDefaultLink.recipientPublicKey).toBe("bmV3LXB1YmtleQ==");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.publicKey).toBe("bmV3LXB1YmtleQ==");
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  it("lets only one of two concurrent /complete calls with the same token succeed", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);
    const token = await issueResetToken(userId);

    const [a, b] = await Promise.all(
      ["first", "second"].map((tag) =>
        server.inject({
          method: "POST",
          url: "/api/auth/password-reset/complete",
          payload: { ...completePayload, token, newPasswordWrappedPrivateKey: `wrapped-${tag}` },
        })
      )
    );

    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 400]);
    const winner = a!.statusCode === 200 ? "first" : "second";
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.passwordWrappedPrivateKey).toBe(`wrapped-${winner}`);
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(0);
  });

  it("lets only one of two concurrent /complete-fresh calls with the same token succeed, leaving consistent keys", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);
    const token = await issueResetToken(userId);

    const responses = await Promise.all(
      ["first", "second"].map((tag) =>
        server.inject({
          method: "POST",
          url: "/api/auth/password-reset/complete-fresh",
          payload: { ...completeFreshPayload, token, newPublicKey: `pub-${tag}`, newPasswordWrappedPrivateKey: `wrapped-${tag}` },
        })
      )
    );

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const winner = responses[0]!.statusCode === 200 ? "first" : "second";
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.publicKey).toBe(`pub-${winner}`);
    expect(user.passwordWrappedPrivateKey).toBe(`wrapped-${winner}`);
    const links = await prisma.link.findMany({ where: { ownerId: userId } });
    expect(links).toHaveLength(1);
    expect(links[0]!.recipientPublicKey).toBe(`pub-${winner}`);
  });

  it("invalidates every other outstanding reset token for the user once one is used", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);
    const olderToken = await issueResetToken(userId, "older-still-valid-token");
    const usedToken = await issueResetToken(userId, "token-being-used");

    const first = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete",
      payload: { ...completePayload, token: usedToken },
    });
    expect(first.statusCode).toBe(200);

    for (const url of ["/api/auth/password-reset/verify-token", "/api/auth/password-reset/complete"]) {
      const response = await server.inject({
        method: "POST",
        url,
        payload: { ...completePayload, token: olderToken, newPasswordWrappedPrivateKey: "attacker" },
      });
      expect(response.statusCode).toBe(400);
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.passwordWrappedPrivateKey).toBe(completePayload.newPasswordWrappedPrivateKey);
  });

  it("rejects an expired token on /complete without consuming other state", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);
    await prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: createHash("sha256").update("expired-token").digest("hex"),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete",
      payload: { ...completePayload, token: "expired-token" },
    });
    expect(response.statusCode).toBe(400);
    expect(await prisma.session.count({ where: { userId } })).toBeGreaterThan(0);
  });

  it("returns 400 (not 500) when /complete or /complete-fresh is missing fields", async () => {
    const server = buildServer();
    for (const url of ["/api/auth/password-reset/complete", "/api/auth/password-reset/complete-fresh"]) {
      const response = await server.inject({ method: "POST", url, payload: { token: "x" } });
      expect(response.statusCode).toBe(400);
    }
  });

  it("rejects a numeric newAuthKey on /complete with 400 (not 500) via the route's JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete",
      payload: { ...completePayload, token: "x", newAuthKey: 12345 },
    });
    expect(response.statusCode).toBe(400);
    // token: "x" is also an invalid token, which independently 400s — assert the
    // schema-validation error specifically, so this test can't pass for the wrong reason.
    expect(response.json().error).toBe("body/newAuthKey must be string");
  });

  it("/complete revokes sessions and consumes the token BEFORE mutating credentials (failure injected mid-reset)", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await prisma.session.count({ where: { userId } })).toBeGreaterThan(0);
    const token = await issueResetToken(userId);
    vi.mocked(hashPassword).mockRejectedValueOnce(new Error("injected failure"));

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete",
      payload: { ...completePayload, token },
    });

    expect(response.statusCode).toBe(500);
    // Already revoked and consumed, though the credential step never ran.
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(0);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.passwordWrappedPrivateKey).toBe(before.passwordWrappedPrivateKey);
  });

  it("/complete-fresh rolls back the key rotation if creating the new default link fails", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const token = await issueResetToken(userId);
    vi.mocked(createDefaultLinkForUser).mockRejectedValueOnce(new Error("injected failure"));

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete-fresh",
      payload: { ...completeFreshPayload, token },
    });

    expect(response.statusCode).toBe(500);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // Keys/credentials unchanged: never "new keys with no default link".
    expect(after.publicKey).toBe(before.publicKey);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.passwordWrappedPrivateKey).toBe(before.passwordWrappedPrivateKey);
    expect(after.recoveryWrappedPrivateKey).toBe(before.recoveryWrappedPrivateKey);
    // Sessions were revoked first; the (idempotent) cascade delete already ran.
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(await prisma.link.count({ where: { ownerId: userId } })).toBe(0);

    // A retry with a fresh token completes normally.
    const retryToken = await issueResetToken(userId, "retry-token");
    const retry = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete-fresh",
      payload: { ...completeFreshPayload, token: retryToken },
    });
    expect(retry.statusCode).toBe(200);
    const link = await prisma.link.findFirstOrThrow({ where: { ownerId: userId, isDefault: true } });
    expect(link.recipientPublicKey).toBe(completeFreshPayload.newPublicKey);
  });

  describe("2FA enforcement on /complete and /complete-fresh", () => {
    const routes = [
      { name: "/complete", url: "/api/auth/password-reset/complete", payload: completePayload },
      { name: "/complete-fresh", url: "/api/auth/password-reset/complete-fresh", payload: completeFreshPayload },
    ] as const;

    async function enableTotp(userId: string): Promise<TOTP> {
      const secret = generateTotpSecret();
      await prisma.user.update({
        where: { id: userId },
        data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) },
      });
      return new TOTP({ secret: Secret.fromBase32(secret) });
    }

    // A 6-digit code guaranteed invalid within verifyTotpCode's ±1 step window.
    function wrongCode(totp: TOTP): string {
      const valid = new Set([-1, 0, 1].map((step) => totp.generate({ timestamp: Date.now() + step * 30_000 })));
      for (let n = 0; ; n++) {
        const candidate = String(n).padStart(6, "0");
        if (!valid.has(candidate)) return candidate;
      }
    }

    async function seedDrop(defaultLinkSlug: string) {
      const link = await prisma.link.findFirstOrThrow({ where: { slug: defaultLinkSlug } });
      await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: fakePublicKey("s"),
          s3Key: `${link.id}/drop1`,
          archiveNonce: "n",
          encryptedMetadata: "e",
          metadataNonce: "m",
          fileSize: 1,
          contentMD5: "m",
        },
      });
    }

    // Everything a completed (or partially completed) reset could touch.
    async function snapshot(userId: string) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      return {
        passwordHash: user.passwordHash,
        passwordSalt: user.passwordSalt,
        passwordWrappedPrivateKey: user.passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey: user.recoveryWrappedPrivateKey,
        publicKey: user.publicKey,
        sessionIds: (await prisma.session.findMany({ where: { userId }, orderBy: { id: "asc" } })).map((s) => s.id),
        tokenIds: (await prisma.passwordResetToken.findMany({ where: { userId }, orderBy: { id: "asc" } })).map((t) => t.id),
        linkIds: (await prisma.link.findMany({ where: { ownerId: userId }, orderBy: { id: "asc" } })).map((l) => l.id),
        dropCount: await prisma.drop.count({ where: { link: { ownerId: userId } } }),
      };
    }

    it("verify-token reports totpEnabled so the UI can ask for a code up front", async () => {
      const server = buildServer();
      const { userId } = await registerUser(server);
      const token = await issueResetToken(userId);
      const url = "/api/auth/password-reset/verify-token";

      const before = await server.inject({ method: "POST", url, payload: { token } });
      expect(before.json().totpEnabled).toBe(false);

      await enableTotp(userId);
      const after = await server.inject({ method: "POST", url, payload: { token } });
      expect(after.json().totpEnabled).toBe(true);
    });

    for (const route of routes) {
      it(`${route.name}: rejects a missing or wrong code with 401 requiresTotp and changes NOTHING`, async () => {
        const server = buildServer();
        const { userId, defaultLinkSlug } = await registerUser(server);
        // /complete-fresh's successful cascade deletes drop objects from S3,
        // which the test environment doesn't provide (the pre-existing
        // /complete-fresh tests avoid drops for the same reason); its
        // rejected attempts are still checked against the link rows.
        if (route.name === "/complete") await seedDrop(defaultLinkSlug);
        const totp = await enableTotp(userId);
        const token = await issueResetToken(userId);
        await issueResetToken(userId, "another-outstanding-token");
        const before = await snapshot(userId);
        expect(before.sessionIds.length).toBeGreaterThan(0);
        expect(before.tokenIds).toHaveLength(2);

        for (const extra of [{}, { totpCode: "" }, { totpCode: wrongCode(totp) }, { totpCode: 123456 }]) {
          const response = await server.inject({
            method: "POST",
            url: route.url,
            payload: { ...route.payload, token, ...extra },
          });
          expect(response.statusCode).toBe(401);
          expect(response.json().requiresTotp).toBe(true);
          expect(await snapshot(userId)).toEqual(before);
        }

        // Neither token was consumed: the legitimate user can still finish
        // with a correct code (proving the rejected attempts left it valid).
        const ok = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token, totpCode: totp.generate() },
        });
        expect(ok.statusCode).toBe(200);
        expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(0);
      });

      it(`${route.name}: completes exactly as before with a correct code`, async () => {
        const server = buildServer();
        const { userId, defaultLinkSlug } = await registerUser(server);
        const oldLink = await prisma.link.findFirstOrThrow({ where: { slug: defaultLinkSlug } });
        const totp = await enableTotp(userId);
        const token = await issueResetToken(userId);

        const response = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token, totpCode: totp.generate() },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ reset: true });

        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(await verifyPassword(route.payload.newAuthKey, user.passwordHash)).toBe(true);
        expect(user.passwordWrappedPrivateKey).toBe(route.payload.newPasswordWrappedPrivateKey);
        expect(user.totpEnabled).toBe(true);
        expect(await prisma.session.count({ where: { userId } })).toBe(0);
        expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(0);
        if (route.name === "/complete") {
          expect(await prisma.link.count({ where: { id: oldLink.id } })).toBe(1);
        } else {
          expect(await prisma.link.count({ where: { id: oldLink.id } })).toBe(0);
          expect(user.publicKey).toBe(completeFreshPayload.newPublicKey);
        }
      });

      it(`${route.name}: rejects a code already used at login, and one already used by a prior reset`, async () => {
        const server = buildServer();
        const { userId } = await registerUser(server);
        const totp = await enableTotp(userId);

        // Used at login first.
        const loginCode = totp.generate();
        const login = await server.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "dana@example.com", authKey: "original password", totpCode: loginCode },
        });
        expect(login.statusCode).toBe(200);

        const token = await issueResetToken(userId);
        const before = await snapshot(userId);
        const replayed = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token, totpCode: loginCode },
        });
        expect(replayed.statusCode).toBe(401);
        expect(replayed.json().requiresTotp).toBe(true);
        expect(await snapshot(userId)).toEqual(before);

        // A code consumed by a successful reset can't drive a second reset.
        // Use a different (still valid) step's code so it isn't the login one.
        const resetCode = [0, -1, 1]
          .map((step) => totp.generate({ timestamp: Date.now() + step * 30_000 }))
          .find((c) => c !== loginCode)!;
        const first = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token, totpCode: resetCode },
        });
        expect(first.statusCode).toBe(200);

        const secondToken = await issueResetToken(userId, "second-reset-token");
        const afterFirst = await snapshot(userId);
        const second = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token: secondToken, newPasswordWrappedPrivateKey: "attacker", totpCode: resetCode },
        });
        expect(second.statusCode).toBe(401);
        expect(await snapshot(userId)).toEqual(afterFirst);

        // ...and it can't be replayed at login either.
        const loginReplay = await server.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "dana@example.com", authKey: route.payload.newAuthKey, totpCode: resetCode },
        });
        expect(loginReplay.statusCode).toBe(401);
      });

      it(`${route.name}: an account without 2FA needs no code (unchanged behavior)`, async () => {
        const server = buildServer();
        const { userId } = await registerUser(server);
        const token = await issueResetToken(userId);
        const response = await server.inject({ method: "POST", url: route.url, payload: { ...route.payload, token } });
        expect(response.statusCode).toBe(200);
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        expect(await verifyPassword(route.payload.newAuthKey, user.passwordHash)).toBe(true);
      });

      it(`${route.name}: an invalid token is rejected with 400 before any TOTP handling`, async () => {
        const server = buildServer();
        const { userId } = await registerUser(server);
        await enableTotp(userId);
        for (const extra of [{}, { totpCode: "000000" }]) {
          const response = await server.inject({
            method: "POST",
            url: route.url,
            payload: { ...route.payload, token: "not-a-real-token", ...extra },
          });
          expect(response.statusCode).toBe(400);
          expect(response.json().requiresTotp).toBeUndefined();
        }
      });

      it(`${route.name}: accepts a backup code in place of a TOTP code`, async () => {
        const server = buildServer();
        const { userId } = await registerUser(server);
        await enableTotp(userId);
        const codes = await generateAndStoreBackupCodes(userId);
        const token = await issueResetToken(userId);

        const response = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token, totpCode: codes[0] },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ reset: true });
      });

      it(`${route.name}: a backup code already consumed at login can't be reused for a reset`, async () => {
        const server = buildServer();
        const { userId } = await registerUser(server);
        await enableTotp(userId);
        const codes = await generateAndStoreBackupCodes(userId);

        const login = await server.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "dana@example.com", authKey: "original password", totpCode: codes[0] },
        });
        expect(login.statusCode).toBe(200);

        const token = await issueResetToken(userId);
        const before = await snapshot(userId);
        const replayed = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token, totpCode: codes[0] },
        });
        expect(replayed.statusCode).toBe(401);
        expect(replayed.json().requiresTotp).toBe(true);
        expect(await snapshot(userId)).toEqual(before);
      });

      it(`${route.name}: rejects a well-formed but never-issued backup code exactly like a wrong TOTP code, and changes nothing`, async () => {
        const server = buildServer();
        const { userId } = await registerUser(server);
        await enableTotp(userId);
        await generateAndStoreBackupCodes(userId);
        const token = await issueResetToken(userId);
        const before = await snapshot(userId);

        // "zzzzz-zzzzz" is well-formed — z IS part of the backup-code
        // alphabet, only 0, 1, i, l, o are excluded — but was never issued to
        // this user, so it's rejected purely for not matching any stored
        // hash (the exhaustion/never-issued case), with the exact same
        // outcome as a wrong TOTP code: no crash, no distinguishing message,
        // no state change.
        const response = await server.inject({
          method: "POST",
          url: route.url,
          payload: { ...route.payload, token, totpCode: "zzzzz-zzzzz" },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().requiresTotp).toBe(true);
        expect(await snapshot(userId)).toEqual(before);
      });
    }

    it("caps TOTP guesses per user (5 / 15 min) across both routes and across tokens, without consuming the token", async () => {
      const server = buildServer();
      const { userId } = await registerUser(server);
      const totp = await enableTotp(userId);
      const token = await issueResetToken(userId);
      const secondToken = await issueResetToken(userId, "second-token");
      const bad = wrongCode(totp);

      for (let i = 0; i < 5; i++) {
        const route = routes[i % 2]!;
        const response = await server.inject({ method: "POST", url: route.url, payload: { ...route.payload, token, totpCode: bad } });
        expect(response.statusCode).toBe(401);
      }
      const before = await snapshot(userId);
      // Even a correct code, on another token, is throttled now.
      const throttled = await server.inject({
        method: "POST",
        url: routes[0].url,
        payload: { ...completePayload, token: secondToken, totpCode: totp.generate() },
      });
      expect(throttled.statusCode).toBe(429);
      expect(await snapshot(userId)).toEqual(before);
      expect(before.tokenIds).toHaveLength(2);
    });
  });
});
