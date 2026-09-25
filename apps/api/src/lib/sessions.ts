// apps/api/src/lib/sessions.ts
import { randomBytes } from "node:crypto";
import { prisma, Prisma } from "@e2ee-drop/db";

const SESSION_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;

// The session id is a bearer credential (it is the session cookie's value),
// so it is generated here from 256 bits of CSPRNG output rather than left to
// the Prisma schema's `@default(cuid())`: cuid v1 embeds a timestamp, a
// counter and a host fingerprint alongside little actual randomness. Same
// generator as password-reset tokens (routes/passwordReset.ts). base64url has
// no ".", so the signed cookie's "<value>.<signature>" format stays unambiguous.
const SESSION_ID_BYTES = 32;

export function generateSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  return prisma.session.create({
    data: { id: generateSessionId(), userId, expiresAt: new Date(Date.now() + SESSION_LENGTH_MS) },
  });
}

export async function getUserIdFromSession(sessionId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    // Lazy-expiry delete. This runs inside the auth plugin's onRequest hook
    // (plugins/auth.ts), i.e. on every request — so two requests bearing the
    // same expired session cookie (e.g. a page firing parallel API calls)
    // routinely both land here and race to delete the same row. Tolerate
    // P2025 ("record not found") the same way deleteLinkIfExists (lib/links.ts)
    // does: the desired end state (row gone) is already true, so the loser
    // of the race isn't an error, just a no-op.
    try {
      await prisma.session.delete({ where: { id: sessionId } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")) {
        throw error;
      }
    }
    return null;
  }
  return session.userId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function deleteAllUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
