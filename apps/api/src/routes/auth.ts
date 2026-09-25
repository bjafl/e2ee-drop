// apps/api/src/routes/auth.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma, Prisma } from "@e2ee-drop/db";
import { createHmac } from "node:crypto";
import type {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PreloginRequest,
  PreloginResponse,
} from "@e2ee-drop/shared";
import { hashPassword, verifyPassword } from "../lib/passwordAuth";
import { decryptTotpSecret, verifyTotpCode } from "../lib/totp";
import { createDefaultLinkForUser } from "../lib/links";
import { createSession, deleteSession } from "../lib/sessions";
import { getUsedCodesForUser } from "../lib/totpReplayGuard";
import { loginRateLimiter, rateLimitExceededBody } from "../lib/rateLimit";
import { env } from "../env";
import { SESSION_COOKIE_NAME } from "../plugins/auth";

// A registered user's default personal Link is always addressable at
// `/d/<username>` (see spec §5) — the username therefore doubles as a
// permanent URL path segment, so it must be restricted to characters that
// are safe there (no `/`, no `..`, no whitespace) and long-lived enough
// that a bad choice can't be walked back casually. Lowercase-only avoids
// splitting identity across case variants of the same slug.
//
// Length and charset are deliberately checked separately (isValidUsername
// below), not combined into one regex: a single regex trying to express
// "3-32 chars, first/last alphanumeric, middle alphanumeric/-/_" via a
// `(?:...)?` optional group previously had a bug where the optional group
// could only match 0 or >=2 extra characters, never exactly 1 — so it
// silently accepted a 1-char username while rejecting a legitimate 2-char
// one. Splitting length from charset avoids that class of off-by-one bug.
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;
const USERNAME_CHARSET_PATTERN = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

// Route segments already used (or reserved for) by the app's own frontend
// and API routes — a username matching one of these would either shadow an
// existing route or collide with a route this plan's spec says is coming
// (`/d/<username>`, §5). Kept intentionally broader than only what exists
// today, since a username is effectively permanent once claimed.
const RESERVED_USERNAMES = new Set([
  "api",
  "d",
  "create",
  "send",
  "download",
  "downloads",
  "login",
  "logout",
  "register",
  "me",
  "settings",
  "contacts",
  "contact",
  "health",
  "auth",
  "links",
  "link",
  "uploads",
  "upload",
  "static",
  "assets",
  "public",
  "admin",
  "reset-password",
  "verify-email",
  "favicon.ico",
]);

function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_CHARSET_PATTERN.test(username) &&
    !RESERVED_USERNAMES.has(username)
  );
}

// Must match the decoded byte length of the web client's
// generateWrappingSalt() (apps/web/src/lib/keyWrapping.ts: 16 random bytes,
// base64-encoded). A fake salt of any other length/encoding would let a
// caller of /prelogin distinguish registered from unregistered emails.
const WRAPPING_SALT_BYTES = 16;

// Deterministic per-email fake salt for /prelogin on an unregistered email:
// HMAC-SHA256 keyed by the server secret, so it is stable across calls (like
// a real stored salt would be) but unpredictable without APP_SECRET_KEY. The
// fixed prefix domain-separates this HMAC from any other use of the key.
function fakePasswordSaltForEmail(email: string): string {
  return createHmac("sha256", env.APP_SECRET_KEY)
    .update(`e2ee-drop-prelogin-fake-salt-v1:${email}`)
    .digest()
    .subarray(0, WRAPPING_SALT_BYTES)
    .toString("base64");
}

// Lazily computed once per process and cached — see the comment at its call
// site in the login route (timing-attack mitigation for email enumeration).
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hashPassword("dummy-password-for-timing-equalization-only");
  }
  return dummyPasswordHashPromise;
}

// Keyed by request.ip — see server.ts's trustProxy comment for why
// that resolves to the real client IP behind the shipped nginx, not
// nginx's own address. Rejecting here (before the route handler runs) means
// a caller who's hit the limit never pays the handler's Argon2id cost.
async function loginRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!loginRateLimiter.attempt(request.ip)) {
    reply.status(429).send(rateLimitExceededBody());
  }
}

