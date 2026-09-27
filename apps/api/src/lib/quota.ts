// apps/api/src/lib/quota.ts
//
// Per-user storage quota accounting (spec §8). Only OWNED links are charged:
// an anonymous link (ownerId === null) has no User row to charge, and every
// helper here leaves anonymous links on their original, unaccounted code path.
//
// Invariant: User.storageUsedBytes == sum of chargedBytes(fileSize) over the
// user's drops whose fileUploadStatus is "complete" (see isChargedStatus) AND
// whose fileEnvelopeStatus is not terminal ("delivered"/"shredded").
// "reserved" and "uploading" drops are in-flight and not yet charged. A drop
// is charged exactly once, when /complete wins its "uploading" -> "complete"
// CAS, and released exactly once, by whichever of these happens first:
//   - a CAS moving its file envelope to a terminal state wins
//     (complete-download -> "delivered", scrubDropContent -> "shredded"), or
//   - its row is hard-deleted while its file envelope is still non-terminal
//     (deleteLinkReleasingQuota / deleteDropReleasingQuota).
// Neither fileUploadStatus "complete" nor a terminal fileEnvelopeStatus is
// ever left again, so each drop crosses the release boundary at most once.
//
// Lock ordering (to rule out deadlocks between these transactions):
//   User row  ->  Link row  ->  Drop row(s)
// - upload-url (owned):  locks User FOR UPDATE, then inserts a Drop (which
//   takes a KEY SHARE lock on its Link via the foreign key).
// - /complete (owned):   locks User FOR UPDATE, then CAS-updates the Drop
//   (status "uploading" AND createdAt inside the reservation window, as one
//   atomic UPDATE ... WHERE).
// - link deletion:       locks User, then Link FOR UPDATE, then deletes Drops.
// - single-drop sweep:   locks User, then deletes the Drop.
import { prisma, Prisma } from "@e2ee-drop/db";

// Clients encrypt the whole file with a single NaCl `box` (tweetnacl), whose
// ciphertext is always exactly plaintext length + this fixed Poly1305 tag
// overhead (nacl.box.overhead). The server therefore knows the exact byte
// count the upload must have from the declared plaintext `fileSize` alone.
export const NACL_BOX_OVERHEAD_BYTES = 16;

// How long an "uploading" drop counts against its owner's quota as an
// in-flight reservation. Covers the presigned upload URL's validity
// (getSignedUploadUrl's 600s default) plus a long transfer that started just
// before that URL expired. After this, an abandoned upload stops blocking the
// owner's quota; the drop row itself is later removed by the cleanup job.
//
// The window is also a hard deadline for /complete on an owned link: a drop
// created at or before reservationCutoff() is no longer counted by
// assertWithinQuota, so its capacity may already have been handed to another
// sender, and charging it late could overshoot the quota. Such a drop stays
// "uploading" (uncharged) forever and is left to the cleanup job. Both sides
// use reservationCutoff() so "still reserved" and "may still complete" can
// never disagree.
//
// Deliberately not shortened to limit reservation-flooding; see the
// per-sender share section below for why, and for the control used instead.
export const UPLOAD_RESERVATION_WINDOW_MS = 60 * 60 * 1000;

// Drops created strictly after this instant still hold a reservation.
export function reservationCutoff(): Date {
  return new Date(Date.now() - UPLOAD_RESERVATION_WINDOW_MS);
}

// Interactive transactions here can queue behind one another on the owner's
// row lock (that queueing is the point), so allow more than Prisma's 2s/5s
// defaults before giving up.
export const QUOTA_TX_OPTIONS = { maxWait: 15_000, timeout: 15_000 } as const;

export class QuotaExceededError extends Error {}

// Bytes a drop occupies in storage, and therefore what it is charged: the
// ciphertext, i.e. exactly the Content-Length signed into its upload URL.
// BigInt because User.storageQuotaBytes/storageUsedBytes are BigInt columns
// and BigInt cannot be mixed with `number` in arithmetic.
export function chargedBytes(fileSize: number): bigint {
  return BigInt(fileSize) + BigInt(NACL_BOX_OVERHEAD_BYTES);
}

