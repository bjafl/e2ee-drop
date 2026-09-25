// apps/api/src/lib/accountDeletion.ts
import { prisma, Prisma } from "@e2ee-drop/db";
import { deleteObject } from "./storage";

// Deletes every Link owned by `userId` — and, via Prisma's onDelete: Cascade
// on Drop.linkId, each Link's Drop rows — along with the underlying MinIO
// object for each Drop. Does NOT delete the User row itself; that's the
// caller's responsibility (consumed as-is by this plan's Task 11 password
// reset without recovery code, and by Plan 4's full account deletion).
//
// Not atomic across links/drops: a crash or thrown error partway through
// leaves some links already deleted and others not yet touched. That's safe
// to retry, though, because every step is idempotent:
//   - deleteObject (MinIO) succeeds even when the key is already gone.
//   - the link delete below tolerates the row already being gone (P2025),
//     the same race-safety reasoning as deleteLinkIfExists in ./links —
//     someone else (a concurrent request, or an earlier partial run of this
//     same function) may have already deleted it.
// So re-calling cascadeDeleteUserLinks(userId) after a partial failure
// converges to the same end state rather than throwing on already-deleted
// data.
export async function cascadeDeleteUserLinks(userId: string): Promise<void> {
  const links = await prisma.link.findMany({ where: { ownerId: userId }, include: { drops: true } });

  for (const link of links) {
    for (const drop of link.drops) {
      await deleteObject(drop.s3Key);
    }
    try {
      await prisma.link.delete({ where: { id: link.id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        continue; // already gone — a concurrent delete or an earlier partial run got there first
      }
      throw error;
    }
  }
}
