// apps/api/src/routes/passwordReset.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@e2ee-drop/db";
import type {
  PasswordResetRequestRequest,
  PasswordResetRequestResponse,
  PasswordResetVerifyTokenResponse,
  PasswordResetCompleteRequest,
  PasswordResetCompleteFreshRequest,
} from "@e2ee-drop/shared";
import { deleteAllUserSessions } from "../lib/sessions";
import { isMailerConfigured, sendPasswordResetEmail } from "../lib/mailer";
import { cascadeDeleteUserLinks } from "../lib/accountDeletion";
import { createDefaultLinkForUser } from "../lib/links";
import { hashPassword } from "../lib/passwordAuth";
import { env } from "../env";
import {
  passwordResetRequestRateLimiter,
  passwordResetTotpRateLimiter,
  rateLimitExceededBody,
} from "../lib/rateLimit";
import { decryptTotpSecret, verifyTotpCode } from "../lib/totp";
import { getUsedCodesForUser } from "../lib/totpReplayGuard";
import { consumeBackupCodeIfValid } from "../lib/totpBackupCodes";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// Note: neither /complete nor /complete-fresh can check the new password's
// length — they receive newAuthKey, never the password (see the comment at
// /register in routes/auth.ts and apps/web/src/lib/passwordPolicy.ts).

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function findValidResetToken(token: string) {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.expiresAt.getTime() < Date.now()) return null;
  return record;
}

// Consumes a reset token atomically and returns its userId, or null if the
// token is unknown, expired, or was just consumed by a concurrent request.
// Must run BEFORE any credential or link mutation in /complete and
// /complete-fresh:
//   1. Compare-and-delete (same discipline as deleteLinkIfExists /
//      transitionDropStatus in lib/links.ts): only the one request whose
//      deleteMany actually removes the still-unexpired row may proceed, so a
//      double-submitted token can't drive two interleaved resets (which on
//      complete-fresh could mix keys from two different requests).
//   2. Every other outstanding reset token for the user is invalidated, so a
//      completed reset can't be followed by another via an older emailed link.
//   3. All sessions are revoked up front: if a later step fails, the account
//      is left logged-out everywhere (safe), never with a stolen pre-reset
//      session still live while credentials/links are being rewritten.
async function claimResetTokenAndRevokeSessions(token: string): Promise<string | null> {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record) return null;
  const { count } = await prisma.passwordResetToken.deleteMany({
    where: { id: record.id, expiresAt: { gt: new Date() } },
  });
  if (count !== 1) return null;
  await prisma.passwordResetToken.deleteMany({ where: { userId: record.userId, id: { not: record.id } } });
  await deleteAllUserSessions(record.userId);
  return record.userId;
}

type ResetTotpRejection = { status: number; body: { error: string; requiresTotp?: true } };

// Enforces the account's 2FA on /complete and /complete-fresh: an emailed
// reset token alone is a weaker factor than "password + authenticator", so
// for a totpEnabled account it must be paired with a current TOTP code —
// the same standard /login applies (routes/auth.ts), using the same
// verifyTotpCode + per-user replay store, so one code can't be used for
// both a login and a reset (or for two resets).
//
// ORDERING / TOKEN CONSUMPTION — this runs BEFORE
// claimResetTokenAndRevokeSessions and is strictly read-only apart from the
// replay store and the guess limiter:
//   * The token is looked up (not claimed) first, so an invalid/expired
//     token is rejected with the usual 400 before any TOTP handling —
//     nobody can probe an account's 2FA without a live token.
//   * A missing or wrong code returns 401 { requiresTotp: true } and
//     consumes NOTHING: the token stays valid, sessions stay live, no
//     credential/link is touched. Like /login's requiresTotp, the user just
//     resubmits with a (correct) code — they don't need a fresh email for a
//     typo.
//   * Because the token survives a wrong guess, guesses are capped by
//     passwordResetTotpRateLimiter (per user, 5 / 15 min; see rateLimit.ts),
//     and the token itself still dies at its normal 1-hour expiry.
//   * Only after the code verifies does the caller run the atomic
//     compare-and-delete claim, so single-use-on-completion and the
//     concurrent-submit guarantees are exactly as before. If two requests
//     race with the same valid code, the replay store lets only one pass
//     here; with two different valid codes, the claim still lets only one
//     complete.
// Returns null when the request may proceed to the claim.
async function checkResetTotp(token: string, totpCode: unknown): Promise<ResetTotpRejection | null> {
  const invalidToken: ResetTotpRejection = { status: 400, body: { error: "Invalid or expired reset token" } };
  const record = await findValidResetToken(token);
  if (!record) return invalidToken;
  const user = await prisma.user.findUnique({
    where: { id: record.userId },
    select: { id: true, totpEnabled: true, totpSecretEncrypted: true },
  });
  if (!user) return invalidToken;
  if (!user.totpEnabled) return null;

  if (typeof totpCode !== "string" || totpCode === "") {
    return { status: 401, body: { error: "TOTP code required", requiresTotp: true } };
  }
  if (!passwordResetTotpRateLimiter.attempt(user.id)) {
    return { status: 429, body: rateLimitExceededBody() };
  }
  const secret = decryptTotpSecret(user.totpSecretEncrypted!);
  const totpValid = verifyTotpCode(secret, totpCode, getUsedCodesForUser(user.id));
  // Same ordering as /api/auth/login (routes/auth.ts) and the 2FA-management
  // routes (routes/twoFactor.ts): a backup code is checked only when the TOTP
  // check itself fails.
  if (!totpValid && !(await consumeBackupCodeIfValid(user.id, totpCode))) {
    return { status: 401, body: { error: "Invalid TOTP code", requiresTotp: true } };
  }
  return null;
}

