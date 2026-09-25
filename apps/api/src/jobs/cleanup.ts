// apps/api/src/jobs/cleanup.ts
import { prisma } from "@e2ee-drop/db";
import { deleteObject } from "../lib/storage";
import { deleteLinkIfExists } from "../lib/links";
import { env } from "../env";

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
    await deleteLinkIfExists(link.id);
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
    const retentionDays = drop.link.retentionDays ?? env.DROP_RETENTION_DAYS;
    const cutoff = drop.createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000;
    if (cutoff < now) {
      await deleteObject(drop.s3Key);
      await prisma.drop.delete({ where: { id: drop.id } });
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

async function main() {
  const INTERVAL_MS = 15 * 60 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const linkResult = await runCleanup();
      const dropResult = await sweepExpiredDrops();
      const tokenResult = await pruneExpiredPasswordResetTokens();
      console.log(
        `[cleanup] removed ${linkResult.deletedLinks} expired link(s), ${dropResult.deletedDrops} expired drop(s), ` +
          `${tokenResult.deletedTokens} expired password-reset token(s)`
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
