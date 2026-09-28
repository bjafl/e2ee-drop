// apps/api/src/routes/auth.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { encryptTotpSecret, generateTotpSecret } from "../lib/totp";
import { TOTP, Secret } from "otpauth";
import { loginRateLimiter } from "../lib/rateLimit";
import { env } from "../env";
import { fakePublicKey } from "../test/fakeKeys";

// Registration sends a best-effort verification email (routes/auth.ts); mock
// the mailer for the whole file so every register() call in every describe
// block below exercises that real code path against a stub instead of
// needing real SMTP config, and so isMailerConfigured() always reports true
// regardless of the test env's SMTP_* vars. vi.mock's factory is hoisted
// above any top-level `const`, so the mock fn itself must be created via
// vi.hoisted() to avoid a "Cannot access before initialization" error.
const { sendVerificationEmailMock } = vi.hoisted(() => ({
  sendVerificationEmailMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer")>();
  return { ...actual, sendVerificationEmail: sendVerificationEmailMock, isMailerConfigured: () => true };
});

// The /api/auth/login rate limiter (lib/rateLimit.ts) is a module-level Map
// shared across every test in this file (and every buildServer() call,
// since it's imported once per process) — without this, attempts made by
// one test's login calls would carry over into the next test and could
// spuriously 429 an otherwise-passing assertion, since light-my-request's
// default inject() remoteAddress is the same for every call unless a test
// overrides it.
beforeEach(() => {
  loginRateLimiter.clear();
  sendVerificationEmailMock.mockClear();
});

describe("POST /api/auth/register", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("registers a new user, creates their default permanent link, and sets a session cookie", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "alice@example.com",
        username: "alice",
        name: "Alice",
        authKey: "correct horse battery staple",
        passwordSalt: "c2FsdA==",
        passwordWrappedPrivateKey: "d3JhcHBlZA==",
        recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
        publicKey: fakePublicKey("cHVia2V5"),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.username).toBe("alice");
    expect(body.defaultLinkSlug).toBe("alice");
    expect(response.cookies.some((c: { name: string }) => c.name === "e2ee_drop_session")).toBe(true);

    const link = await prisma.link.findFirst({ where: { slug: "alice" } });
    expect(link?.isDefault).toBe(true);
    expect(link?.mode).toBe("permanent");
    expect(link?.ownerId).toBe(body.userId);
  });

  it("rejects a numeric email with 400 (not 500) via the route's JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: 12345,
        username: "numericemail",
        name: "Numeric",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { username: "numericemail" } })).toBeNull();
  });

  it("rejects an email over the 254-char maxLength with 400 (not 500) via JSON-schema body validation", async () => {
    const server = buildServer();
    const longEmail = `${"a".repeat(250)}@x.co`; // 255 chars, one over the RFC 254-char limit
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: longEmail,
        username: "toolongemail",
        name: "Too Long",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { username: "toolongemail" } })).toBeNull();
  });

  it("rejects a name over the 100-char maxLength with 400 (not 500) via JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "toolongname@example.com",
        username: "toolongname",
        name: "a".repeat(101),
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { username: "toolongname" } })).toBeNull();
  });

  it("accepts an email and name exactly at their maxLength (254 and 100 chars respectively)", async () => {
    const server = buildServer();
    const atLimitEmail = `${"a".repeat(249)}@x.co`; // exactly 254 chars
    expect(atLimitEmail).toHaveLength(254);
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: atLimitEmail,
        username: "atlimitfields",
        name: "a".repeat(100),
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "atlimitfields" } });
    expect(user.email).toHaveLength(254);
    expect(user.name).toHaveLength(100);
  });

  it("returns 409 (not 500) and leaves no orphaned user when the username equals an existing anonymous link's slug", async () => {
    const server = buildServer();
    // An anonymous one-time link, created the real way; its random slug is a
    // valid username (lowercase alphanumeric, 16 chars).
    const created = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: fakePublicKey("YW5vbi1rZXk=") },
    });
    const anonSlug: string = created.json().slug;
    const anonLink = await prisma.link.findUniqueOrThrow({ where: { slug: anonSlug } });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "collide@example.com",
        username: anonSlug,
        name: "Collide",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Email or username already in use" });
    // The user insert was rolled back with the failed link insert.
    expect(await prisma.user.findUnique({ where: { email: "collide@example.com" } })).toBeNull();
    expect(await prisma.session.count()).toBe(0);
    // The anonymous link is untouched and still the only link with that slug.
    const stillThere = await prisma.link.findUniqueOrThrow({ where: { slug: anonSlug } });
    expect(stillThere.id).toBe(anonLink.id);
    expect(stillThere.ownerId).toBeNull();
    expect(await prisma.link.count({ where: { slug: anonSlug } })).toBe(1);
  });

  it("returns 409 when the email is already registered", async () => {
    const server = buildServer();
    const payload = {
      email: "bob@example.com",
      username: "bob",
      name: "Bob",
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: fakePublicKey("k1"),
    };
    await server.inject({ method: "POST", url: "/api/auth/register", payload });
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, username: "bob2", publicKey: fakePublicKey("k2") },
    });

    expect(second.statusCode).toBe(409);
  });

  it("normalizes email to lowercase/trimmed on write, so a mixed-case duplicate 409s", async () => {
    const server = buildServer();
    const payload = {
      email: "  Dana@Example.com  ",
      username: "dana",
      name: "Dana",
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: fakePublicKey("k1"),
    };
    const first = await server.inject({ method: "POST", url: "/api/auth/register", payload });
    expect(first.statusCode).toBe(200);
    const stored = await prisma.user.findUnique({ where: { username: "dana" } });
    expect(stored?.email).toBe("dana@example.com");

    // A second registration with a different case/whitespace variant of the
    // SAME address must collide (409), not create a second account — proving
    // normalization happens at write time, not just at lookup time.
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, email: "DANA@EXAMPLE.COM", username: "dana2", publicKey: fakePublicKey("k2") },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects a publicKey that isn't 32 bytes of base64 with a clear 400", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "grief@example.com",
        username: "griefer",
        name: "Griefer",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        // The griefer case from the plan's review: "AAAA" base64-decodes to 3
        // bytes, not 32.
        publicKey: "AAAA",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { username: "griefer" } })).toBeNull();
  });

  it("returns 409 when the username is already registered (different email)", async () => {
    const server = buildServer();
    const payload = {
      email: "carol@example.com",
      username: "carol",
      name: "Carol",
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: fakePublicKey("k1"),
    };
    await server.inject({ method: "POST", url: "/api/auth/register", payload });
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, email: "carol2@example.com", publicKey: fakePublicKey("k2") },
    });

    expect(second.statusCode).toBe(409);
    // Only the first registration's user/link should exist.
    const users = await prisma.user.findMany({ where: { username: "carol" } });
    expect(users).toHaveLength(1);
  });

  it("rejects registration when ALLOW_REGISTRATION is disabled", async () => {
    vi.resetModules();
    vi.doMock("../env", () => ({ env: { ALLOW_REGISTRATION: false, DEFAULT_STORAGE_QUOTA_BYTES: 1000 } }));
    const Fastify = (await import("fastify")).default;
    const { registerAuthRoutes } = await import("./auth");
    const freshServer = Fastify();
    registerAuthRoutes(freshServer);

    const response = await freshServer.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "x@example.com",
        username: "x",
        name: "X",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(403);
    vi.doUnmock("../env");
    vi.resetModules();
  });

  it("rejects a username containing characters that would break /d/<username> routing", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "dave@example.com",
        username: "dave/../etc",
        name: "Dave",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(400);
    const user = await prisma.user.findFirst({ where: { email: "dave@example.com" } });
    expect(user).toBeNull();
  });

  it("rejects a username that collides with a reserved application route", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "create@example.com",
        username: "create",
        name: "Create",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(400);
    const user = await prisma.user.findFirst({ where: { email: "create@example.com" } });
    expect(user).toBeNull();
  });

  // Regression test: an earlier version combined the length and charset
  // checks into a single regex with a `(?:...)?` optional group that could
  // only match 0 or >=2 extra characters after the first, never exactly 1 —
  // so a 2-char username like "ab" was wrongly rejected (while a bare 1-char
  // username was wrongly accepted). Length and charset are now checked
  // independently; this pins the boundary that broke.
  it("rejects a 2-character username as too short (below the 3-32 char minimum)", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "ab@example.com",
        username: "ab",
        name: "Ab",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/3-32/);
    const user = await prisma.user.findFirst({ where: { email: "ab@example.com" } });
    expect(user).toBeNull();
  });
});


