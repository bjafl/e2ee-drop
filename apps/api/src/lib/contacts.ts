// apps/api/src/lib/contacts.ts
import { prisma, type Contact } from "@e2ee-drop/db";

export interface ContactSummary {
  id: string;
  userId: string;
  username: string;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing";
}

export async function sendContactRequest(userId: string, targetUsername: string): Promise<Contact> {
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target) throw new Error("User not found");
  if (target.id === userId) throw new Error("Cannot add yourself as a contact");

  const existing = await prisma.contact.findFirst({
    where: {
      OR: [
        { userId, contactUserId: target.id },
        { userId: target.id, contactUserId: userId },
      ],
    },
  });
  if (existing) throw new Error("A contact relationship already exists");

  return prisma.contact.create({ data: { userId, contactUserId: target.id, status: "pending" } });
}

export async function listContacts(
  userId: string
): Promise<{ pending: ContactSummary[]; accepted: ContactSummary[] }> {
  const rows = await prisma.contact.findMany({
    where: { OR: [{ userId }, { contactUserId: userId }] },
  });
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
      status: row.status as "pending" | "accepted",
      direction: isOutgoing ? "outgoing" : "incoming",
    };
  });

  return {
    pending: summaries.filter((summary) => summary.status === "pending"),
    accepted: summaries.filter((summary) => summary.status === "accepted"),
  };
}

export async function acceptContactRequest(userId: string, contactId: string): Promise<Contact> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw Object.assign(new Error("Contact request not found"), { statusCode: 404 });
  if (row.contactUserId !== userId) {
    throw Object.assign(new Error("Only the request's recipient can accept it"), { statusCode: 403 });
  }
  return prisma.contact.update({ where: { id: contactId }, data: { status: "accepted" } });
}

export async function rejectContactRequest(userId: string, contactId: string): Promise<void> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw Object.assign(new Error("Contact request not found"), { statusCode: 404 });
  if (row.userId !== userId && row.contactUserId !== userId) {
    throw Object.assign(new Error("Not part of this contact relationship"), { statusCode: 403 });
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
