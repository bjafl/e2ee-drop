// apps/api/src/routes/contacts.ts
import type { FastifyInstance } from "fastify";
import {
  sendContactRequest,
  listContacts,
  acceptContactRequest,
  rejectContactRequest,
  blockContact,
  unblockContact,
} from "../lib/contacts";

// Errors from lib/contacts.ts are not caught here. Intended, user-facing
// failures are thrown as HttpError (lib/httpErrors.ts) and the global error
// handler returns their status + message; anything else (e.g. a Prisma
// error) is logged and reported to the client as a generic 500.
export function registerContactRoutes(server: FastifyInstance): void {
  server.post<{ Body: { username: string } }>(
    "/api/contacts",
    {
      preHandler: server.requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            username: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const contact = await sendContactRequest(request.user!.id, request.body.username);
      return reply.send(contact);
    }
  );

  server.get("/api/contacts", { preHandler: server.requireAuth }, async (request, reply) => {
    const contacts = await listContacts(request.user!.id);
    return reply.send(contacts);
  });

  server.post<{ Params: { id: string } }>(
    "/api/contacts/:id/accept",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const contact = await acceptContactRequest(request.user!.id, request.params.id);
      return reply.send(contact);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/contacts/:id/reject",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      await rejectContactRequest(request.user!.id, request.params.id);
      return reply.send({ deleted: true });
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/contacts/:id/block",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const contact = await blockContact(request.user!.id, request.params.id);
      return reply.send(contact);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/contacts/:id/unblock",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      await unblockContact(request.user!.id, request.params.id);
      return reply.send({ deleted: true });
    }
  );
}
