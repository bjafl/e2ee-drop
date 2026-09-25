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
  // Link.slug is globally unique (schema.prisma), so at most one row can match.
  return prisma.link.findUnique({ where: { slug }, include: { drops: true } });
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
// Scoping by linkId matters because drop ids are not secret to a link holder
// (GET /api/links/:slug returns an anonymous link's drop to anyone with its slug),
// so a drop id alone must never authorize a transition on some other link's drop.
// Owned links' drop ids are only ever returned to their sender (upload-url) and
// to the owner (owner-gated /drops and /events), never by that public route. Returns true iff exactly the intended transition happened;
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

// `db` lets callers run this inside a prisma.$transaction alongside the
// User write it belongs with (registration, fresh-key password reset), so a
// failure here rolls back that write too.
export async function createDefaultLinkForUser(
  userId: string,
  username: string,
  publicKey: string,
  db: Prisma.TransactionClient = prisma
): Promise<Link> {
  return db.link.create({
    data: {
      ownerId: userId,
      slug: username,
      mode: "permanent",
      visibility: "public",
      recipientPublicKey: publicKey,
      isDefault: true,
    },
  });
}

export async function toLinkStatusResponse(
  link: Link & { drops: Drop[] }
): Promise<LinkStatusResponse> {
  // This response is served unauthenticated (GET /api/links/:slug). For an
  // anonymous link that's fine: its random slug IS the capability, and Plan 1's
  // anonymous flow reads `drop` from here. An owned link's slug is public (the
  // default one is the owner's username), so exposing its drop here would hand
  // any stranger a queued drop's id, fileName, message and status — and the id
  // is what the /complete route acts on. Owned links never report a drop here;
  // the owner reads their queue from the owner-gated GET /api/links/:slug/drops
  // and GET /api/links/:slug/events instead.
  const activeDrop = link.ownerId === null ? (link.drops[0] ?? null) : null;
  const base: LinkStatusResponse = {
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
  if (!link.ownerId) return base;

  const owner = await prisma.user.findUnique({ where: { id: link.ownerId } });
  if (!owner) return base;

  return { ...base, recipientName: owner.name, recipientEmailVerified: owner.emailVerified };
}