export function registerAuthRoutes(server: FastifyInstance): void {
  server.post<{ Body: RegisterRequest }>("/api/auth/register", async (request, reply) => {
    if (!env.ALLOW_REGISTRATION) {
      return reply.status(403).send({ error: "Registration is disabled on this instance" });
    }

    const {
      email,
      username,
      name,
      authKey,
      passwordSalt,
      passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey,
      publicKey,
    } = request.body;
    if (
      !email ||
      !username ||
      !name ||
      !authKey ||
      !passwordSalt ||
      !passwordWrappedPrivateKey ||
      !recoveryWrappedPrivateKey ||
      !publicKey
    ) {
      return reply.status(400).send({ error: "Missing required fields" });
    }

    if (!isValidUsername(username)) {
      return reply.status(400).send({
        error:
          "Username must be 3-32 characters, lowercase letters/numbers/hyphens/underscores only, and not a reserved name",
      });
    }

    // authKey (not the password) is what gets Argon2id-hashed and stored —
    // see RegisterRequest.authKey for why the server never sees the password.
    const passwordHash = await hashPassword(authKey);

    // User + default Link in one transaction: if the link insert fails, the
    // user row is rolled back too, rather than leaving an account with no
    // default link whose email/username would then 409 on every retry.
    let user;
    let defaultLink;
    try {
      ({ user, defaultLink } = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            username,
            name,
            passwordHash,
            passwordSalt,
            passwordWrappedPrivateKey,
            recoveryWrappedPrivateKey,
            publicKey,
            storageQuotaBytes: env.DEFAULT_STORAGE_QUOTA_BYTES,
          },
        });
        const link = await createDefaultLinkForUser(created.id, created.username, created.publicKey, tx);
        return { user: created, defaultLink: link };
      }));
    } catch (error: unknown) {
      // P2002 (unique constraint violation) covers every collision here
      // without inspecting error.meta.target: `email` and `username` are
      // each @unique on User, and Link.slug (= username for the default
      // link) is globally unique, so a username equal to an existing
      // anonymous link's slug also lands here. All are "already in use".
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.status(409).send({ error: "Email or username already in use" });
      }
      throw error;
    }

    const session = await createSession(user.id);

    reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });

    const body: RegisterResponse = { userId: user.id, username: user.username, defaultLinkSlug: defaultLink.slug };
    return reply.send(body);
  });

  // Step one of login: the client needs passwordSalt before it can derive the
  // authKey it sends to /login. Unregistered emails get a same-shaped,
  // deterministic fake salt (see fakePasswordSaltForEmail) instead of an
  // error, so this endpoint cannot be used to enumerate accounts.
  server.post<{ Body: PreloginRequest }>("/api/auth/prelogin", async (request, reply) => {
    const email = request.body?.email;
    if (!email || typeof email !== "string") return reply.status(400).send({ error: "Missing email" });
    const user = await prisma.user.findUnique({ where: { email }, select: { passwordSalt: true } });
    const body: PreloginResponse = { passwordSalt: user?.passwordSalt ?? fakePasswordSaltForEmail(email) };
    return reply.send(body);
  });

  server.post<{ Body: LoginRequest }>("/api/auth/login", { preHandler: loginRateLimit }, async (request, reply) => {
    const { email, authKey, totpCode } = request.body;
    if (!email || !authKey) return reply.status(400).send({ error: "Missing email or authKey" });

    const user = await prisma.user.findUnique({ where: { email } });
    // Always run a credential (authKey) verification, even when no user was found —
    // `verifyPassword` (Argon2id) is deliberately slow, and skipping it
    // entirely on the "unknown email" branch would make that branch return
    // measurably faster than "known email, wrong password". Both branches
    // already return the identical error message and status code; without
    // this, a network-timing attacker could still distinguish them and
    // enumerate registered emails. `getDummyPasswordHash()` hashes a fixed,
    // meaningless password once (lazily, cached for the process lifetime)
    // purely so this branch pays a comparable Argon2id cost — its result is
    // never used for anything but timing.
    const passwordHash = user?.passwordHash ?? (await getDummyPasswordHash());
    const passwordValid = await verifyPassword(authKey, passwordHash);
    if (!user || !passwordValid) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    if (user.totpEnabled) {
      if (!totpCode) {
        return reply.status(401).send({ error: "TOTP code required", requiresTotp: true });
      }
      const secret = decryptTotpSecret(user.totpSecretEncrypted!);
      if (!verifyTotpCode(secret, totpCode, getUsedCodesForUser(user.id))) {
        return reply.status(401).send({ error: "Invalid TOTP code" });
      }
    }

    const session = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });

    const body: LoginResponse = {
      userId: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      publicKey: user.publicKey,
      passwordSalt: user.passwordSalt,
      passwordWrappedPrivateKey: user.passwordWrappedPrivateKey,
      totpEnabled: user.totpEnabled,
    };
    return reply.send(body);
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) await deleteSession(unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.send({ loggedOut: true });
  });

  server.get("/api/auth/me", { preHandler: server.requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user!.id } });
    if (!user) return reply.status(404).send({ error: "User not found" });
    const body: MeResponse = {
      userId: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      publicKey: user.publicKey,
      passwordSalt: user.passwordSalt,
      passwordWrappedPrivateKey: user.passwordWrappedPrivateKey,
      totpEnabled: user.totpEnabled,
    };
    return reply.send(body);
  });
}
