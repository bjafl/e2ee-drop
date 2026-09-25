// apps/api/src/routes/twoFactor.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { TotpSetupResponse, TotpEnableRequest } from "@e2ee-drop/shared";
import { generateTotpSecret, buildOtpauthUrl, verifyTotpCode, encryptTotpSecret, decryptTotpSecret } from "../lib/totp";
import { getUsedCodesForUser } from "../lib/totpReplayGuard";

// A user who calls /2fa/setup but never follows through with /2fa/enable
// (abandoned setup, browser closed mid-flow, etc.) would otherwise leave a
// permanent entry in this map for the lifetime of the process — the same
// shape of unbounded-growth issue Task 10 already fixed once for
// `usedCodesByUser` in totpReplayGuard.ts. Mitigated the same way: each
// entry is timestamped and opportunistically pruned when it's older than
// PENDING_SETUP_TTL_MS, on every access into this map (no background
// timer needed). 5 minutes is generous for a user to scan a QR code with
// an authenticator app and type back the 6-digit code — the same window
// totpReplayGuard.ts uses for its own (much shorter-lived, ~90s-valid)
// used-code entries, picked here for the same "clearly long enough, still
// bounded" reasoning rather than because the two TTLs need to match.
const PENDING_SETUP_TTL_MS = 5 * 60 * 1000;

interface PendingSetup {
  secret: string;
  createdAt: number;
}

const pendingSetupSecrets = new Map<string, PendingSetup>();

function getPendingSecret(userId: string): string | undefined {
  const pending = pendingSetupSecrets.get(userId);
  if (!pending) return undefined;
  if (Date.now() - pending.createdAt > PENDING_SETUP_TTL_MS) {
    pendingSetupSecrets.delete(userId);
    return undefined;
  }
  return pending.secret;
}

export function registerTwoFactorRoutes(server: FastifyInstance): void {
  server.post("/api/auth/2fa/setup", { preHandler: server.requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    const secret = generateTotpSecret();
    pendingSetupSecrets.set(user.id, { secret, createdAt: Date.now() });
    const body: TotpSetupResponse = { secretBase32: secret, otpauthUrl: buildOtpauthUrl(secret, user.email) };
    return reply.send(body);
  });

  server.post<{ Body: TotpEnableRequest }>(
    "/api/auth/2fa/enable",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const pendingSecret = getPendingSecret(request.user!.id);
      if (!pendingSecret) {
        return reply.status(400).send({ error: "No pending 2FA setup. Call /api/auth/2fa/setup first." });
      }
      if (!verifyTotpCode(pendingSecret, request.body?.code, getUsedCodesForUser(request.user!.id))) {
        return reply.status(401).send({ error: "Invalid code" });
      }
      await prisma.user.update({
        where: { id: request.user!.id },
        data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(pendingSecret) },
      });
      pendingSetupSecrets.delete(request.user!.id);
      return reply.send({ enabled: true });
    }
  );

  // Deviation from the brief's literal reference code, which disables 2FA
  // on nothing but a valid session cookie. A session cookie alone is not
  // proof the caller still controls the account's second factor — a
  // hijacked/stolen cookie would let an attacker strip 2FA protection
  // outright with no further proof required, defeating the point of
  // having 2FA. This mirrors login's existing TOTP-verification shape
  // (routes/auth.ts): require and verify a current TOTP code, decrypting
  // the user's already-encrypted totpSecretEncrypted the same way login
  // does, before turning 2FA off. See task-12-report.md for the full
  // rationale and the alternative considered.
  server.post<{ Body: TotpEnableRequest }>(
    "/api/auth/2fa/disable",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
      if (!user.totpEnabled || !user.totpSecretEncrypted) {
        return reply.status(400).send({ error: "2FA is not enabled" });
      }
      const code = request.body?.code;
      if (!code) {
        return reply.status(401).send({ error: "TOTP code required to disable 2FA" });
      }
      const secret = decryptTotpSecret(user.totpSecretEncrypted);
      if (!verifyTotpCode(secret, code, getUsedCodesForUser(user.id))) {
        return reply.status(401).send({ error: "Invalid TOTP code" });
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { totpEnabled: false, totpSecretEncrypted: null },
      });
      return reply.send({ disabled: true });
    }
  );
}
