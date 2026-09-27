// apps/api/src/jobs/cleanup.ts
import { prisma } from "@e2ee-drop/db";
import { env } from "../env";
import { deleteObject } from "../lib/storage";
import { reservationCutoff, scrubDropContent } from "../lib/quota";

// Scrubs (never hard-deletes) an expired one-time link's drop content, so the row survives as
// the audit trail (design spec §5) instead of the link/drop rows being deleted outright. Identical
// for anonymous and owned links — scrubDropContent itself handles the owner quota release.
//
// Only drops whose upload actually completed (fileUploadStatus === "complete") are scrubbed here.
// scrubDropContent never touches fileUploadStatus, and sweepAbandonedUploads (below, run in the
// same cron tick by main()) hard-deletes any drop still at fileUploadStatus "uploading" past
// reservationCutoff() by matching on that same field — so a still-uploading/reserved drop on an
// expired one-time link is left for that sweep to handle, rather than being scrubbed here first
// (which would leave it looking "shredded" for one tick before sweepAbandonedUploads then deletes
// the row anyway, destroying the very audit trail this function exists to preserve).
export async function runCleanup(): Promise<{ scrubbedLinks: number }> {
  const now = new Date();

  // Expired one-time links that were never used at all (no upload ever started, or
  // their sole drop was already reaped by sweepAbandonedUploads) have nothing to
  // scrub and nothing worth keeping as an audit trail — delete them outright, the
  // same way this function always did before content-scrubbing existed. Without
  // this, an unused anonymous one-time link (creation is unauthenticated) would live
  // forever once expired.
  await prisma.link.deleteMany({
    where: { mode: "one-time", expiresAt: { lt: now }, drops: { none: {} } },
  });

  const expiredLinks = await prisma.link.findMany({
    where: { mode: "one-time", expiresAt: { lt: now } },
    include: { drops: true },
  });

  let scrubbedLinks = 0;
  for (const link of expiredLinks) {
    let scrubbedAny = false;
    for (const drop of link.drops) {
      if (drop.fileUploadStatus !== "complete") continue;
      const result = await scrubDropContent(drop.id);
      if (result) {
        await deleteObject(result.s3Key);
        scrubbedAny = true;
      }
    }
    if (scrubbedAny) scrubbedLinks++;
  }

  return { scrubbedLinks };
}

// Scrubs (never hard-deletes) a permanent link's retention-expired drop content, mirroring
// runCleanup above — the row survives as the audit trail instead of being deleted outright.
//
// Same fileUploadStatus === "complete" guard as runCleanup, and for the same reason: this cron
// tick also runs sweepAbandonedUploads (below), which hard-deletes any drop still at
// fileUploadStatus "uploading" past reservationCutoff(). scrubDropContent never touches
// fileUploadStatus, so without this guard an old-enough still-uploading drop on a permanent link
// could get scrubbed here and then still get hard-deleted by sweepAbandonedUploads, destroying
// the audit-trail row. Leaving it at "uploading" here defers it entirely to that other sweep.
export async function sweepExpiredDrops(): Promise<{ scrubbedDrops: number }> {
  const now = Date.now();
  const drops = await prisma.drop.findMany({
    where: { link: { mode: "permanent" } },
    include: { link: true },
  });

  let scrubbedDrops = 0;
  for (const drop of drops) {
    if (drop.fileUploadStatus !== "complete") continue;
    const cutoff = drop.createdAt.getTime() + drop.link.retentionDays * 24 * 60 * 60 * 1000;
    if (cutoff < now) {
      const result = await scrubDropContent(drop.id);
      if (result) {
        await deleteObject(result.s3Key);
        scrubbedDrops++;
      }
    }
  }

  return { scrubbedDrops };
}