// Keyed by the caller's IP and checked before the body is even read, so the
// limit is consumed identically whether or not the submitted email exists —
// a 429 reveals nothing about registered accounts (see
// passwordResetRequestRateLimiter in lib/rateLimit.ts).
async function passwordResetRequestRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!passwordResetRequestRateLimiter.attempt(request.ip)) {
    reply.status(429).send(rateLimitExceededBody());
  }
}

export function registerPasswordResetRoutes(server: FastifyInstance): void {
  server.post<{ Body: PasswordResetRequestRequest }>(
    "/api/auth/password-reset/request",
    {
      preHandler: passwordResetRequestRateLimit,
      schema: {
        body: {
          type: "object",
          properties: {
            email: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body;
      const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
      if (user) {
        const token = randomBytes(32).toString("base64url");
        await prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
        });
        if (isMailerConfigured()) {
          // Must point at the token-consuming page (apps/web App.tsx route
          // /reset-password/confirm), not /reset-password, which is the
          // "enter your email" request page.
          await sendPasswordResetEmail(user.email, `${env.APP_URL}/reset-password/confirm?token=${token}`);
        }
      }
      // Always 200 with the same body, regardless of whether the email is
      // registered, so this endpoint cannot be used to enumerate accounts.
      // emailDeliveryAvailable depends only on server configuration, never on
      // the submitted email, so exposing it leaks nothing about accounts.
      const body: PasswordResetRequestResponse = { requested: true, emailDeliveryAvailable: isMailerConfigured() };
      return reply.send(body);
    }
  );

  server.post<{ Body: { token: string } }>(
    "/api/auth/password-reset/verify-token",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const record = await findValidResetToken(request.body.token);
      if (!record) return reply.status(400).send({ error: "Invalid or expired reset token" });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
      const body: PasswordResetVerifyTokenResponse = {
        email: user.email,
        passwordSalt: user.passwordSalt,
        recoveryWrappedPrivateKey: user.recoveryWrappedPrivateKey,
        totpEnabled: user.totpEnabled,
      };
      return reply.send(body);
    }
  );

  // Recovery-code path: the client re-derived the wrapping key from the
  // user's recovery code and re-wrapped the SAME private key under a new
  // password. Existing Links/Drops (and their recipientPublicKey, which was
  // derived from the OLD public key) remain valid, since the underlying
  // keypair — and therefore publicKey — is unchanged. Only credentials
  // rotate here. Structurally kept separate from complete-fresh below
  // (rather than a shared branching function) because the two paths have
  // different security properties: this one preserves account state, the
  // other destroys and recreates it.
  server.post<{ Body: PasswordResetCompleteRequest }>(
    "/api/auth/password-reset/complete",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            token: { type: "string" },
            newAuthKey: { type: "string" },
            newPasswordSalt: { type: "string" },
            newPasswordWrappedPrivateKey: { type: "string" },
            // Deviation from the brief's literal schema
            // (`type: ["string", "null"]`): passwordReset.test.ts's
            // "rejects a missing or wrong code with 401 requiresTotp" test
            // deliberately sends `totpCode: 123456` (a number) and asserts
            // 401 requiresTotp — checkResetTotp already treats any
            // non-string totpCode as "code required" via its own
            // `typeof totpCode !== "string"` check. A schema-level type
            // constraint here would intercept that value as a 400 before
            // checkResetTotp ever ran. Left unconstrained so every value
            // reaches the handler's existing (already-correct) type check.
            totpCode: {},
          },
        },
      },
    },
    async (request, reply) => {
      const { token, newAuthKey, newPasswordSalt, newPasswordWrappedPrivateKey, totpCode } = (request.body ??
        {}) as Partial<PasswordResetCompleteRequest>;
      if (!token || !newAuthKey || !newPasswordSalt || !newPasswordWrappedPrivateKey) {
        return reply.status(400).send({ error: "Missing required fields" });
      }
      // 2FA gate BEFORE the claim — see checkResetTotp for why a rejection
      // here must leave the token and every other piece of state untouched.
      const totpRejection = await checkResetTotp(token, totpCode);
      if (totpRejection) return reply.status(totpRejection.status).send(totpRejection.body);
      const userId = await claimResetTokenAndRevokeSessions(token);
      if (!userId) return reply.status(400).send({ error: "Invalid or expired reset token" });

      const passwordHash = await hashPassword(newAuthKey);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: { passwordHash, passwordSalt: newPasswordSalt, passwordWrappedPrivateKey: newPasswordWrappedPrivateKey },
        }),
        // Second sweep: closes the window where someone still holding the
        // OLD credentials logged in between the revoke above and this write.
        prisma.session.deleteMany({ where: { userId } }),
      ]);
      return reply.send({ reset: true });
    }
  );

  // No-recovery-code path: the user has lost access to their old private
  // key entirely (no recovery code, no old password), so there is no way to
  // re-wrap the existing key material under new credentials. The only safe
  // option is to generate a brand-new keypair client-side and start over —
  // which means every existing Link (encrypted to the OLD public key) and
  // its Drops are now permanently undecryptable and must be cascade-deleted,
  // followed by a fresh default link under the new public key.
  server.post<{ Body: PasswordResetCompleteFreshRequest }>(
    "/api/auth/password-reset/complete-fresh",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            token: { type: "string" },
            newAuthKey: { type: "string" },
            newPasswordSalt: { type: "string" },
            newPasswordWrappedPrivateKey: { type: "string" },
            newRecoveryWrappedPrivateKey: { type: "string" },
            newPublicKey: { type: "string" },
            // See the matching deviation comment on /complete's schema above.
            totpCode: {},
          },
        },
      },
    },
    async (request, reply) => {
      const {
        token,
        newAuthKey,
        newPasswordSalt,
        newPasswordWrappedPrivateKey,
        newRecoveryWrappedPrivateKey,
        newPublicKey,
        totpCode,
      } = (request.body ?? {}) as Partial<PasswordResetCompleteFreshRequest>;
      if (
        !token ||
        !newAuthKey ||
        !newPasswordSalt ||
        !newPasswordWrappedPrivateKey ||
        !newRecoveryWrappedPrivateKey ||
        !newPublicKey
      ) {
        return reply.status(400).send({ error: "Missing required fields" });
      }
      // 2FA gate BEFORE the claim — see checkResetTotp for why a rejection
      // here must leave the token and every other piece of state untouched.
      const totpRejection = await checkResetTotp(token, totpCode);
      if (totpRejection) return reply.status(totpRejection.status).send(totpRejection.body);
      const userId = await claimResetTokenAndRevokeSessions(token);
      if (!userId) return reply.status(400).send({ error: "Invalid or expired reset token" });

      // Outside the transaction below: it's idempotent (P2025-tolerant, and
      // MinIO deletes succeed on missing keys), so if a later step fails the
      // user can request a new token and retry, converging to the same state.
      await cascadeDeleteUserLinks(userId);
      const passwordHash = await hashPassword(newAuthKey);
      // New keys and the new default link (encrypted to the new public key)
      // commit together or not at all — never new keys with no default link.
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id: userId },
          data: {
            passwordHash,
            passwordSalt: newPasswordSalt,
            passwordWrappedPrivateKey: newPasswordWrappedPrivateKey,
            recoveryWrappedPrivateKey: newRecoveryWrappedPrivateKey,
            publicKey: newPublicKey,
          },
        });
        await createDefaultLinkForUser(user.id, user.username, user.publicKey, tx);
        // Second sweep, as in /complete above.
        await tx.session.deleteMany({ where: { userId } });
      });
      return reply.send({ reset: true });
    }
  );
}