describe("POST /api/auth/register — email verification", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("sends a verification email and stores a hashed token on successful registration", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "verify-me@example.com",
        username: "verifyme",
        name: "Verify Me",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });

    expect(response.statusCode).toBe(200);
    // The send is fire-and-forget: the route kicks it off but does not await
    // it on the response path (so a slow/blackholed SMTP host can't delay
    // the response into a proxy timeout). sendVerificationEmailFor itself
    // awaits a DB write before it ever calls the mock, so — unlike a truly
    // synchronous call — the mock may still not have been invoked yet when
    // inject() resolves. Poll briefly instead of asserting immediately.
    await vi.waitFor(() => {
      expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
    });
    const [to, url] = sendVerificationEmailMock.mock.calls[0];
    expect(to).toBe("verify-me@example.com");
    expect(url).toContain("/verify-email/confirm?token=");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "verify-me@example.com" } });
    expect(user.emailVerified).toBe(false);
    // Likewise, the token row is written by an `await` inside
    // sendVerificationEmailFor's own body, which — since the route no
    // longer awaits that whole call — may still be in flight. Poll briefly
    // for it instead of asserting immediately.
    await vi.waitFor(async () => {
      const tokenRow = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id } });
      expect(tokenRow).not.toBeNull();
    });
  });

  it("still succeeds when the mailer send throws (best-effort)", async () => {
    sendVerificationEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "resilient@example.com",
        username: "resilient",
        name: "Resilient",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it("logs (via request.log.warn) when the best-effort send fails, without blocking the response", async () => {
    sendVerificationEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    const server = buildServer();

    // request.log is a per-request pino child logger that generates its own
    // independent level methods (warn/info/etc.) rather than inheriting them
    // from server.log — pino's setLevel() assigns each level method as a
    // fresh, own-property function on whichever instance it's called for, so
    // spying on server.log.warn (proven by direct experiment) never observes
    // a call made through some request's own request.log.warn. Instead, wrap
    // the actual per-request instance in place via an onRequest hook, which
    // runs early enough (before the route handler) to patch the exact
    // request.log the handler and its later .catch() callback will both use.
    const warnCalls: unknown[][] = [];
    server.addHook("onRequest", (request, _reply, done) => {
      const original = request.log.warn.bind(request.log);
      request.log.warn = (...args: Parameters<typeof original>) => {
        warnCalls.push(args);
        return original(...args);
      };
      done();
    });

    const start = Date.now();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "logs-on-failure@example.com",
        username: "logsonfailure",
        name: "Logs On Failure",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("k"),
      },
    });
    const elapsedMs = Date.now() - start;

    expect(response.statusCode).toBe(200);
    // The response must not wait on the (failing) mail send — it should
    // return promptly rather than only after the send's own rejection.
    expect(elapsedMs).toBeLessThan(500);

    await vi.waitFor(() => {
      expect(warnCalls).toHaveLength(1);
    });
    const [logArg, msgArg] = warnCalls[0];
    expect(msgArg).toBe("verification email send failed");
    expect(logArg).toMatchObject({ err: expect.anything() });
    // Never logs the verification URL or token itself, only the error.
    expect(JSON.stringify(warnCalls)).not.toContain("/verify-email/confirm?token=");
  });
});

