// apps/api/src/routes/auth.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { encryptTotpSecret, generateTotpSecret } from "../lib/totp";
import { TOTP, Secret } from "otpauth";
import { loginRateLimiter } from "../lib/rateLimit";

// The /api/auth/login rate limiter (lib/rateLimit.ts) is a module-level Map
// shared across every test in this file (and every buildServer() call,
// since it's imported once per process) — without this, attempts made by
// one test's login calls would carry over into the next test and could
// spuriously 429 an otherwise-passing assertion, since light-my-request's
// default inject() remoteAddress is the same for every call unless a test
// overrides it.
beforeEach(() => {
  loginRateLimiter.clear();
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
        publicKey: "cHVia2V5",
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

  it("returns 409 (not 500) and leaves no orphaned user when the username equals an existing anonymous link's slug", async () => {
    const server = buildServer();
    // An anonymous one-time link, created the real way; its random slug is a
    // valid username (lowercase alphanumeric, 16 chars).
    const created = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "YW5vbi1rZXk=" },
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
        publicKey: "k",
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
      publicKey: "k1",
    };
    await server.inject({ method: "POST", url: "/api/auth/register", payload });
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, username: "bob2", publicKey: "k2" },
    });

    expect(second.statusCode).toBe(409);
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
      publicKey: "k1",
    };
    await server.inject({ method: "POST", url: "/api/auth/register", payload });
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, email: "carol2@example.com", publicKey: "k2" },
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
        publicKey: "k",
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
        publicKey: "k",
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
        publicKey: "k",
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
        publicKey: "k",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/3-32/);
    const user = await prisma.user.findFirst({ where: { email: "ab@example.com" } });
    expect(user).toBeNull();
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
        publicKey: "cHVia2V5",
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
        publicKey: "cHVia2V5",
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
        publicKey: "pk",
      },
    });

    const response = await prelogin(server, "gina@example.com");
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
});
