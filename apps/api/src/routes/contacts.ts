// apps/api/src/routes/contacts.ts
import type { FastifyInstance } from "fastify";
import {
  sendContactRequest,
  listContacts,
  acceptContactRequest,
  rejectContactRequest,
} from "../lib/contacts";

interface ErrorWithStatus extends Error {
  statusCode?: number;
}

export function registerContactRoutes(server: FastifyInstance): void {
  server.post<{ Body: { username: string } }>(
    "/api/contacts",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      try {
        const contact = await sendContactRequest(request.user!.id, request.body.username);
        return reply.send(contact);
      } catch (error) {
        return reply.status(400).send({ error: (error as Error).message });
      }
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
      try {
        const contact = await acceptContactRequest(request.user!.id, request.params.id);
        return reply.send(contact);
      } catch (error) {
        const err = error as ErrorWithStatus;
        return reply.status(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/contacts/:id/reject",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      try {
        await rejectContactRequest(request.user!.id, request.params.id);
        return reply.send({ deleted: true });
      } catch (error) {
        const err = error as ErrorWithStatus;
        return reply.status(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );
}
