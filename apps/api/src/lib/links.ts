// apps/api/src/lib/links.ts
import { customAlphabet } from "nanoid";
import { prisma, Prisma, type Link, type Drop } from "@e2ee-drop/db";
import type { FileUploadStatus, DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";
import { env } from "../env";
import { resolveLocale, deriveCodewords } from "./codewords";

const nanoid = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 16);

export async function createOneTimeLink(
  recipientPublicKey: string,
  retentionDays: number,
  locale?: string
): Promise<Link> {
  return prisma.link.create({
    data: {
      slug: nanoid(),
      mode: "one-time",
      recipientPublicKey,
      retentionDays,
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

// Compare-and-swap on Drop.fileUploadStatus only. Narrower than the old transitionDropStatus,
// which also handled the download-side "uploaded"->"downloading"->"downloaded" transitions —
// those no longer live on a single column (see design spec §6.3); plan 2 adds dedicated CAS
// helpers for messageEnvelopeStatus/fileEnvelopeStatus instead of overloading this one.
//
// Scoping by linkId matters because drop ids are not secret (GET /api/links/:slug
// returns them), so a drop id alone must never authorize a transition on some
// other link's drop.
export async function transitionFileUploadStatus(
  dropId: string,
  linkId: string,
  fromStatuses: readonly FileUploadStatus[],
  toStatus: FileUploadStatus,
  db: Prisma.TransactionClient = prisma
): Promise<boolean> {
  const { count } = await db.drop.updateMany({
    where: { id: dropId, linkId, fileUploadStatus: { in: [...fromStatuses] } },
    data: { fileUploadStatus: toStatus },
  });
  return count === 1;
}

export function toDropSummary(drop: Drop, link: { retentionDays: number }): DropSummary {
  return {
    id: drop.id,
    fileUploadStatus: drop.fileUploadStatus as DropSummary["fileUploadStatus"],
    deliveryStatus: drop.deliveryStatus as DropSummary["deliveryStatus"],
    messageEnvelopeStatus: drop.messageEnvelopeStatus as DropSummary["messageEnvelopeStatus"],
    fileEnvelopeStatus: drop.fileEnvelopeStatus as DropSummary["fileEnvelopeStatus"],
    senderPublicKey: drop.senderPublicKey,
    archiveNonce: drop.archiveNonce,
    contentMD5: drop.contentMD5,
    encryptedMetadata: drop.encryptedMetadata,
    metadataNonce: drop.metadataNonce,
    hasMessage: drop.encryptedMessage !== null,
    contentExpiresAt: drop.createdAt.getTime() + link.retentionDays * 24 * 60 * 60 * 1000,
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
      retentionDays: env.DROP_RETENTION_DAYS_DEFAULT,
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
    drop: activeDrop ? toDropSummary(activeDrop, link) : null,
    isAnonymous: link.ownerId === null,
    codewords: link.recipientPublicKey
      ? deriveCodewords(link.recipientPublicKey, link.id, resolveLocale(link.codewordLocale), env.CODEWORD_WORD_COUNT)
      : [], // unclaimed link (design spec §4.2): no recipientPublicKey yet, nothing to derive from
    ownerNote: link.ownerNote ?? undefined,
    retentionDays: link.retentionDays,
    expiresAt: link.expiresAt?.getTime(),
  };
  if (!link.ownerId) return base;

  const owner = await prisma.user.findUnique({ where: { id: link.ownerId } });
  if (!owner) return base;
  // Design spec §9/§6.4: an unverified owner is shown exactly like an anonymous link — no name,
  // username, email, or 2FA badge. `isAnonymous` itself stays `false` here (it means "no owner
  // row", which is still true) — callers needing the display rule check emailVerified directly,
  // exactly as this function already does for the fields below.
  if (!owner.emailVerified) return base;

  const showEmail = owner.showEmailOnPublicProfile || !link.isDefault;

  return {
    ...base,
    recipientName: owner.name,
    recipientUsername: owner.username,
    recipientEmailVerified: owner.emailVerified,
    recipientTotpEnabled: owner.totpEnabled,
    ...(showEmail ? { recipientEmail: owner.email } : {}),
  };
}
