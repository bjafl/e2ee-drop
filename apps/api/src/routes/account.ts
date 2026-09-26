// apps/api/src/routes/account.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@e2ee-drop/db";
import { verifyPassword } from "../lib/passwordAuth";
import { cascadeDeleteUserLinks } from "../lib/accountDeletion";
import { accountDeletionRateLimiter, rateLimitExceededBody } from "../lib/rateLimit";

// Keyed by the authenticated user's id, not IP — a shared IP (multiple
// users behind one NAT/VPN) must not collide. Runs after requireAuth in the
// preHandler chain below, so request.user is guaranteed non-null here.
async function accountDeletionRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!accountDeletionRateLimiter.attempt(request.user!.id)) {
    reply.status(429).send(rateLimitExceededBody());
  }
}

export function registerAccountRoutes(server: FastifyInstance): void {
  server.delete<{ Body: { authKey: string } }>(
    "/api/account",
    {
      preHandler: [server.requireAuth, accountDeletionRateLimit],
      schema: {
        body: {
          type: "object",
          properties: {
            authKey: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      // apps/api/src/plugins/auth.ts decorates the request as
      // `request.user: { id: string } | null`; requireAuth (the preHandler
      // above) already 403s when it's null, so it's non-null here.
      const userId = request.user!.id;

      // authKey (not the raw password) — see /api/auth/login for the
      // established pattern. Sending a raw password to any server route,
      // even an already-authenticated one, would reopen the zero-knowledge
      // gap Plan 2's finding C1 closed.
      const { authKey } = request.body;
      if (!authKey) {
        return reply.status(400).send({ error: "Password confirmation is required" });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.status(404).send({ error: "Account not found" });

      const passwordValid = await verifyPassword(authKey, user.passwordHash);
      if (!passwordValid) {
        return reply.status(403).send({ error: "Incorrect password" });
      }

      // Delete links/drops/MinIO objects FIRST. If this throws (e.g. MinIO is
      // temporarily unreachable), we abort before touching Session/Contact/User
      // rows, so a storage outage never leaves the account half-deleted — the
      // whole operation can simply be retried once storage is back. This
      // ordering also matters because Link.owner has onDelete: Cascade at the
      // DB level: deleting the User row first would let Postgres auto-cascade
      // every Link/Drop row before the app ever saw which MinIO objects
      // needed cleanup, permanently orphaning storage.
      await cascadeDeleteUserLinks(userId);

      await prisma.$transaction([
        prisma.session.deleteMany({ where: { userId } }),
        prisma.contact.deleteMany({ where: { OR: [{ userId }, { contactUserId: userId }] } }),
        prisma.user.delete({ where: { id: userId } }),
      ]);

      return reply.send({ deleted: true });
    }
  );

  server.patch<{ Body: { allowContactRequests?: boolean } }>(
    "/api/account",
    {
      preHandler: server.requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            allowContactRequests: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      // Only field supported today; a body without it is a no-op rather than
      // a 400, so a future settings field added to the same route doesn't
      // force every existing caller to send every field on each PATCH.
      if (request.body.allowContactRequests === undefined) {
        return reply.send({ updated: false });
      }

      await prisma.user.update({
        where: { id: request.user!.id },
        data: { allowContactRequests: request.body.allowContactRequests },
      });

      return reply.send({ updated: true });
    }
  );
}
