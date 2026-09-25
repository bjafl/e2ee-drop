// apps/api/src/lib/quota.ts
//
// Per-user storage quota accounting (spec §8). Only OWNED links are charged:
// an anonymous link (ownerId === null) has no User row to charge, and every
// helper here leaves anonymous links on their original, unaccounted code path.
//
// Invariant: User.storageUsedBytes == sum of chargedBytes(fileSize) over the
// user's drops whose status is anything but "uploading". A drop is charged
// exactly once, when /complete wins its "uploading" -> "uploaded" CAS, and
// released exactly once, when a charged drop's row is deleted. No status ever
// moves back to "uploading", so "status !== uploading" is exactly the set of
// charged drops.
//
// Lock ordering (to rule out deadlocks between these transactions):
//   User row  ->  Link row  ->  Drop row(s)
// - upload-url (owned):  locks User FOR UPDATE, then inserts a Drop (which
//   takes a KEY SHARE lock on its Link via the foreign key).
// - /complete (owned):   locks User FOR UPDATE, then CAS-updates the Drop.
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
export const UPLOAD_RESERVATION_WINDOW_MS = 60 * 60 * 1000;

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

export function isChargedStatus(status: string): boolean {
  return status !== "uploading";
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
async function reservedUploadBytes(tx: Prisma.TransactionClient, userId: string): Promise<bigint> {
  const { _sum, _count } = await tx.drop.aggregate({
    where: {
      status: "uploading",
      createdAt: { gt: new Date(Date.now() - UPLOAD_RESERVATION_WINDOW_MS) },
      link: { ownerId: userId },
    },
    _sum: { fileSize: true },
    _count: { _all: true },
  });
  return BigInt(_sum.fileSize ?? 0) + BigInt(_count._all) * BigInt(NACL_BOX_OVERHEAD_BYTES);
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
  const reserved = await reservedUploadBytes(tx, userId);
  if (owner.storageUsedBytes + reserved + chargedBytes(fileSize) > owner.storageQuotaBytes) {
    throw new QuotaExceededError();
  }
}

async function releaseCharged(
  tx: Prisma.TransactionClient,
  userId: string,
  deleted: { fileSize: number; status: string }[]
): Promise<void> {
  const released = deleted
    .filter((drop) => isChargedStatus(drop.status))
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
    const deleted = await tx.$queryRaw<{ fileSize: number; status: string }[]>`
      DELETE FROM "Drop" WHERE "linkId" = ${link.id} RETURNING "fileSize", "status"`;
    if (owner) await releaseCharged(tx, ownerId, deleted);
    await tx.link.deleteMany({ where: { id: link.id } });
  }, QUOTA_TX_OPTIONS);
}

// Single-drop counterpart of deleteLinkReleasingQuota (retention sweep on a
// permanent link). Returns whether a row was actually deleted.
export async function deleteDropReleasingQuota(dropId: string, ownerId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const owner = await lockOwnerQuota(tx, ownerId);
    const deleted = await tx.$queryRaw<{ fileSize: number; status: string }[]>`
      DELETE FROM "Drop" WHERE "id" = ${dropId} RETURNING "fileSize", "status"`;
    if (owner) await releaseCharged(tx, ownerId, deleted);
    return deleted.length > 0;
  }, QUOTA_TX_OPTIONS);
}
