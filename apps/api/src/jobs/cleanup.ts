// apps/api/src/jobs/cleanup.ts
import { prisma } from "@e2ee-drop/db";
import { deleteObject } from "../lib/storage";
import { deleteLinkIfExists } from "../lib/links";
import { deleteDropReleasingQuota, deleteLinkReleasingQuota, reservationCutoff } from "../lib/quota";

export async function runCleanup(): Promise<{ deletedLinks: number }> {
  const now = new Date();
  const expiredLinks = await prisma.link.findMany({
    where: { mode: "one-time", expiresAt: { lt: now } },
    include: { drops: true },
  });

  for (const link of expiredLinks) {
    for (const drop of link.drops) {
      await deleteObject(drop.s3Key);
    }
    if (link.ownerId === null) {
      await deleteLinkIfExists(link.id);
    } else {
      // An owned one-time link (POST /api/links/custom, mode "one-time"):
      // release the owner's quota for its drop if that drop had been charged.
      await deleteLinkReleasingQuota(link);
    }
  }

  return { deletedLinks: expiredLinks.length };
}

export async function sweepExpiredDrops(): Promise<{ deletedDrops: number }> {
  const now = Date.now();
  const drops = await prisma.drop.findMany({
    where: { link: { mode: "permanent" } },
    include: { link: true },
  });

  let deletedDrops = 0;
  for (const drop of drops) {
    const retentionDays = drop.link.retentionDays;
    const cutoff = drop.createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000;
    if (cutoff < now) {
      await deleteObject(drop.s3Key);
      if (drop.link.ownerId === null) {
        await prisma.drop.delete({ where: { id: drop.id } });
      } else {
        // Releases the owner's quota iff the row still exists and had been
        // charged (i.e. isn't an abandoned "uploading" drop) at delete time.
        await deleteDropReleasingQuota(drop.id, drop.link.ownerId);
      }
      deletedDrops++;
    }
  }

  return { deletedDrops };
}

// No equivalent existed before this plan: sweepExpiredDrops only ever covered
// mode: "permanent" links on their retentionDays timer, and runCleanup only covers a whole
// one-time link once IT expires (up to LINK_EXPIRY_HOURS later). Neither one catches a drop stuck
// in fileUploadStatus "uploading" — e.g. a crashed tab that never got to call /abandon — on a
// still-otherwise-valid link. Since an "uploading" drop is never charged against quota
// (isChargedStatus in lib/quota.ts), deleting it outright needs no quota release, unlike the other
// two sweeps.
export async function sweepAbandonedUploads(): Promise<{ deletedDrops: number }> {
  const { count } = await prisma.drop.deleteMany({
    where: { fileUploadStatus: "uploading", createdAt: { lt: reservationCutoff() } },
  });
  return { deletedDrops: count };
}

// Password-reset tokens are single-use and short-lived, but an unused one
// is never deleted by the reset flow itself, so expired rows are pruned here.
export async function pruneExpiredPasswordResetTokens(): Promise<{ deletedTokens: number }> {
  const result = await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return { deletedTokens: result.count };
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
      console.log(
        `[cleanup] removed ${linkResult.deletedLinks} expired link(s), ${dropResult.deletedDrops} expired drop(s), ` +
          `${abandonedResult.deletedDrops} abandoned upload(s), ${tokenResult.deletedTokens} expired password-reset token(s)`
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
