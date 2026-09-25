// apps/api/src/routes/passwordReset.ts
import type { FastifyInstance } from "fastify";
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

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function findValidResetToken(token: string) {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.expiresAt.getTime() < Date.now()) return null;
  return record;
}

export function registerPasswordResetRoutes(server: FastifyInstance): void {
  server.post<{ Body: PasswordResetRequestRequest }>(
    "/api/auth/password-reset/request",
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

  server.post<{ Body: { token: string } }>("/api/auth/password-reset/verify-token", async (request, reply) => {
    const record = await findValidResetToken(request.body.token);
    if (!record) return reply.status(400).send({ error: "Invalid or expired reset token" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    const body: PasswordResetVerifyTokenResponse = {
      email: user.email,
      passwordSalt: user.passwordSalt,
      recoveryWrappedPrivateKey: user.recoveryWrappedPrivateKey,
    };
    return reply.send(body);
  });

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
    async (request, reply) => {
      const { token, newAuthKey, newPasswordSalt, newPasswordWrappedPrivateKey } = request.body;
      const record = await findValidResetToken(token);
      if (!record) return reply.status(400).send({ error: "Invalid or expired reset token" });

      await prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(newAuthKey),
          passwordSalt: newPasswordSalt,
          passwordWrappedPrivateKey: newPasswordWrappedPrivateKey,
        },
      });
      // Revoke every existing session so a cookie issued before this reset
      // stops working immediately — otherwise an attacker who stole a
      // session cookie before the reset would keep access after it.
      await deleteAllUserSessions(record.userId);
      await prisma.passwordResetToken.delete({ where: { id: record.id } });
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
    async (request, reply) => {
      const {
        token,
        newAuthKey,
        newPasswordSalt,
        newPasswordWrappedPrivateKey,
        newRecoveryWrappedPrivateKey,
        newPublicKey,
      } = request.body;
      const record = await findValidResetToken(token);
      if (!record) return reply.status(400).send({ error: "Invalid or expired reset token" });

      await cascadeDeleteUserLinks(record.userId);
      const user = await prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(newAuthKey),
          passwordSalt: newPasswordSalt,
          passwordWrappedPrivateKey: newPasswordWrappedPrivateKey,
          recoveryWrappedPrivateKey: newRecoveryWrappedPrivateKey,
          publicKey: newPublicKey,
        },
      });
      await createDefaultLinkForUser(user.id, user.username, user.publicKey);
      await deleteAllUserSessions(user.id);
      await prisma.passwordResetToken.delete({ where: { id: record.id } });
      return reply.send({ reset: true });
    }
  );
}