// No equivalent existed before this plan: sweepExpiredDrops only ever covered
// mode: "permanent" links on their retentionDays timer, and runCleanup only covers a whole
// one-time link once IT expires (up to LINK_EXPIRY_HOURS later). Neither one catches a drop stuck
// in fileUploadStatus "uploading" — e.g. a crashed tab that never got to call /abandon — on a
// still-otherwise-valid link. Since an "uploading" drop is never charged against quota
// (isChargedStatus in lib/quota.ts), deleting it outright needs no quota release, unlike the other
// two sweeps.
//
// Finding I2: a stale "uploading" row can still name a real object in storage
// (the PUT landed, but /complete was never called) — deleting the row without
// deleting its s3Key first would orphan that object forever, since the row
// was the only record of the key.
//
// findMany, then a per-row CAS delete followed by deleteObject only if that
// delete actually won (count === 1) — never the reverse order. An anonymous
// link's /complete has no reservationCutoff guard (only an owned link's CAS
// checks it — lib/quota.ts), so a drop that was stale-and-uploading at the
// findMany above can still legitimately complete before this loop reaches it;
// calling deleteObject unconditionally would then destroy the real, just-
// verified object out from under that successful /complete. The per-row CAS
// delete is what actually resolves that race (Postgres evaluates its WHERE
// against the row's live state), and deleteObject only ever runs for a row
// this call itself just deleted — mirrors the same reordering in the
// /abandon route (uploads.ts).
export async function sweepAbandonedUploads(): Promise<{ deletedDrops: number }> {
  const stale = await prisma.drop.findMany({
    where: { fileUploadStatus: "uploading", createdAt: { lt: reservationCutoff() } },
    select: { id: true, s3Key: true },
  });

  let deletedDrops = 0;
  for (const drop of stale) {
    const { count } = await prisma.drop.deleteMany({
      where: { id: drop.id, fileUploadStatus: "uploading" },
    });
    if (count === 1) {
      await deleteObject(drop.s3Key);
      deletedDrops++;
    }
  }

  return { deletedDrops };
}

// Password-reset tokens are single-use and short-lived, but an unused one
// is never deleted by the reset flow itself, so expired rows are pruned here.
export async function pruneExpiredPasswordResetTokens(): Promise<{ deletedTokens: number }> {
  const result = await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return { deletedTokens: result.count };
}

// The other sweeps above only ever scrub a Drop's content (row survives as the audit trail —
// design spec §5). This is the sweep that finally hard-deletes that audit-trail row, once it's
// been sitting scrubbed for longer than AUDIT_RETENTION_DAYS past contentDeletedAt.
//
// A one-time link's sole reason to keep existing after its drop is scrubbed is to let that drop
// row serve as the audit trail; once the drop itself is purged there's nothing left worth keeping
// the Link row for either, so it cascades. A permanent link's Link row is never purged here — only
// its expired-and-scrubbed drops are — since the link itself stays valid for new drops.
export async function purgeAuditExpiredRows(): Promise<{ purgedDrops: number; purgedLinks: number }> {
  const cutoff = new Date(Date.now() - env.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.drop.findMany({
    where: { contentDeletedAt: { lt: cutoff } },
    include: { link: true },
  });

  let purgedDrops = 0;
  let purgedLinks = 0;
  for (const drop of expired) {
    // Tolerant of a concurrent removal of this exact row (e.g. a concurrent DELETE
    // /api/links/:slug on this drop's link, whose onDelete: Cascade would take this
    // row with it) — deleteMany simply matches zero rows instead of throwing P2025,
    // consistent with the Link deleteMany just below.
    const { count } = await prisma.drop.deleteMany({ where: { id: drop.id } });
    if (count !== 1) continue; // already gone via a concurrent path — nothing more to do for this row
    purgedDrops++;
    if (drop.link.mode === "one-time") {
      // Deleting a one-time link's sole drop leaves nothing worth keeping the Link row for.
      // deleteMany (not delete) tolerates a link already removed by a concurrent purge/DELETE call.
      const { count: linkCount } = await prisma.link.deleteMany({ where: { id: drop.link.id } });
      purgedLinks += linkCount;
    }
  }

  return { purgedDrops, purgedLinks };
}

async function main() {
  const INTERVAL_MS = 15 * 60 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const linkResult = await runCleanup();
      const dropResult = await sweepExpiredDrops();
      const abandonedResult = await sweepAbandonedUploads();
      const tokenResult = await pruneExpiredPasswordResetTokens();
      const purgeResult = await purgeAuditExpiredRows();
      console.log(
        `[cleanup] scrubbed ${linkResult.scrubbedLinks} expired link(s), ${dropResult.scrubbedDrops} expired drop(s), ` +
          `${abandonedResult.deletedDrops} abandoned upload(s), ${tokenResult.deletedTokens} expired password-reset token(s), ` +
          `purged ${purgeResult.purgedDrops} drop(s) and ${purgeResult.purgedLinks} link(s) past audit retention`
      );
    } catch (error) {
      console.error("[cleanup] sweep failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
