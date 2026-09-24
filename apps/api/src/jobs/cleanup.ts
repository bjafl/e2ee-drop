// apps/api/src/jobs/cleanup.ts
import { prisma } from "@e2ee-drop/db";
import { deleteObject } from "../lib/storage";

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
    await prisma.link.delete({ where: { id: link.id } });
  }

  return { deletedLinks: expiredLinks.length };
}

async function main() {
  const INTERVAL_MS = 15 * 60 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await runCleanup();
      console.log(`[cleanup] removed ${result.deletedLinks} expired link(s)`);
    } catch (error) {
      console.error("[cleanup] sweep failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