describe("POST /api/auth/register rate limiting (registerRateLimiter: 10 per 15 min, keyed by IP)", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  const registerFrom = (server: ReturnType<typeof buildServer>, ip: string, username: string) =>
    server.inject({
      method: "POST",
      url: "/api/auth/register",
      remoteAddress: ip,
      payload: {
        email: `${username}@example.com`,
        username,
        name: username,
        authKey: "p",
        passwordSalt: "c2FsdA==",
        passwordWrappedPrivateKey: "d3JhcHBlZA==",
        recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
        publicKey: fakePublicKey("cHVia2V5"),
      },
    });

  it("allows up to the limit, then 429s the same IP without creating a user, while a different IP is unaffected", async () => {
    const server = buildServer();
    // Every attempt up to the limit is legitimate traffic and must succeed.
    for (let i = 0; i < 10; i++) {
      expect((await registerFrom(server, "203.0.113.20", `spam${i}`)).statusCode).toBe(200);
    }
    const blocked = await registerFrom(server, "203.0.113.20", "spam10");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: expect.any(String) });
    expect(await prisma.user.findUnique({ where: { username: "spam10" } })).toBeNull();

    expect((await registerFrom(server, "198.51.100.20", "legit")).statusCode).toBe(200);
  });
});
describe("POST /api/auth/login, /api/auth/logout, GET /api/auth/me", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  async function register(server: ReturnType<typeof buildServer>, overrides: Record<string, unknown> = {}) {
    return server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "carol@example.com",
        username: "carol",
        name: "Carol",
        authKey: "correct horse battery staple",
        passwordSalt: "c2FsdA==",
        passwordWrappedPrivateKey: "d3JhcHBlZA==",
        recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
        publicKey: fakePublicKey("cHVia2V5"),
        ...overrides,
      },
    });
  }

  it("logs in with the correct password and returns key-wrapping material", async () => {
    const server = buildServer();
    await register(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", authKey: "correct horse battery staple" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passwordWrappedPrivateKey).toBe("d3JhcHBlZA==");
    expect(body.passwordSalt).toBe("c2FsdA==");
  });

  it("rejects the wrong password", async () => {
    const server = buildServer();
    await register(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", authKey: "wrong password" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("logs in with a different case/whitespace variant of the registered email", async () => {
    const server = buildServer();
    await register(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "  Carol@Example.COM  ", authKey: "correct horse battery staple" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects an email over the 254-char maxLength on /api/auth/login with 400 (not 500) via JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: `${"a".repeat(250)}@x.co`, authKey: "correct horse battery staple" }, // 255 chars
    });

    expect(response.statusCode).toBe(400);
  });

  it("requires a TOTP code when 2FA is enabled, accepts a valid one, and rejects replaying it", async () => {
    const server = buildServer();
    await register(server);
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { email: "carol@example.com" },
      data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) },
    });

    const withoutCode = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", authKey: "correct horse battery staple" },
    });
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.json().requiresTotp).toBe(true);

    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const code = totp.generate();

    const withCode = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", authKey: "correct horse battery staple", totpCode: code },
    });
    expect(withCode.statusCode).toBe(200);

    const replay = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", authKey: "correct horse battery staple", totpCode: code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("accepts a valid unused backup code at login in place of a TOTP code", async () => {
    const server = buildServer();
    const registerRes = await register(server);
    const cookieValue = registerRes.cookies.find((c) => c.name === "e2ee_drop_session")!.value;

    const setupRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/setup",
      cookies: { e2ee_drop_session: cookieValue },
    });
    const { secretBase32 } = setupRes.json();
    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    const enableRes = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies: { e2ee_drop_session: cookieValue },
      payload: { code: totp.generate() },
    });
    const [backupCode] = enableRes.json().backupCodes as string[];

    const loginRes = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", authKey: "correct horse battery staple", totpCode: backupCode },
    });
    expect(loginRes.statusCode).toBe(200);

    // Reused — must now fail.
    const secondLoginRes = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", authKey: "correct horse battery staple", totpCode: backupCode },
    });
    expect(secondLoginRes.statusCode).toBe(401);
  });

  it("allows legitimate traffic well under the rate limit (regression guard against an overly strict window)", async () => {
    const server = buildServer();
    await register(server);

    // 5 attempts is comfortably under the 8/minute limit (lib/rateLimit.ts).
    for (let i = 0; i < 5; i++) {
      const response = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.0.0.1",
        payload: { email: "carol@example.com", authKey: "correct horse battery staple" },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("rate-limits repeated login attempts from the same IP with 429, without affecting a different IP", async () => {
    const server = buildServer();
    await register(server);

    const attempt = (ip: string) =>
      server.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: ip,
        payload: { email: "carol@example.com", authKey: "wrong password" },
      });

    // Exhaust the 8/minute limit (lib/rateLimit.ts) for one IP.
    for (let i = 0; i < 8; i++) {
      const response = await attempt("203.0.113.5");
      expect(response.statusCode).toBe(401);
    }
    const blocked = await attempt("203.0.113.5");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: expect.any(String) });

    // A different IP has its own bucket and is unaffected.
    const otherIp = await attempt("198.51.100.9");
    expect(otherIp.statusCode).toBe(401);
  });

  it("resets the login rate limit once the window has elapsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const server = buildServer();
      await register(server);

      const attempt = () =>
        server.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "192.0.2.20",
          payload: { email: "carol@example.com", authKey: "wrong password" },
        });

      for (let i = 0; i < 8; i++) {
        const response = await attempt();
        expect(response.statusCode).toBe(401);
      }
      expect((await attempt()).statusCode).toBe(429);

      // Advance past the 1-minute window (lib/rateLimit.ts).
      vi.setSystemTime(Date.now() + 61_000);

      expect((await attempt()).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("client IP resolution through the X-Forwarded-For chain (TRUST_PROXY_HOPS)", () => {
    // Each case sends 8 failed logins then a 9th (which must be 429) from a
    // "blocked" XFF chain, then checks whether a request from a "sibling"
    // chain shares that bucket. The socket peer (remoteAddress) is always
    // the same innermost proxy, as it is in production.
    async function exhaustThenProbe(
      trustProxyHops: number,
      blocked: { remoteAddress: string; xff?: string },
      probe: { remoteAddress: string; xff?: string },
    ) {
      const server = buildServer({ trustProxyHops });
      await register(server);
      const attempt = (r: { remoteAddress: string; xff?: string }) =>
        server.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: r.remoteAddress,
          headers: r.xff ? { "x-forwarded-for": r.xff } : {},
          payload: { email: "carol@example.com", authKey: "wrong password" },
        });
      for (let i = 0; i < 8; i++) {
        expect((await attempt(blocked)).statusCode).toBe(401);
      }
      expect((await attempt(blocked)).statusCode).toBe(429);
      return (await attempt(probe)).statusCode;
    }

    it("hops=1 (shipped nginx only): keys on the rightmost XFF entry and ignores client-supplied entries to its left", async () => {
      // nginx (10.0.0.2) appends the real client 203.0.113.7; "6.6.6.6" is
      // a spoofed value the client put in the header itself.
      const nginx = "10.0.0.2";
      // Same real client, different spoofed prefix: still the same bucket.
      expect(
        await exhaustThenProbe(
          1,
          { remoteAddress: nginx, xff: "6.6.6.6, 203.0.113.7" },
          { remoteAddress: nginx, xff: "7.7.7.7, 203.0.113.7" },
        ),
      ).toBe(429);
      loginRateLimiter.clear();
      // A different real client behind the same nginx: separate bucket.
      expect(
        await exhaustThenProbe(
          1,
          { remoteAddress: nginx, xff: "6.6.6.6, 203.0.113.7" },
          { remoteAddress: nginx, xff: "203.0.113.8" },
        ),
      ).toBe(401);
    });

    it("hops=2 (operator proxy in front of nginx): distinct clients behind the same operator proxy get distinct buckets", async () => {
      // client -> operator proxy (192.0.2.50) -> nginx (10.0.0.2) -> api.
      // nginx appends 192.0.2.50; the operator proxy appended the client.
      const nginx = "10.0.0.2";
      expect(
        await exhaustThenProbe(
          2,
          { remoteAddress: nginx, xff: "6.6.6.6, 203.0.113.7, 192.0.2.50" },
          { remoteAddress: nginx, xff: "198.51.100.9, 192.0.2.50" },
        ),
      ).toBe(401);
      loginRateLimiter.clear();
      // Same real client, different spoofed prefix: still the same bucket.
      expect(
        await exhaustThenProbe(
          2,
          { remoteAddress: nginx, xff: "6.6.6.6, 203.0.113.7, 192.0.2.50" },
          { remoteAddress: nginx, xff: "203.0.113.7, 192.0.2.50" },
        ),
      ).toBe(429);
    });

    it("hops=1 behind an extra, unaccounted-for proxy collapses every client into one bucket (the misconfiguration README warns about)", async () => {
      const nginx = "10.0.0.2";
      expect(
        await exhaustThenProbe(
          1,
          { remoteAddress: nginx, xff: "203.0.113.7, 192.0.2.50" },
          { remoteAddress: nginx, xff: "198.51.100.9, 192.0.2.50" },
        ),
      ).toBe(429);
    });
  });

  describe("session cookie Secure attribute", () => {
    type ResponseCookie = { name: string; value: string; secure?: boolean; httpOnly?: boolean; path?: string };
    const sessionCookieOf = (response: { cookies: ResponseCookie[] }) =>
      response.cookies.find((c) => c.name === "e2ee_drop_session")!;
    const original = env.SECURE_COOKIES;
    afterEach(() => {
      env.SECURE_COOKIES = original;
    });

    it("omits Secure when APP_URL is http:// (local dev), so the browser still sends the cookie back", async () => {
      env.SECURE_COOKIES = false;
      const server = buildServer();
      const cookie = sessionCookieOf(await register(server));
      expect(cookie.secure).toBeFalsy();
      expect(cookie.httpOnly).toBe(true);
      const logout = await server.inject({ method: "POST", url: "/api/auth/logout" });
      expect(sessionCookieOf(logout).secure).toBeFalsy();
    });

    it("sets Secure on register, login and the logout clear when APP_URL is https://", async () => {
      env.SECURE_COOKIES = true;
      const server = buildServer();
      const registerCookie = sessionCookieOf(await register(server));
      expect(registerCookie.secure).toBe(true);
      expect(registerCookie.httpOnly).toBe(true);

      const login = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "carol@example.com", authKey: "correct horse battery staple" },
      });
      expect(login.statusCode).toBe(200);
      expect(sessionCookieOf(login).secure).toBe(true);

      const logout = await server.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: { e2ee_drop_session: registerCookie.value },
      });
      const cleared = sessionCookieOf(logout);
      expect(cleared.value).toBe("");
      expect(cleared.secure).toBe(true);
      expect(cleared.path).toBe("/");
    });
  });

  it("logs out and clears the session so /me subsequently 403s", async () => {
    const server = buildServer();
    const registerResponse = await register(server);
    const cookie = registerResponse.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;

    const meBefore = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { e2ee_drop_session: cookie.value },
    });
    expect(meBefore.statusCode).toBe(200);

    await server.inject({ method: "POST", url: "/api/auth/logout", cookies: { e2ee_drop_session: cookie.value } });

    const meAfter = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { e2ee_drop_session: cookie.value },
    });
    expect(meAfter.statusCode).toBe(403);
  });
});

