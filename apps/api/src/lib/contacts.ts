// apps/api/src/lib/contacts.ts
import { prisma, Prisma, type Contact } from "@e2ee-drop/db";
import { HttpError } from "./httpErrors";

export interface ContactSummary {
  id: string;
  userId: string;
  username: string;
  // "blocked" rows are never surfaced as a status to the blocked party (see
  // listContacts below) — they're filtered out entirely for that side. The
  // blocker's own view surfaces them separately, in listContacts's own
  // `blocked` array, using this same summary shape.
  status: "pending" | "accepted" | "blocked";
  direction: "incoming" | "outgoing";
}

export async function sendContactRequest(userId: string, targetUsername: string): Promise<Contact> {
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target) throw new HttpError(400, "User not found");
  // A target who has turned off contact requests must look identical to a
  // nonexistent user — never reveal that the username belongs to a real
  // account that simply isn't accepting requests. Runs before the
  // self/existing-relationship checks below, on every call.
  if (!target.allowContactRequests) throw new HttpError(400, "User not found");
  if (target.id === userId) throw new HttpError(400, "Cannot add yourself as a contact");

  const existing = await prisma.contact.findFirst({
    where: {
      OR: [
        { userId, contactUserId: target.id },
        { userId: target.id, contactUserId: userId },
      ],
    },
  });
  if (existing) {
    if (existing.status === "blocked" && existing.blockedByUserId === target.id) {
      // The target blocked the caller: this must look identical to the
      // target not existing at all — never reveal a block happened.
      throw new HttpError(400, "User not found");
    }
    throw new HttpError(400, "A contact relationship already exists");
  }

  try {
    return await prisma.contact.create({ data: { userId, contactUserId: target.id, status: "pending" } });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost a same-direction race against another concurrent call for this
      // exact (userId, contactUserId) pair (the findFirst above didn't see
      // it in time) — same user-facing outcome as the pre-check catching it.
      throw new HttpError(400, "A contact relationship already exists");
    }
    throw error;
  }
}

export async function listContacts(
  userId: string
): Promise<{ pending: ContactSummary[]; accepted: ContactSummary[]; blocked: ContactSummary[] }> {
  const rows = (
    await prisma.contact.findMany({ where: { OR: [{ userId }, { contactUserId: userId }] } })
  ).filter((row) => row.status !== "blocked" || row.blockedByUserId === userId);
  const otherIds = rows.map((row) => (row.userId === userId ? row.contactUserId : row.userId));
  const users = await prisma.user.findMany({ where: { id: { in: otherIds } } });
  const usernameById = new Map(users.map((user) => [user.id, user.username]));

  const summaries: ContactSummary[] = rows.map((row) => {
    const isOutgoing = row.userId === userId;
    const otherId = isOutgoing ? row.contactUserId : row.userId;
    return {
      id: row.id,
      userId: otherId,
      username: usernameById.get(otherId) ?? "unknown",
      status: row.status as "pending" | "accepted" | "blocked",
      direction: isOutgoing ? "outgoing" : "incoming",
    };
  });

  return {
    pending: summaries.filter((summary) => summary.status === "pending"),
    accepted: summaries.filter((summary) => summary.status === "accepted"),
    // The `rows` filter above already dropped any row blocked against this
    // caller, so every "blocked" summary remaining here is one the caller
    // themselves blocked (blockedByUserId === userId) — their own block list.
    blocked: summaries.filter((summary) => summary.status === "blocked"),
  };
}

export async function acceptContactRequest(userId: string, contactId: string): Promise<Contact> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw new HttpError(404, "Contact request not found");
  if (row.contactUserId !== userId) {
    throw new HttpError(403, "Only the request's recipient can accept it");
  }
  // A non-pending row (already accepted, or — critically — blocked) is not a
  // pending request to accept. If A blocked B after sending B a request, the
  // row is status: "blocked", blockedByUserId: A, and row.contactUserId still
  // === B, so the membership check above alone would let B "accept" their
  // way out of the block. Treat it the same as a missing row: never a
  // distinguishable message that would leak the row's real status.
  if (row.status !== "pending") throw new HttpError(404, "Contact request not found");
  return prisma.contact.update({ where: { id: contactId }, data: { status: "accepted" } });
}

export async function rejectContactRequest(userId: string, contactId: string): Promise<void> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw new HttpError(404, "Contact request not found");
  if (row.userId !== userId && row.contactUserId !== userId) {
    throw new HttpError(403, "Not part of this contact relationship");
  }
  // A blocked row must not be deletable via /reject by either party — that
  // would let a blocked party immediately re-request and escape the block.
  // Same error message as the non-member case above: a distinguishable
  // message here would itself leak "this row is blocked".
  if (row.status === "blocked") {
    throw new HttpError(403, "Not part of this contact relationship");
  }
  await prisma.contact.delete({ where: { id: contactId } });
}

export async function blockContact(callerId: string, contactId: string): Promise<Contact> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw new HttpError(404, "Contact request not found");
  if (row.userId !== callerId && row.contactUserId !== callerId) {
    throw new HttpError(403, "Not part of this contact relationship");
  }
  // A row already blocked by the OTHER party must not be re-blockable by the
  // blocked party — that would let them seize blockedByUserId and then
  // unblock (delete) the row themselves, escaping the original block. Same
  // error message as the membership check above: a distinguishable message
  // here would itself leak "this row is already blocked by someone else".
  // Re-blocking by the SAME party who already holds the block is a no-op.
  if (row.status === "blocked" && row.blockedByUserId !== callerId) {
    throw new HttpError(403, "Not part of this contact relationship");
  }
  return prisma.contact.update({ where: { id: contactId }, data: { status: "blocked", blockedByUserId: callerId } });
}

export async function unblockContact(callerId: string, contactId: string): Promise<void> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw new HttpError(404, "Contact request not found");
  if (row.status !== "blocked" || row.blockedByUserId !== callerId) {
    throw new HttpError(403, "Only the user who blocked this contact may unblock it");
  }
  await prisma.contact.delete({ where: { id: contactId } });
}

export async function hasAcceptedContact(ownerId: string, otherUserId: string): Promise<boolean> {
  const row = await prisma.contact.findFirst({
    where: {
      status: "accepted",
      OR: [
        { userId: ownerId, contactUserId: otherUserId },
        { userId: otherUserId, contactUserId: ownerId },
      ],
    },
  });
  return row !== null;
}

export async function hasBlockRelationship(userId: string, otherUserId: string): Promise<boolean> {
  const row = await prisma.contact.findFirst({
    where: {
      status: "blocked",
      OR: [
        { userId: userId, contactUserId: otherUserId },
        { userId: otherUserId, contactUserId: userId },
      ],
    },
  });
  return row !== null;
}
