// apps/api/src/lib/links.ts
import { customAlphabet } from "nanoid";
import { prisma, Prisma, type Link, type Drop } from "@e2ee-drop/db";
import type { FileUploadStatus, DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";
import { env } from "../env";
import { resolveLocale, deriveCodewords } from "./codewords";

// Also used by routes/links.ts's sender-initiated POST /api/links/request (Task 12), which
// needs the same anonymous-slug shape but isn't creating a one-time link.
export const generateAnonymousSlug = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 16);

export async function createOneTimeLink(
  recipientPublicKey: string,
  retentionDays: number,
  locale?: string,
  ownerNote?: string
): Promise<Link> {
  return prisma.link.create({
    data: {
      slug: generateAnonymousSlug(),
      mode: "one-time",
      recipientPublicKey,
      retentionDays,
      ownerNote,
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

// Distinguishes a claimed sender-initiated link (POST /api/links/request,
// followed by a winning POST /api/links/:slug/claim) from a normal owned
// link (the default link from registration, or POST /api/links/custom) —
// both have `ownerId !== null`, so that alone can't tell them apart.
//
// A normal owned link's recipientPublicKey is set to the owner's own
// publicKey at creation (createDefaultLinkForUser, POST /api/links/custom)
// and nothing in this codebase ever changes an owned link's
// recipientPublicKey once it is non-null. POST /api/links/request is the
// only route that creates an owned link with recipientPublicKey: null, and
// /claim is the only route that ever sets it afterward — via a CAS
// (`where: { recipientPublicKey: null }`) that only succeeds while it is
// still null. So: an owned link whose CURRENT recipientPublicKey differs
// from its owner's own actual publicKey can only be a sender-initiated link
// that has since been claimed by someone else. This costs one extra query
// (the owner's own publicKey) but needs no schema change and no new column.
async function isClaimedSenderInitiatedLink(link: Link): Promise<boolean> {
  if (link.ownerId === null || link.recipientPublicKey === null) return false;
  const owner = await prisma.user.findUnique({
    where: { id: link.ownerId },
    select: { publicKey: true },
  });
  if (!owner) return false; // owner row gone (cascade will take the link with it)
  return link.recipientPublicKey !== owner.publicKey;
}

// Authorizes the receive-side actions on a link: download-url,
// complete-download, download-failed, and reveal-message (routes/downloads.ts).
// Three link shapes:
//  - anonymous (ownerId === null): the slug alone is the capability (Plan 1)
//    — any holder of the slug may act, regardless of session.
//  - a normal owned link (default, or POST /api/links/custom): the owner IS
//    the intended recipient (their own publicKey is on the link from
//    creation), so only the true owner may act.
//  - a claimed sender-initiated link (POST /api/links/request + /claim): the
//    owner is the SENDER/initiator, not the recipient — the actual recipient
//    is whoever claimed it, identified structurally (an anonymous claimant
//    has no session to check). The slug is therefore the receive capability
//    here too, same trust model as an anonymous link — EXCEPT for the
//    initiator/owner themselves, who must be denied: they are the uploader,
//    and granting them these actions (complete-download's delete,
//    reveal-message's one-time read) would let the sender destroy or consume
//    content before the real recipient ever gets to it.
//
// Deliberately never used for quota/management operations (delete link, edit
// ownerNote, etc.) — those stay strictly gated on true ownership
// (request.user?.id === link.ownerId), unaffected by this helper.
export async function canReceive(link: Link, userId: string | null | undefined): Promise<boolean> {
  if (link.ownerId === null) return true;

  const isOwner = userId != null && userId === link.ownerId;
  const senderInitiatedClaim = await isClaimedSenderInitiatedLink(link);

  if (isOwner) return !senderInitiatedClaim;
  return senderInitiatedClaim;
}

// Narrower variant of the same structural check, used only by
// toLinkStatusResponse and mark-receiver-opened: those two routes must keep
// treating a NORMAL owned link exactly as before (never act/expose,
// regardless of caller identity — the owner uses GET .../drops or the queue
// view instead), and only additionally act for a claimed sender-initiated
// link's non-owner caller. canReceive's "true owner of a normal owned link"
// branch does not apply here — that link shape doesn't use this signal at
// this pair of routes.
export async function isSenderInitiatedReceiveCapability(
  link: Link,
  userId: string | null | undefined
): Promise<boolean> {
  const isOwner = userId != null && userId === link.ownerId;
  if (isOwner) return false;
  return isClaimedSenderInitiatedLink(link);
}

const DELIVERY_STATUS_RANK: Record<string, number> = {
  sender_opened: 0,
  sent: 1,
  receiver_opened: 2,
  partial_delivery: 3,
  delivered: 4,
};

// Re-derives Drop.deliveryStatus from both envelope statuses and writes it if — and only if — the
// derived value is strictly ahead of the row's CURRENT value at write time. Always re-reads the
// row itself rather than trusting a caller's snapshot: this is what makes it safe to call from two
// endpoints (reveal-message, complete-download) that can race each other on the same drop.
export async function recomputeDeliveryStatus(dropId: string, linkId: string): Promise<void> {
  const drop = await prisma.drop.findFirst({
    where: { id: dropId, linkId },
    select: {
      deliveryStatus: true,
      encryptedMessage: true,
      messageEnvelopeStatus: true,
      fileEnvelopeStatus: true,
    },
  });
  if (!drop) return;

  // `messageEnvelopeStatus` can also reach a terminal "shredded" state (spec 1's Task 6/7/8
  // cleanup scrub, once merged) when a message existed but was scrubbed WITHOUT ever being
  // delivered. Checking only `=== "delivered"` here would misclassify that case as "no message
  // ever existed", letting deliveryStatus reach "delivered" from file-delivery alone even though
  // the message was lost unretrieved — it must cap at "partial_delivery" instead (see the
  // messageDone check below). Checking `!== "sealed"` still correctly treats a genuinely
  // message-less drop (whose messageEnvelopeStatus stays at its schema default "sealed" forever)
  // as having no message, while treating both "delivered" and "shredded" as "a message existed
  // and is now resolved one way or the other".
  const hasMessage = drop.encryptedMessage !== null || drop.messageEnvelopeStatus !== "sealed";
  const messageDone = !hasMessage || drop.messageEnvelopeStatus === "delivered";
  const fileDone = drop.fileEnvelopeStatus === "delivered";

  let derived: string;
  if (messageDone && fileDone) derived = "delivered";
  else if (messageDone !== fileDone && (messageDone || fileDone)) derived = "partial_delivery";
  else derived = drop.deliveryStatus; // neither done yet — no change

  if (DELIVERY_STATUS_RANK[derived] <= DELIVERY_STATUS_RANK[drop.deliveryStatus]) return;

  // CAS on the current value read above: if a concurrent call already advanced the row further,
  // this simply matches zero rows instead of stomping a newer status with a stale derivation.
  await prisma.drop.updateMany({
    where: { id: dropId, linkId, deliveryStatus: drop.deliveryStatus },
    data: { deliveryStatus: derived },
  });
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
  link: Link & { drops: Drop[] },
  userId?: string | null
): Promise<LinkStatusResponse> {
  // This response is served unauthenticated (GET /api/links/:slug). For an
  // anonymous link that's fine: its random slug IS the capability, and Plan 1's
  // anonymous flow reads `drop` from here. An owned link's slug is public (the
  // default one is the owner's username), so exposing its drop here would hand
  // any stranger a queued drop's id, fileName, message and status — and the id
  // is what the /complete route acts on. A NORMAL owned link never reports a
  // drop here regardless of who's asking (even the true owner, if logged in) —
  // the owner reads their queue from the owner-gated GET /api/links/:slug/drops
  // and GET /api/links/:slug/events instead.
  //
  // A claimed sender-initiated link (POST /api/links/request + /claim) is the
  // one exception: the slug is the receive capability there (same trust model
  // as an anonymous link), so its drop IS exposed here — to the claimant, or
  // any other non-owner slug holder, but never to the initiator/owner
  // themselves (they use GET .../drops for their own, sender-side view, same
  // as any other owned link's owner).
  const activeDrop =
    link.ownerId === null || (await isSenderInitiatedReceiveCapability(link, userId))
      ? (link.drops[0] ?? null)
      : null;
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
