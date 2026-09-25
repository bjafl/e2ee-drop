// apps/api/src/routes/auth.ts
import type { FastifyInstance } from "fastify";
import { prisma, Prisma } from "@e2ee-drop/db";
import type { RegisterRequest, RegisterResponse } from "@e2ee-drop/shared";
import { hashPassword } from "../lib/passwordAuth";
import { createDefaultLinkForUser } from "../lib/links";
import { createSession } from "../lib/sessions";
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
}
