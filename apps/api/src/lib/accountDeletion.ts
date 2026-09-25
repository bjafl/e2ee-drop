// apps/api/src/lib/accountDeletion.ts
import { prisma } from "@e2ee-drop/db";
import { deleteObject } from "./storage";
import { deleteLinkReleasingQuota } from "./quota";

// Deletes every Link owned by `userId` and each Link's Drop rows, along with
// the underlying MinIO object for each Drop, releasing the user's storage
// quota for every charged drop. Does NOT delete the User row itself; that's the
// caller's responsibility (consumed as-is by this plan's Task 11 password
// reset without recovery code, and by Plan 4's full account deletion).
//
// Not atomic across links/drops: a crash or thrown error partway through
// leaves some links already deleted and others not yet touched. That's safe
// to retry, though, because every step is idempotent:
//   - deleteObject (MinIO) succeeds even when the key is already gone.
//   - the link delete below tolerates the row already being gone (the
//     same race-safety reasoning as deleteLinkIfExists in ./links) —
//     someone else (a concurrent request, or an earlier partial run of this
//     same function) may have already deleted it — and releases quota only
//     for drop rows it actually deletes, so a retry never double-releases.
// So re-calling cascadeDeleteUserLinks(userId) after a partial failure
// converges to the same end state rather than throwing on already-deleted
// data.
export async function cascadeDeleteUserLinks(userId: string): Promise<void> {
  const links = await prisma.link.findMany({ where: { ownerId: userId }, include: { drops: true } });

  for (const link of links) {
    for (const drop of link.drops) {
      await deleteObject(drop.s3Key);
    }
    // Deletes the link's drop rows and the link, and releases the user's
    // storage quota for exactly the drops that had been charged (see
    // lib/quota.ts) — so on the password-reset path, where the User row
    // survives, storageUsedBytes ends back at 0 once every link is gone.
    // Tolerates the link already being gone, like the P2025 handling this
    // replaced.
    await deleteLinkReleasingQuota({ id: link.id, ownerId: userId });
  }
}
