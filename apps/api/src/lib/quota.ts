// apps/api/src/lib/quota.ts
//
// Per-user storage quota accounting (spec §8). Only OWNED links are charged:
// an anonymous link (ownerId === null) has no User row to charge, and every
// helper here leaves anonymous links on their original, unaccounted code path.
//
// Invariant: User.storageUsedBytes == sum of chargedBytes(fileSize) over the
// user's drops whose fileUploadStatus is "complete" (see isChargedStatus).
// "reserved" and "uploading" drops are in-flight and not yet charged. A drop
// is charged exactly once, when /complete wins its "uploading" -> "complete"
// CAS, and released exactly once, when a charged drop's row is deleted. No
// status ever moves back out of "complete", so isChargedStatus(status) is
// exactly the set of charged drops.
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

export async function releaseCharged(
  tx: Prisma.TransactionClient,
  userId: string,
  deleted: { fileSize: number; fileUploadStatus: string }[]
): Promise<void> {
  const released = deleted
    .filter((drop) => isChargedStatus(drop.fileUploadStatus))
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
    const deleted = await tx.$queryRaw<{ fileSize: number; fileUploadStatus: string }[]>`
      DELETE FROM "Drop" WHERE "linkId" = ${link.id} RETURNING "fileSize", "fileUploadStatus"`;
    if (owner) await releaseCharged(tx, ownerId, deleted);
    await tx.link.deleteMany({ where: { id: link.id } });
  }, QUOTA_TX_OPTIONS);
}

// Single-drop counterpart of deleteLinkReleasingQuota (retention sweep on a
// permanent link). Returns whether a row was actually deleted.
export async function deleteDropReleasingQuota(dropId: string, ownerId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const owner = await lockOwnerQuota(tx, ownerId);
    const deleted = await tx.$queryRaw<{ fileSize: number; fileUploadStatus: string }[]>`
      DELETE FROM "Drop" WHERE "id" = ${dropId} RETURNING "fileSize", "fileUploadStatus"`;
    if (owner) await releaseCharged(tx, ownerId, deleted);
    return deleted.length > 0;
  }, QUOTA_TX_OPTIONS);
}

// Scrubs one drop's content in place — the row survives as the audit trail (design spec §5).
// Unlike deleteDropReleasingQuota/deleteLinkReleasingQuota (which DELETE the row), this always
// UPDATEs it, so it works identically for anonymous and owned drops (only the quota-release step
// differs). The caller is responsible for actually deleting the returned s3Key from storage —
// this function only ever touches the database.
export async function scrubDropContent(
  dropId: string
): Promise<{ ownerId: string | null; s3Key: string } | null> {
  const drop = await prisma.drop.findUnique({
    where: { id: dropId },
    select: {
      s3Key: true,
      fileSize: true,
      fileUploadStatus: true,
      encryptedMessage: true,
      messageEnvelopeStatus: true,
      fileEnvelopeStatus: true,
      link: { select: { id: true, ownerId: true } },
    },
  });
  if (!drop) return null;

  // hasMessage disambiguates a message-less drop (messageEnvelopeStatus stuck at its schema
  // default "sealed" forever, since nothing ever writes to it when there was no message) from
  // one whose message is still sealed and unretrieved. Without this, a message-less drop whose
  // file was already fully delivered would never be seen as "both sides terminal": this function
  // would then needlessly stamp messageEnvelopeStatus: "shredded" on a drop that never had a
  // message, and worse, reset contentDeletedAt on every subsequent cleanup-sweep tick over an
  // already-fully-resolved row, permanently defeating Task 9's audit-retention purge (which ages
  // rows off of contentDeletedAt). Same disambiguation recomputeDeliveryStatus uses (lib/links.ts).
  const hasMessage = drop.encryptedMessage !== null || drop.messageEnvelopeStatus !== "sealed";
  const messageAlreadyTerminal =
    !hasMessage || drop.messageEnvelopeStatus === "delivered" || drop.messageEnvelopeStatus === "shredded";
  const fileAlreadyTerminal =
    drop.fileEnvelopeStatus === "delivered" || drop.fileEnvelopeStatus === "shredded";
  if (messageAlreadyTerminal && fileAlreadyTerminal) return null;

  const ownerId = drop.link.ownerId;
  const scrub = async (tx: Prisma.TransactionClient) => {
    await tx.drop.updateMany({
      where: { id: dropId },
      data: {
        encryptedMessage: null,
        messageNonce: null,
        contentDeletedAt: new Date(),
        ...(messageAlreadyTerminal ? {} : { messageEnvelopeStatus: "shredded" }),
        ...(fileAlreadyTerminal ? {} : { fileEnvelopeStatus: "shredded" }),
      },
    });
    if (ownerId) {
      const owner = await lockOwnerQuota(tx, ownerId);
      if (owner) await releaseCharged(tx, ownerId, [{ fileSize: drop.fileSize, fileUploadStatus: drop.fileUploadStatus }]);
    }
  };

  if (ownerId) {
    await prisma.$transaction(scrub, QUOTA_TX_OPTIONS);
  } else {
    await scrub(prisma as unknown as Prisma.TransactionClient);
  }
  return { ownerId, s3Key: drop.s3Key };
}
