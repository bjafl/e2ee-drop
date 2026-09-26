// apps/api/src/routes/verifyEmail.ts
import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { EmailVerificationResendResponse } from "@e2ee-drop/shared";
import { isMailerConfigured, sendVerificationEmail } from "../lib/mailer";
import { emailVerificationResendRateLimiter, rateLimitExceededBody } from "../lib/rateLimit";
import { env } from "../env";

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function sendVerificationEmailFor(userId: string, email: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS) },
  });
  if (isMailerConfigured()) {
    await sendVerificationEmail(email, `${env.APP_URL}/verify-email/confirm?token=${token}`);
  }
}

async function verifyEmailResendRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!emailVerificationResendRateLimiter.attempt(request.user!.id)) {
    reply.status(429).send(rateLimitExceededBody());
  }
}

export function registerVerifyEmailRoutes(server: FastifyInstance): void {
  server.post<{ Body: { token?: string } }>(
    "/api/auth/verify-email/confirm",
    { schema: { body: { type: "object", properties: { token: { type: "string" } } } } },
    async (request, reply) => {
      const token = request.body?.token;
      if (!token) return reply.status(400).send({ error: "Missing token" });

      const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashVerificationToken(token) } });
      if (!record || record.expiresAt.getTime() < Date.now()) {
        return reply.status(400).send({ error: "Invalid or expired token" });
      }

      // Compare-and-delete: only the request that actually removes the row may
      // proceed, so a concurrent double-submit can't both "succeed".
      const { count } = await prisma.emailVerificationToken.deleteMany({ where: { id: record.id } });
      if (count !== 1) return reply.status(400).send({ error: "Invalid or expired token" });

      await prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } });
      return reply.send({ verified: true });
    }
  );

  server.post(
    "/api/auth/verify-email/resend",
    { preHandler: [server.requireAuth, verifyEmailResendRateLimit] },
    async (request, reply) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
      // Invalidate any outstanding token first — only the newest emailed link works.
      await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
      await sendVerificationEmailFor(user.id, user.email);
      const body: EmailVerificationResendResponse = { sent: true, emailDeliveryAvailable: isMailerConfigured() };
      return reply.send(body);
    }
  );
}
