// apps/api/src/lib/links.ts
import { customAlphabet } from "nanoid";
import { prisma, type Link, type Drop } from "@e2ee-drop/db";
import type { DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";
import { env } from "../env";

const nanoid = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 16);

export async function createOneTimeLink(recipientPublicKey: string): Promise<Link> {
  return prisma.link.create({
    data: {
      slug: nanoid(),
      mode: "one-time",
      recipientPublicKey,
      expiresAt: new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000),
    },
  });
}

export async function getLinkBySlug(slug: string): Promise<(Link & { drops: Drop[] }) | null> {
  return prisma.link.findFirst({ where: { slug }, include: { drops: true } });
}

export function isLinkExpired(link: Link): boolean {
  return link.expiresAt !== null && link.expiresAt.getTime() < Date.now();
}

export function toDropSummary(drop: Drop): DropSummary {
  return {
    id: drop.id,
    status: drop.status as DropSummary["status"],
    senderPublicKey: drop.senderPublicKey,
    nonce: drop.nonce,
    fileName: drop.fileName,
    fileSize: drop.fileSize,
    mimeType: drop.mimeType,
    contentMD5: drop.contentMD5,
    message: drop.message,
  };
}

export function toLinkStatusResponse(link: Link & { drops: Drop[] }): LinkStatusResponse {
  const activeDrop = link.drops[0] ?? null;
  return {
    slug: link.slug,
    mode: link.mode as LinkStatusResponse["mode"],
    recipientPublicKey: link.recipientPublicKey,
    drop: activeDrop ? toDropSummary(activeDrop) : null,
    isAnonymous: link.ownerId === null,
  };
}
