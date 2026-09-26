// apps/api/src/routes/twoFactor.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { TotpSetupResponse, TotpEnableRequest } from "@e2ee-drop/shared";
import { generateTotpSecret, buildOtpauthUrl, verifyTotpCode, encryptTotpSecret, decryptTotpSecret } from "../lib/totp";
import { getUsedCodesForUser } from "../lib/totpReplayGuard";
import { twoFactorRateLimiter, rateLimitExceededBody } from "../lib/rateLimit";
import { generateAndStoreBackupCodes } from "../lib/totpBackupCodes";

// Keyed by the authenticated user's id (same convention as account.ts's
// accountDeletionRateLimit): runs after requireAuth, so request.user is
// non-null. Throttles TOTP-code guessing on /2fa/enable and /2fa/disable —
// see twoFactorRateLimiter in lib/rateLimit.ts for the limit and reasoning.
async function twoFactorRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!twoFactorRateLimiter.attempt(request.user!.id)) {
    reply.status(429).send(rateLimitExceededBody());
  }
}

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
    // A session cookie alone must not be enough to replace an existing second
    // factor (a stolen cookie + the attacker's own authenticator would
    // otherwise take over 2FA). Rotating requires /2fa/disable first, which
    // demands a valid code from the CURRENT secret — the same proof-of-
    // possession rule /2fa/disable already applies.
    if (user.totpEnabled) {
      return reply.status(409).send({ error: "2FA is already enabled. Disable it first to set up a new authenticator." });
    }
    const secret = generateTotpSecret();
    pendingSetupSecrets.set(user.id, { secret, createdAt: Date.now() });
    const body: TotpSetupResponse = { secretBase32: secret, otpauthUrl: buildOtpauthUrl(secret, user.email) };
    return reply.send(body);
  });

  server.post<{ Body: TotpEnableRequest }>(
    "/api/auth/2fa/enable",
    {
      preHandler: [server.requireAuth, twoFactorRateLimit],
      schema: {
        body: {
          type: "object",
          properties: {
            code: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const alreadyEnabled = { error: "2FA is already enabled. Disable it first to set up a new authenticator." };
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
      if (user.totpEnabled) return reply.status(409).send(alreadyEnabled);
      const pendingSecret = getPendingSecret(user.id);
      if (!pendingSecret) {
        return reply.status(400).send({ error: "No pending 2FA setup. Call /api/auth/2fa/setup first." });
      }
      if (!verifyTotpCode(pendingSecret, request.body?.code, getUsedCodesForUser(user.id))) {
        return reply.status(401).send({ error: "Invalid code" });
      }
      // Compare-and-swap on totpEnabled (same updateMany + count pattern as
      // transitionDropStatus in lib/links.ts): if a concurrent /enable won the
      // race after the check above, this writes nothing instead of
      // overwriting the secret that request just enabled.
      const { count } = await prisma.user.updateMany({
        where: { id: user.id, totpEnabled: false },
        data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(pendingSecret) },
      });
      pendingSetupSecrets.delete(user.id);
      if (count !== 1) return reply.status(409).send(alreadyEnabled);
      const backupCodes = await generateAndStoreBackupCodes(user.id);
      return reply.send({ enabled: true, backupCodes });
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
    {
      preHandler: [server.requireAuth, twoFactorRateLimit],
      schema: {
        body: {
          // Deviation from the brief's literal schema (`type: "object"`):
          // twoFactor.test.ts's "rejects disabling 2FA without a valid TOTP
          // code" test calls this route with NO body at all (not even `{}`).
          // Fastify substitutes `null` for a wholly absent body before Ajv
          // sees it (lib/validation.js's validateParam), so a strict
          // `type: "object"` schema would reject that call with 400 before
          // the handler's own `if (!code) return 401` ever ran — turning
          // that test's expected 401 into a 400. Allowing "null" here is
          // safe: the handler already reads the field via `request.body?.code`
          // (optional chaining), never destructures `request.body` directly,
          // so a null body cannot crash it.
          type: ["object", "null"],
          properties: {
            code: { type: "string" },
          },
        },
      },
    },
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

  server.post<{ Body: TotpEnableRequest }>(
    "/api/auth/2fa/backup-codes/regenerate",
    {
      preHandler: [server.requireAuth, twoFactorRateLimit],
      schema: { body: { type: ["object", "null"], properties: { code: { type: "string" } } } },
    },
    async (request, reply) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
      if (!user.totpEnabled || !user.totpSecretEncrypted) {
        return reply.status(400).send({ error: "2FA is not enabled" });
      }
      const code = request.body?.code;
      if (!code) return reply.status(401).send({ error: "TOTP code required" });
      const secret = decryptTotpSecret(user.totpSecretEncrypted);
      if (!verifyTotpCode(secret, code, getUsedCodesForUser(user.id))) {
        return reply.status(401).send({ error: "Invalid TOTP code" });
      }
      const backupCodes = await generateAndStoreBackupCodes(user.id);
      return reply.send({ backupCodes });
    }
  );
}
