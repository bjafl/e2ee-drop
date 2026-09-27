// apps/api/src/routes/twoFactor.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { TOTP, Secret } from "otpauth";
import { decryptTotpSecret, encryptTotpSecret, generateTotpSecret } from "../lib/totp";

async function registerAndGetCookie(server: ReturnType<typeof buildServer>) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "erin@example.com",
      username: "erin",
      name: "Erin",
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k",
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return { userId: response.json().userId, cookieValue: cookie.value };
}

describe("2FA routes", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("requires authentication to set up 2FA", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "POST", url: "/api/auth/2fa/setup" });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a numeric code on /2fa/enable with 400 (not 500) via the route's JSON-schema body validation", async () => {
    const server = buildServer();
    const { cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: 123456 },
    });

    expect(response.statusCode).toBe(400);
  });

  it("sets up, enables with a valid code, and disables 2FA with a fresh valid code", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupResponse = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    expect(setupResponse.statusCode).toBe(200);
    const { secretBase32 } = setupResponse.json();

    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    const enableResponse = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: totp.generate() },
    });
    expect(enableResponse.statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.totpEnabled).toBe(true);

    // Disable requires re-proof of possession of the TOTP secret (a
    // deliberate deviation from the brief's literal code — see
    // task-12-report.md). The code used to enable was already consumed by
    // verifyTotpCode's replay guard, so a fresh code is generated here by
    // advancing past the enable-request's 30s step.
    const disableCode = new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate({
      timestamp: Date.now() + 30_000,
    });
    const disableResponse = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      cookies,
      payload: { code: disableCode },
    });
    expect(disableResponse.statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totpEnabled).toBe(false);
  });

  it("rejects /2fa/setup with 409 when 2FA is already enabled, leaving the existing secret and pending state untouched", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const { secretBase32 } = (await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies })).json();
    const enable = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate() },
    });
    expect(enable.statusCode).toBe(200);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    // A hijacked session tries to install its own authenticator.
    const hijack = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    expect(hijack.statusCode).toBe(409);
    expect(hijack.json()).not.toHaveProperty("secretBase32");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.totpEnabled).toBe(true);
    expect(after.totpSecretEncrypted).toBe(before.totpSecretEncrypted);
    expect(decryptTotpSecret(after.totpSecretEncrypted!)).toBe(secretBase32);

    // The rejected /setup stored no pending secret: after a legitimate
    // disable (proving possession of the current secret), /enable finds no
    // pending setup at all.
    const disable = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      cookies,
      payload: {
        code: new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate({ timestamp: Date.now() + 30_000 }),
      },
    });
    expect(disable.statusCode).toBe(200);
    const lateEnable = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: "123456" },
    });
    expect(lateEnable.statusCode).toBe(400);
  });

  it("rejects /2fa/enable with 409 if 2FA became enabled after setup, without overwriting the secret", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const { secretBase32 } = (await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies })).json();
    // Simulate another request having already enabled 2FA with a different secret.
    const winningSecret = generateTotpSecret();
    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(winningSecret) },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate() },
    });
    expect(response.statusCode).toBe(409);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(decryptTotpSecret(user.totpSecretEncrypted!)).toBe(winningSecret);
  });

  it("lets exactly one of two concurrent /2fa/enable calls succeed", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const { secretBase32 } = (await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies })).json();
    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    // Two distinct codes, both inside the validation window, so the replay
    // guard doesn't reject the second one before the enabled check runs.
    const codes = [totp.generate(), totp.generate({ timestamp: Date.now() - 30_000 })];

    const responses = await Promise.all(
      codes.map((code) => server.inject({ method: "POST", url: "/api/auth/2fa/enable", cookies, payload: { code } }))
    );
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    // The loser normally sees 409 (already enabled). 400 (pending setup
    // already consumed) is also a safe rejection for some interleavings.
    expect([400, 409]).toContain(statuses.find((s) => s !== 200));
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.totpEnabled).toBe(true);
    expect(decryptTotpSecret(user.totpSecretEncrypted!)).toBe(secretBase32);
  });

  it("rejects enabling 2FA with the wrong code", async () => {
    const server = buildServer();
    const { cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };
    await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: "000000" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects disabling 2FA without a valid TOTP code", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupResponse = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32 } = setupResponse.json();
    const enableCode = new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate();
    const enableResponse = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: enableCode },
    });
    expect(enableResponse.statusCode).toBe(200);

    // No code at all.
    const missingCodeResponse = await server.inject({ method: "POST", url: "/api/auth/2fa/disable", cookies });
    expect(missingCodeResponse.statusCode).toBe(401);

    // Wrong code.
    const wrongCodeResponse = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      cookies,
      payload: { code: "000000" },
    });
    expect(wrongCodeResponse.statusCode).toBe(401);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.totpEnabled).toBe(true);
  });

  it("expires a stale pending setup secret so a late /enable call is rejected as 'no pending setup'", async () => {
    // Only fake Date, not timers — faking setTimeout/setImmediate as well
    // would stall the real async I/O (DB queries, etc.) that
    // server.inject(...) depends on internally.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const server = buildServer();
      const { cookieValue } = await registerAndGetCookie(server);
      const cookies = { e2ee_drop_session: cookieValue };

      const setupResponse = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
      expect(setupResponse.statusCode).toBe(200);

      // Advance well past the pending-setup TTL (5 minutes — see
      // twoFactor.ts) without ever calling /enable. The /enable call below
      // should hit the "no pending setup" branch (400), not a TOTP
      // mismatch (401), proving the stale entry was pruned rather than
      // merely happening to fail TOTP validation.
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);

      const enableResponse = await server.inject({
        method: "POST",
        url: "/api/auth/2fa/enable",
        cookies,
        payload: { code: "123456" },
      });
      expect(enableResponse.statusCode).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });
  it("returns 10 backup codes in the /2fa/enable response", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32 } = setupRes.json();
    const validCode = new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate();

    const enableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: validCode },
    });

    expect(enableRes.statusCode).toBe(200);
    const body = enableRes.json();
    expect(body.backupCodes).toHaveLength(10);

    const count = await prisma.totpBackupCode.count({ where: { userId } });
    expect(count).toBe(10);
  });

  it("regenerate requires a valid current TOTP code and invalidates the old batch", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32 } = setupRes.json();
    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    const enableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: totp.generate() },
    });
    const firstBatch: string[] = enableRes.json().backupCodes;

    const rejected = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/backup-codes/regenerate",
      cookies,
      payload: { code: "000000" },
    });
    expect(rejected.statusCode).toBe(401);

    // A fresh code, not the one already consumed by /2fa/enable above — the
    // replay guard (totpReplayGuard.ts) rejects a reused code even for a
    // different route, the same reason the disable test above advances the
    // timestamp by one 30s step.
    const accepted = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/backup-codes/regenerate",
      cookies,
      payload: { code: totp.generate({ timestamp: Date.now() + 30_000 }) },
    });
    expect(accepted.statusCode).toBe(200);
    const secondBatch: string[] = accepted.json().backupCodes;
    expect(secondBatch).toHaveLength(10);
    expect(new Set([...firstBatch, ...secondBatch]).size).toBe(20);

    const count = await prisma.totpBackupCode.count({ where: { userId } });
    expect(count).toBe(10);
  });

  it("accepts a backup code in place of a TOTP code on /2fa/disable", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32 } = setupRes.json();
    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    const enableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: totp.generate() },
    });
    const [backupCode] = enableRes.json().backupCodes as string[];

    const disableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      cookies,
      payload: { code: backupCode },
    });
    expect(disableRes.statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totpEnabled).toBe(false);
  });

  it("rejects reusing an already-consumed backup code on a later /2fa/disable or /2fa/backup-codes/regenerate call", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32 } = setupRes.json();
    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    const enableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: totp.generate() },
    });
    const [backupCode] = enableRes.json().backupCodes as string[];

    // Consume the backup code via /2fa/disable.
    const disableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      cookies,
      payload: { code: backupCode },
    });
    expect(disableRes.statusCode).toBe(200);

    // Re-enable 2FA (fresh secret and fresh batch) so /2fa/backup-codes/regenerate
    // is reachable again, then try the now-consumed code from the FIRST batch.
    const setupRes2 = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32: secretBase32b } = setupRes2.json();
    const totp2 = new TOTP({ secret: Secret.fromBase32(secretBase32b) });
    await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: totp2.generate() },
    });

    const reuseRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/backup-codes/regenerate",
      cookies,
      payload: { code: backupCode },
    });
    expect(reuseRes.statusCode).toBe(401);
    expect(reuseRes.json()).toEqual({ error: "Invalid TOTP code" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totpEnabled).toBe(true);
  });

  it("regenerate accepts a backup code, returns a fresh disjoint batch, and leaves exactly 10 USABLE (unused) codes — while the just-consumed code's now-used row is not deleted by the unused-only cleanup, so the true total row count is 11, not 10 (verified empirically, not assumed)", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32 } = setupRes.json();
    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    const enableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: totp.generate() },
    });
    const firstBatch: string[] = enableRes.json().backupCodes;
    const [consumedCode] = firstBatch;

    const regenRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/backup-codes/regenerate",
      cookies,
      payload: { code: consumedCode },
    });
    expect(regenRes.statusCode).toBe(200);
    const secondBatch: string[] = regenRes.json().backupCodes;
    expect(secondBatch).toHaveLength(10);
    // The new batch is disjoint from the first (no overlap with any of the
    // original 10 codes, including the one just consumed to authorize this).
    expect(new Set([...firstBatch, ...secondBatch]).size).toBe(20);

    // The number of USABLE (unused) codes must be exactly 10: the fresh batch,
    // and nothing left over from the old one.
    const unusedCount = await prisma.totpBackupCode.count({ where: { userId, usedAt: null } });
    expect(unusedCount).toBe(10);

    // Empirically: consumeBackupCodeIfValid marks the consumed row `usedAt`
    // (it does not delete it), and generateAndStoreBackupCodes's cleanup
    // query only deletes rows where `usedAt: null` — so the just-consumed
    // code's now-used row does NOT get swept up by that delete, and survives
    // alongside the 10 fresh unused rows. This is correct: a used code's row
    // persisting is not the same as the code being usable again (it's
    // already `usedAt`-stamped, so consumeBackupCodeIfValid's own
    // `usedAt: null` guard would reject it if ever resubmitted). Total row
    // count is therefore 11 (1 old used + 10 new unused), not 10 — asserting
    // this explicitly rather than assuming the "obvious" answer.
    const totalCount = await prisma.totpBackupCode.count({ where: { userId } });
    expect(totalCount).toBe(11);
    const usedCount = await prisma.totpBackupCode.count({ where: { userId, usedAt: { not: null } } });
    expect(usedCount).toBe(1);
  });

  it("rejects a well-formed but never-issued backup code with a clean 401 (exhaustion case, no crash)", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    const { secretBase32 } = setupRes.json();
    await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate() },
    });

    // "zzzzz-zzzzz" is well-formed (matches the code's shape) but "z" is
    // excluded from BACKUP_CODE_ALPHABET (totpBackupCodes.ts), and even if it
    // weren't, no such code was ever issued for this user.
    const disableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      cookies,
      payload: { code: "zzzzz-zzzzz" },
    });
    expect(disableRes.statusCode).toBe(401);
    expect(disableRes.json()).toEqual({ error: "Invalid TOTP code" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totpEnabled).toBe(true);

    const regenRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/backup-codes/regenerate",
      cookies,
      payload: { code: "zzzzz-zzzzz" },
    });
    expect(regenRes.statusCode).toBe(401);
    expect(regenRes.json()).toEqual({ error: "Invalid TOTP code" });
  });

  describe("rate limiting (twoFactorRateLimiter: 5 per 15 min, keyed by user id, shared by /enable and /disable)", () => {
    // Every inject() below uses light-my-request's default remoteAddress, so
    // both users share one IP — proving the limiter is keyed by user, not IP.
    async function registerUser(server: ReturnType<typeof buildServer>, username: string) {
      const response = await server.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          email: `${username}@example.com`,
          username,
          name: username,
          authKey: "p",
          passwordSalt: "s",
          passwordWrappedPrivateKey: "w",
          recoveryWrappedPrivateKey: "r",
          publicKey: "k",
        },
      });
      const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
      return { userId: response.json().userId as string, cookies: { e2ee_drop_session: cookie.value } };
    }

    // Enables 2FA directly in the DB so setup doesn't consume limiter attempts.
    async function enableTotpDirectly(userId: string): Promise<string> {
      const secret = generateTotpSecret();
      await prisma.user.update({
        where: { id: userId },
        data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) },
      });
      return secret;
    }

    const disable = (server: ReturnType<typeof buildServer>, cookies: Record<string, string>, code: string) =>
      server.inject({ method: "POST", url: "/api/auth/2fa/disable", cookies, payload: { code } });

    it("429s /2fa/disable after 5 attempts for one user — even with a valid code — without affecting another user on the same IP", async () => {
      const server = buildServer();
      const victim = await registerUser(server, "victim");
      const other = await registerUser(server, "other");
      const victimSecret = await enableTotpDirectly(victim.userId);
      const otherSecret = await enableTotpDirectly(other.userId);

      for (let i = 0; i < 5; i++) {
        expect((await disable(server, victim.cookies, "000000")).statusCode).toBe(401);
      }
      // The 6th attempt is rejected before the code is even checked: a
      // correct code does not get through while the user is throttled.
      const validCode = new TOTP({ secret: Secret.fromBase32(victimSecret) }).generate();
      const blocked = await disable(server, victim.cookies, validCode);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: expect.any(String) });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.userId } })).totpEnabled).toBe(true);

      // A different user from the same IP has their own bucket.
      const otherCode = new TOTP({ secret: Secret.fromBase32(otherSecret) }).generate();
      expect((await disable(server, other.cookies, otherCode)).statusCode).toBe(200);
    });

    it("429s /2fa/enable after 5 wrong codes, and the bucket is shared with /2fa/disable", async () => {
      const server = buildServer();
      const user = await registerUser(server, "enabler");
      expect((await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies: user.cookies })).statusCode).toBe(200);

      const enable = (code: string) =>
        server.inject({ method: "POST", url: "/api/auth/2fa/enable", cookies: user.cookies, payload: { code } });
      for (let i = 0; i < 5; i++) {
        expect((await enable("000000")).statusCode).toBe(401);
      }
      expect((await enable("000000")).statusCode).toBe(429);
      expect((await disable(server, user.cookies, "000000")).statusCode).toBe(429);
    });

    it("allows legitimate traffic under the limit: a few mistyped codes, then a correct one, still disables 2FA", async () => {
      const server = buildServer();
      const user = await registerUser(server, "typo");
      const secret = await enableTotpDirectly(user.userId);

      for (let i = 0; i < 3; i++) {
        expect((await disable(server, user.cookies, "000000")).statusCode).toBe(401);
      }
      const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate();
      expect((await disable(server, user.cookies, code)).statusCode).toBe(200);
    });
  });
});