describe("POST /api/auth/prelogin", () => {
  // A realistic salt, shaped like the web client's generateWrappingSalt()
  // output: 16 random bytes, base64-encoded (24 chars incl. "==" padding).
  const REAL_SALT = Buffer.from("0123456789abcdef").toString("base64");

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  async function prelogin(server: ReturnType<typeof buildServer>, email: string) {
    return server.inject({ method: "POST", url: "/api/auth/prelogin", payload: { email } });
  }

  it("returns the stored passwordSalt for a registered email", async () => {
    const server = buildServer();
    await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "gina@example.com",
        username: "gina",
        name: "Gina",
        authKey: "k",
        passwordSalt: REAL_SALT,
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("pk"),
      },
    });

    const response = await prelogin(server, "gina@example.com");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passwordSalt: REAL_SALT });
  });

  it("returns the same real salt for a different case/whitespace variant of a registered email", async () => {
    const server = buildServer();
    await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "gina2@example.com",
        username: "gina2",
        name: "Gina2",
        authKey: "k",
        passwordSalt: REAL_SALT,
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: fakePublicKey("pk2"),
      },
    });

    const response = await prelogin(server, "  GINA2@Example.com  ");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passwordSalt: REAL_SALT });
  });

  it("returns a same-shaped fake salt for an unregistered email", async () => {
    const server = buildServer();
    const response = await prelogin(server, "nobody@example.com");

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body)).toEqual(["passwordSalt"]);
    expect(body.passwordSalt).toHaveLength(REAL_SALT.length);
    expect(body.passwordSalt).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(body.passwordSalt, "base64")).toHaveLength(16);
  });

  it("returns the same fake salt every time for the same unregistered email", async () => {
    const server = buildServer();
    const first = (await prelogin(server, "nobody@example.com")).json().passwordSalt;
    const second = (await prelogin(server, "nobody@example.com")).json().passwordSalt;
    expect(second).toBe(first);
  });

  it("returns different fake salts for different unregistered emails", async () => {
    const server = buildServer();
    const a = (await prelogin(server, "nobody-a@example.com")).json().passwordSalt;
    const b = (await prelogin(server, "nobody-b@example.com")).json().passwordSalt;
    expect(a).not.toBe(b);
  });

  it("returns 400 when email is missing", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "POST", url: "/api/auth/prelogin", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an email over the 254-char maxLength with 400 (not 500) via JSON-schema body validation", async () => {
    const server = buildServer();
    const response = await prelogin(server, `${"a".repeat(250)}@x.co`); // 255 chars
    expect(response.statusCode).toBe(400);
  });

  it("accepts an email at the 254-char maxLength", async () => {
    const server = buildServer();
    const response = await prelogin(server, `${"a".repeat(249)}@x.co`); // exactly 254 chars
    expect(response.statusCode).toBe(200);
  });
});
