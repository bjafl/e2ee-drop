// apps/api/src/lib/links.ts
import { customAlphabet } from "nanoid";
import { prisma, Prisma, type Link, type Drop } from "@e2ee-drop/db";
import type { DropStatus, DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";
import { env } from "../env";
import { resolveLocale, deriveCodewords, CODEWORD_MAX_COUNT } from "./codewords";

const nanoid = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 16);

export async function createOneTimeLink(recipientPublicKey: string, locale?: string): Promise<Link> {
  return prisma.link.create({
    data: {
      slug: nanoid(),
      mode: "one-time",
      recipientPublicKey,
      codewordLocale: resolveLocale(locale),
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

// Deletes a Link by id, tolerating the case where it's already gone. Multiple
// call sites (the user-initiated DELETE route, the cleanup job's sweep) can
// independently decide the same link should be deleted and race each other;
// whichever loses that race would otherwise see Prisma's delete() throw P2025
// ("record not found"). Since the desired end state — the row is gone — is
// already true in that case, treat it as success rather than propagating an
// error a caller isn't expecting.
export async function deleteLinkIfExists(id: string): Promise<void> {
  try {
    await prisma.link.delete({ where: { id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return; // already gone — someone else (cleanup, another request) got there first
    }
    throw error;
  }
}

// Atomically advances a drop's status, compare-and-swap style: the row is only
// written if it (a) is this drop, (b) belongs to this link, and (c) is currently
// in one of `fromStatuses` at write time. Same discipline as the download-url
// handler's `updateMany` in routes/downloads.ts — a single conditional UPDATE, so
// a concurrent request can't slip in between a read and a blind write.
//
// Scoping by linkId matters because drop ids are not secret (GET /api/links/:slug
// returns them), so a drop id alone must never authorize a transition on some
// other link's drop. Returns true iff exactly the intended transition happened;
// callers map false to 404 (unknown drop, wrong link, or wrong prior status are
// deliberately indistinguishable).
export async function transitionDropStatus(
  dropId: string,
  linkId: string,
  fromStatuses: readonly DropStatus[],
  toStatus: DropStatus
): Promise<boolean> {
  const { count } = await prisma.drop.updateMany({
    where: { id: dropId, linkId, status: { in: [...fromStatuses] } },
    data: { status: toStatus },
  });
  return count === 1;
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
    codewords: deriveCodewords(
      link.recipientPublicKey,
      resolveLocale(link.codewordLocale),
      CODEWORD_MAX_COUNT
    ),
  };
}
