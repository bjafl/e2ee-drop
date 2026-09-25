// apps/api/src/routes/auth.ts
import type { FastifyInstance } from "fastify";
import { prisma, Prisma } from "@e2ee-drop/db";
import type { RegisterRequest, RegisterResponse, LoginRequest, LoginResponse, MeResponse } from "@e2ee-drop/shared";
import { hashPassword, verifyPassword } from "../lib/passwordAuth";
import { decryptTotpSecret, verifyTotpCode } from "../lib/totp";
import { createDefaultLinkForUser } from "../lib/links";
import { createSession, deleteSession } from "../lib/sessions";
import { getUsedCodesForUser } from "../lib/totpReplayGuard";
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

// Lazily computed once per process and cached — see the comment at its call
// site in the login route (timing-attack mitigation for email enumeration).
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hashPassword("dummy-password-for-timing-equalization-only");
  }
  return dummyPasswordHashPromise;
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
      password,
      passwordSalt,
      passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey,
      publicKey,
    } = request.body;
    if (
      !email ||
      !username ||
      !name ||
      !password ||
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

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await prisma.user.create({
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
    } catch (error: unknown) {
      // P2002 (unique constraint violation) fires identically whether it's
      // `email` or `username` that collided — email and username are each
      // `@unique` on User (schema.prisma) — so this single catch covers
      // both without needing to inspect error.meta.target.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.status(409).send({ error: "Email or username already in use" });
      }
      throw error;
    }

    const defaultLink = await createDefaultLinkForUser(user.id, user.username, user.publicKey);
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

  server.post<{ Body: LoginRequest }>("/api/auth/login", async (request, reply) => {
    const { email, password, totpCode } = request.body;
    if (!email || !password) return reply.status(400).send({ error: "Missing email or password" });

    const user = await prisma.user.findUnique({ where: { email } });
    // Always run a password verification, even when no user was found —
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
    const passwordValid = await verifyPassword(password, passwordHash);
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
