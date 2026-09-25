// apps/api/src/lib/httpErrors.ts
import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * An error whose message is deliberately client-facing. Throw this (from a
 * route or from library code a route calls) when the message is a fixed,
 * user-facing string that contains no internal detail. The global error
 * handler returns `{ error: message }` with `statusCode` for these.
 *
 * Any other thrown error is treated as unexpected: it is logged in full
 * server-side and the client only ever sees a generic message. Never put
 * interpolated internal state (ids, queries, paths, upstream error text)
 * into an HttpError message.
 */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export const GENERIC_ERROR_MESSAGE = "Internal server error";

/**
 * Global Fastify error handler (registered in server.ts). Only runs for
 * THROWN errors; handlers that reply.status(4xx).send(...) directly never
 * reach it.
 *
 * - HttpError: our own intentional client-facing error -> its status + message.
 * - Fastify schema-validation errors: 400 with Fastify's message, which is
 *   derived from the route's schema (e.g. "body must have required property
 *   'username'"), not from server state.
 * - Fastify's own 4xx errors (FST_* codes, e.g. invalid/empty JSON body,
 *   unsupported media type, body too large): keep the status, but reply with
 *   the standard HTTP reason phrase instead of the error's message.
 * - Anything else (Prisma errors, bugs, upstream failures): logged in full,
 *   client gets 500 "Internal server error" -- no message, stack, path,
 *   query snippet or argument dump.
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  if (error instanceof HttpError) {
    return reply.status(error.statusCode).send({ error: error.message });
  }

  if (error.validation) {
    request.log.info({ err: error }, "request validation failed");
    return reply.status(400).send({ error: error.message });
  }

  const status = error.statusCode;
  if (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    typeof error.code === "string" &&
    error.code.startsWith("FST_")
  ) {
    request.log.info({ err: error }, "client error");
    return reply.status(status).send({ error: STATUS_CODES[status] ?? "Bad Request" });
  }

  request.log.error({ err: error }, "unhandled error");
  return reply.status(500).send({ error: GENERIC_ERROR_MESSAGE });
}