export function isChargedStatus(fileUploadStatus: string): boolean {
  return fileUploadStatus === "complete";
}

// The two values fileEnvelopeStatus/messageEnvelopeStatus can permanently settle into.
// Shared here because releaseCharged (below) and scrubDropContent both need to test
// against the file envelope's own terminal-ness to decide whether a charge has already
// been released elsewhere.
const TERMINAL_ENVELOPE_STATUSES = ["delivered", "shredded"] as const;
function isTerminalEnvelope(status: string): boolean {
  return (TERMINAL_ENVELOPE_STATUSES as readonly string[]).includes(status);
}

type OwnerQuotaRow = { storageQuotaBytes: bigint; storageUsedBytes: bigint };

// Row-locks the owner (SELECT ... FOR UPDATE) for the rest of `tx`, so every
// quota-affecting transaction for one user is serialized. Must be the first
// lock a transaction takes (see lock ordering above). Returns null when the
// user no longer exists.
export async function lockOwnerQuota(tx: Prisma.TransactionClient, userId: string): Promise<OwnerQuotaRow | null> {
  const rows = await tx.$queryRaw<OwnerQuotaRow[]>`
    SELECT "storageQuotaBytes", "storageUsedBytes" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows[0] ?? null;
}

// Bytes held by this owner's recent, still-"uploading" drops. These are not
// in storageUsedBytes yet (they are charged on /complete), but must count
// against the quota at upload-url time, or N concurrent senders could each
// pass the check against the same free space and together overshoot it.
//
// With `senderKey`, only the reservations made by that sender network (see
// lib/senderKey.ts) are summed. `oldestCreatedAt` is the creation time of
// the oldest matching reservation (null when there are none).
async function reservedUploadBytes(
  tx: Prisma.TransactionClient,
  userId: string,
  senderKey?: string
): Promise<{ bytes: bigint; oldestCreatedAt: Date | null }> {
  const { _sum, _count, _min } = await tx.drop.aggregate({
    where: {
      fileUploadStatus: "uploading",
      createdAt: { gt: reservationCutoff() },
      link: { ownerId: userId },
      ...(senderKey === undefined ? {} : { reservationSenderKey: senderKey }),
    },
    _sum: { fileSize: true },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  return {
    bytes: BigInt(_sum.fileSize ?? 0) + BigInt(_count._all) * BigInt(NACL_BOX_OVERHEAD_BYTES),
    oldestCreatedAt: _min.createdAt,
  };
}

// Throws QuotaExceededError unless the owner can take `fileSize` more bytes.
// Quota exactly met is allowed (<=). Caller must already hold the owner lock
// (lockOwnerQuota) in the same transaction and pass the row it returned.
export async function assertWithinQuota(
  tx: Prisma.TransactionClient,
  userId: string,
  owner: OwnerQuotaRow,
  fileSize: number
): Promise<void> {
  const { bytes: reserved } = await reservedUploadBytes(tx, userId);
  if (owner.storageUsedBytes + reserved + chargedBytes(fileSize) > owner.storageQuotaBytes) {
    throw new QuotaExceededError();
  }
}

// ---------------------------------------------------------------------------
// Per-sender share of an owner's in-flight reservations.
//
// assertWithinQuota keeps the accounting correct (reserved + charged never
// exceeds the quota) but not fair: reservations cost the sender nothing but
// an upload-url call, so one sender could request ~11 max-size (500 MiB)
// uploads, never upload a byte, and hold an owner's entire default 5 GiB
// quota for the full reservation window, locking every other sender out of
// that inbox — and simply repeat it every hour. The per-IP rate limit on
// upload-url (lib/rateLimit.ts, 20/min) doesn't help: the attack needs far
// fewer requests than that.
//
// So, on top of the quota check, no single sender network may hold more than
// senderReservationCap(quota) bytes of one owner's IN-FLIGHT reservations.
// Completed uploads don't count: those bytes really were uploaded (the
// sender paid the bandwidth), and the owner can see and delete them.
//
// Why the reservation window itself was NOT shortened instead: presigned-URL
// expiry only gates when the PUT may START — verified against this project's
// MinIO (a PUT started before expiry and finishing well after it succeeds;
// one started after expiry gets 403 "Request has expired"), matching AWS's
// documented behaviour — so a legitimate 500 MiB upload on a slow uplink can
// genuinely take most of the hour, and a shorter window would 410 it at
// /complete after all its bytes were sent. A shorter window also doesn't
// stop the attack, only makes the attacker repeat it more often.
// ---------------------------------------------------------------------------

// One sender network may hold at most 1/SENDER_RESERVATION_SHARE_DIVISOR of
// an owner's quota in reservations (1.25 GiB of the default 5 GiB, i.e. two
// max-size files plus change), leaving at least 3/4 of the quota reachable by
// everyone else during an attack.
export const SENDER_RESERVATION_SHARE_DIVISOR = 4n;

// The cap never drops below one max-size file, so a single upload the
// server would otherwise accept is never refused by this rule alone (for
// small quotas the owner's total quota is then the binding limit).
export function senderReservationCap(quotaBytes: bigint, maxFileSizeBytes: number): bigint {
  const share = quotaBytes / SENDER_RESERVATION_SHARE_DIVISOR;
  const oneMaxFile = chargedBytes(maxFileSizeBytes);
  return share > oneMaxFile ? share : oneMaxFile;
}

export class SenderReservationLimitError extends Error {
  // Seconds until this sender's oldest reservation leaves the window (the
  // earliest moment the answer could change without anything completing).
  constructor(readonly retryAfterSeconds: number) {
    super("Sender reservation share exceeded");
  }
}

// Throws SenderReservationLimitError if `senderKey`'s current in-flight
// reservations against this owner plus this upload would exceed the cap.
//
// No locking of its own: like assertWithinQuota, the caller must already
// hold the owner lock (lockOwnerQuota) in the same transaction and insert
// the drop — with this same senderKey — in that transaction. Every
// upload-url for one owner is serialized on that lock, and the per-sender
// sum is read from committed Drop rows after acquiring it, so two concurrent
// requests from one sender can't both pass against the same headroom. The
// state lives in the Drop rows themselves (not a separate in-memory
// counter), so completion, deletion and window expiry all release a
// sender's share automatically, with nothing to keep in sync.
export async function assertWithinSenderShare(
  tx: Prisma.TransactionClient,
  userId: string,
  owner: OwnerQuotaRow,
  senderKey: string,
  fileSize: number,
  maxFileSizeBytes: number
): Promise<void> {
  const { bytes: held, oldestCreatedAt } = await reservedUploadBytes(tx, userId, senderKey);
  if (held + chargedBytes(fileSize) > senderReservationCap(owner.storageQuotaBytes, maxFileSizeBytes)) {
    const freesAt = (oldestCreatedAt?.getTime() ?? Date.now()) + UPLOAD_RESERVATION_WINDOW_MS;
    throw new SenderReservationLimitError(Math.max(1, Math.ceil((freesAt - Date.now()) / 1000)));
  }
}

// Releases the owner's quota for every drop in `deleted` that is still charged: its upload
// completed (isChargedStatus) AND its file envelope has not already reached a terminal state.
// A drop whose file side is already "delivered"/"shredded" had its charge released at the
// moment that terminal CAS won (complete-download, or scrubDropContent), so releasing it again
// here would double-count. Callers must pass each drop's fileEnvelopeStatus as it was
// immediately BEFORE the caller's own terminal transition (or at delete time, for a hard delete).
export async function releaseCharged(
  tx: Prisma.TransactionClient,
  userId: string,
  deleted: { fileSize: number; fileUploadStatus: string; fileEnvelopeStatus: string }[]
): Promise<void> {
  const released = deleted
    .filter((drop) => isChargedStatus(drop.fileUploadStatus) && !isTerminalEnvelope(drop.fileEnvelopeStatus))
    .reduce((sum, drop) => sum + chargedBytes(drop.fileSize), 0n);
  if (released > 0n) {
    await tx.user.update({ where: { id: userId }, data: { storageUsedBytes: { decrement: released } } });
  }
}

// Deletes a link's Drop rows and the Link row, releasing the owner's quota
// for exactly the drops that were charged. Storage objects are the caller's
// job (delete them first, as every existing call site does).
//
// The released amount comes from `DELETE ... RETURNING` — the rows as they
// are at delete time — not from a snapshot read earlier: a /complete racing
// this delete either commits first (its drop comes back "uploaded" and is
// released) or finds its row gone (its CAS matches nothing and it never
// charges). Idempotent: an already-deleted link releases nothing.
//
// Anonymous links take the original path (deleteLinkIfExists semantics),
// with no quota accounting at all.
export async function deleteLinkReleasingQuota(link: { id: string; ownerId: string | null }): Promise<void> {
  const ownerId = link.ownerId;
  if (ownerId === null) {
    await prisma.link.deleteMany({ where: { id: link.id } });
    return;
  }
  await prisma.$transaction(async (tx) => {
    const owner = await lockOwnerQuota(tx, ownerId);
    // Blocks new drop inserts on this link (their FK check needs a KEY SHARE
    // lock on this row) until the link is gone, so no drop can slip in
    // between the Drop delete and the Link delete below.
    await tx.$queryRaw`SELECT "id" FROM "Link" WHERE "id" = ${link.id} FOR UPDATE`;
    const deleted = await tx.$queryRaw<{ fileSize: number; fileUploadStatus: string; fileEnvelopeStatus: string }[]>`
      DELETE FROM "Drop" WHERE "linkId" = ${link.id} RETURNING "fileSize", "fileUploadStatus", "fileEnvelopeStatus"`;
    if (owner) await releaseCharged(tx, ownerId, deleted);
    await tx.link.deleteMany({ where: { id: link.id } });
  }, QUOTA_TX_OPTIONS);
}

// Single-drop counterpart of deleteLinkReleasingQuota (retention sweep on a
// permanent link). Returns whether a row was actually deleted.
export async function deleteDropReleasingQuota(dropId: string, ownerId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const owner = await lockOwnerQuota(tx, ownerId);
    const deleted = await tx.$queryRaw<{ fileSize: number; fileUploadStatus: string; fileEnvelopeStatus: string }[]>`
      DELETE FROM "Drop" WHERE "id" = ${dropId} RETURNING "fileSize", "fileUploadStatus", "fileEnvelopeStatus"`;
    if (owner) await releaseCharged(tx, ownerId, deleted);
    return deleted.length > 0;
  }, QUOTA_TX_OPTIONS);
}

// Scrubs one drop's content in place — the row survives as the audit trail (design spec §5).
// Unlike deleteDropReleasingQuota/deleteLinkReleasingQuota (which DELETE the row), this always
// UPDATEs it, so it works identically for anonymous and owned drops (only the quota-release step
// differs). The caller is responsible for actually deleting the returned s3Key from storage —
// this function only ever touches the database.
//
// Returns null when there was nothing left to scrub, or when every field this call would have
// resolved was already resolved by a concurrent caller (a pure no-op, not an error).
export async function scrubDropContent(
  dropId: string
): Promise<{ ownerId: string | null; s3Key: string } | null> {
  const drop = await prisma.drop.findUnique({
    where: { id: dropId },
    select: {
      s3Key: true,
      fileSize: true,
      fileUploadStatus: true,
      messageEnvelopeStatus: true,
      encryptedMessage: true,
      fileEnvelopeStatus: true,
      link: { select: { id: true, ownerId: true } },
    },
  });
  if (!drop) return null;

  // Same hasMessage disambiguation as recomputeDeliveryStatus (lib/links.ts) — a
  // message-less drop's messageEnvelopeStatus is stuck at its schema default "sealed"
  // forever, so it must never be mistaken for "has an unrevealed message". Without this,
  // a message-less, already-delivered drop would never be seen as fully resolved, and
  // every cleanup tick would re-stamp contentDeletedAt, defeating the audit-retention purge.
  const hasMessage = drop.encryptedMessage !== null || drop.messageEnvelopeStatus !== "sealed";
  const messageAlreadyTerminal = !hasMessage || isTerminalEnvelope(drop.messageEnvelopeStatus);
  const fileAlreadyTerminal = isTerminalEnvelope(drop.fileEnvelopeStatus);
  if (messageAlreadyTerminal && fileAlreadyTerminal) return null; // nothing left to scrub at all

  const ownerId = drop.link.ownerId;

  // Returns whether anything was actually resolved by THIS call (false means every
  // field this call might have touched was already resolved by a concurrent caller
  // between the snapshot read above and this transaction — a pure no-op, not an error).
  const scrub = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    // Lock the owner FIRST, before touching the Drop row at all — matches this
    // module's documented lock order (User -> Link -> Drop) and avoids a deadlock
    // against /complete's or complete-download's own owner-locked transactions,
    // which also lock the owner before their Drop CAS.
    const owner = ownerId ? await lockOwnerQuota(tx, ownerId) : null;

    // Two INDEPENDENT per-field CASes — not one combined WHERE. A race on either
    // field must never block the other field's legitimate resolution: e.g. if a
    // concurrent complete-download resolves the file side between our snapshot read
    // and here, this call must still be free to shred an unrevealed message (and
    // vice versa). Each CAS re-checks that field's LIVE value inside this locked
    // transaction — never the snapshot read above, which only decided whether to
    // bother opening this transaction at all. This is what makes it safe against a
    // concurrent reveal-message/complete-download CAS winning first: a field
    // already moved to a terminal value by the time this statement runs simply
    // matches zero rows, so it is never clobbered back to "shredded".
    let fileJustResolved = false;
    if (!fileAlreadyTerminal) {
      const { count } = await tx.drop.updateMany({
        where: { id: dropId, fileEnvelopeStatus: { notIn: [...TERMINAL_ENVELOPE_STATUSES] } },
        data: { fileEnvelopeStatus: "shredded", contentDeletedAt: new Date() },
      });
      fileJustResolved = count === 1;
    }

    let messageJustResolved = false;
    if (!messageAlreadyTerminal) {
      const { count } = await tx.drop.updateMany({
        where: { id: dropId, messageEnvelopeStatus: { notIn: [...TERMINAL_ENVELOPE_STATUSES] } },
        data: { encryptedMessage: null, messageNonce: null, messageEnvelopeStatus: "shredded" },
      });
      messageJustResolved = count === 1;
    }

    if (!fileJustResolved && !messageJustResolved) return false; // lost every race there was

    // contentDeletedAt marks "some content was scrubbed" — the file-side update above
    // already sets it when the file side resolves; also set it here when ONLY the
    // message side resolved this call, so the audit-retention clock still starts even
    // for a message-only scrub.
    if (messageJustResolved && !fileJustResolved) {
      await tx.drop.updateMany({ where: { id: dropId }, data: { contentDeletedAt: new Date() } });
    }

    // Quota is charged against the FILE's storage bytes (chargedBytes(fileSize) — see
    // this module's header comment), so it is released exactly when THIS call is the
    // one that resolved the file side for the first time — never for the message side
    // alone, and never twice: fileJustResolved can be true for at most one caller,
    // ever, across every path that can reach a terminal file envelope (the cleanup
    // sweeps and owner-cancel via this function, complete-download via its own CAS).
    // The snapshot's fileEnvelopeStatus is passed deliberately: fileJustResolved implies
    // it was non-terminal, which is exactly what releaseCharged needs to see.
    if (fileJustResolved && owner) {
      await releaseCharged(tx, ownerId!, [
        { fileSize: drop.fileSize, fileUploadStatus: drop.fileUploadStatus, fileEnvelopeStatus: drop.fileEnvelopeStatus },
      ]);
    }

    return true;
  };

  const resolved = ownerId
    ? await prisma.$transaction(scrub, QUOTA_TX_OPTIONS)
    : await scrub(prisma as unknown as Prisma.TransactionClient);

  return resolved ? { ownerId, s3Key: drop.s3Key } : null;
}
