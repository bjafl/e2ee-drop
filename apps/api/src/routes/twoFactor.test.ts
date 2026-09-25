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
});
