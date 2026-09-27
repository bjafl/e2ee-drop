// apps/api/src/lib/inbox.ts
import { prisma, type Drop } from "@e2ee-drop/db";
import type { InboxCounterparty, InboxDrop, InboxResponse } from "@e2ee-drop/shared";

// A drop's message envelope only counts toward "unresolved" if it ever had a
// message at all. Drop.messageEnvelopeStatus defaults to "sealed" even for a
// drop with no message (spec 1's schema has no separate "not applicable"
// state), so this can't be read off that field directly. Reconstructed
// instead from the two fields whose combination is unambiguous: a message
// exists (still sealed) iff encryptedMessage is set; a message existed and
// was already revealed iff messageRevealedAt is set. Neither implies the
// other never held a message — this is the one derivation covering both.
function hadMessage(drop: Pick<Drop, "encryptedMessage" | "messageRevealedAt">): boolean {
  return drop.encryptedMessage !== null || drop.messageRevealedAt !== null;
}

function isEnvelopeResolved(status: string): boolean {
  return status === "delivered" || status === "shredded";
}

function isDropResolved(drop: Drop): boolean {
  const fileResolved = isEnvelopeResolved(drop.fileEnvelopeStatus);
  const messageResolved = !hadMessage(drop) || isEnvelopeResolved(drop.messageEnvelopeStatus);
  return fileResolved && messageResolved;
}

function toInboxDrop(drop: Drop, linkSlug: string): InboxDrop {
  return {
    id: drop.id,
    linkSlug,
    deliveryStatus: drop.deliveryStatus as InboxDrop["deliveryStatus"],
    messageEnvelopeStatus: drop.messageEnvelopeStatus as InboxDrop["messageEnvelopeStatus"],
    fileEnvelopeStatus: drop.fileEnvelopeStatus as InboxDrop["fileEnvelopeStatus"],
    hasMessage: hadMessage(drop),
    createdAt: drop.createdAt.getTime(),
  };
}

export async function getInboxForUser(userId: string): Promise<InboxResponse> {
  // Two independent queries rather than one UNION-shaped one: "incoming" (I
  // own the link) and "outgoing" (I sent it, regardless of who owns the
  // link) are genuinely different joins, and keeping them separate makes it
  // impossible to accidentally leak a WHERE clause meant for one branch into
  // the other (this plan's Review Focus).
  //
  // Note: a self-send (userId owns the link AND is drop.senderUserId on it)
  // IS reachable in practice — a sender-initiated request-link
  // (POST /api/links/request, see lib/links.ts's isClaimedSenderInitiatedLink)
  // has ownerId set to the request's INITIATOR, who later uploads to their
  // own link as its sender. Left unhandled here would show the caller their
  // own username as an "incoming" sender to themselves in the incoming
  // branch below; that's filtered out there. The outgoing branch still
  // surfaces the same Drop row (self as an "outgoing" counterparty to
  // themselves) — that half is out of scope for this fix.
  const [incomingLinks, blockedByMe, outgoingDrops] = await Promise.all([
    prisma.link.findMany({ where: { ownerId: userId }, include: { drops: true } }),
    prisma.contact.findMany({ where: { blockedByUserId: userId, status: "blocked" } }),
    prisma.drop.findMany({ where: { senderUserId: userId }, include: { link: true } }),
  ]);
  const blockedUserIds = new Set(blockedByMe.map((c) => (c.userId === userId ? c.contactUserId : c.userId)));

  const senderIds = new Set<string>();
  for (const link of incomingLinks) {
    for (const drop of link.drops) {
      if (drop.senderUserId) senderIds.add(drop.senderUserId);
    }
  }
  const senders = senderIds.size
    ? await prisma.user.findMany({ where: { id: { in: [...senderIds] } } })
    : [];
  const usernameById = new Map(senders.map((s) => [s.id, s.username]));

  const incomingByCounterparty = new Map<string, InboxCounterparty>();
  // Anonymous bucket numbering is first-seen order within THIS response —
  // recomputed fresh every call, never persisted, so it only needs to be
  // stable within one fetch, not across them.
  let nextAnonNumber = 1;
  const anonNumberByKey = new Map<string, number>();

  // Flatten every drop from every incoming link into one sequence BEFORE
  // sorting: `incomingLinks` itself carries no ordering guarantee across
  // links (no `orderBy` on the links query, and Prisma/Postgres promise
  // nothing about array order), so sorting per-link and then iterating links
  // in whatever order the DB returned them would make Anonym1/Anonym2
  // numbering depend on link return order instead of true first-seen order
  // across the owner's whole inbox (design spec §6). Sorting once over the
  // flattened set fixes that.
  const incomingDropsFlat = incomingLinks.flatMap((link) => link.drops.map((drop) => ({ drop, linkSlug: link.slug })));
  incomingDropsFlat.sort((a, b) => a.drop.createdAt.getTime() - b.drop.createdAt.getTime());

  for (const { drop, linkSlug } of incomingDropsFlat) {
    if (isDropResolved(drop)) continue;
    if (drop.senderUserId && blockedUserIds.has(drop.senderUserId)) continue;
    // A self-send (see the comment above the incoming/outgoing query split):
    // the caller must never appear as their own "incoming" counterparty.
    if (drop.senderUserId === userId) continue;

    const isKnown = drop.senderUserId !== null;
    const bucketKey = isKnown ? `incoming:account:${drop.senderUserId}` : `incoming:anon:${drop.senderPublicKey}`;

    let counterparty = incomingByCounterparty.get(bucketKey);
    if (!counterparty) {
      let displayName: string;
      if (isKnown) {
        displayName = usernameById.get(drop.senderUserId!) ?? "unknown";
      } else {
        if (!anonNumberByKey.has(bucketKey)) anonNumberByKey.set(bucketKey, nextAnonNumber++);
        displayName = `Anonym${anonNumberByKey.get(bucketKey)}`;
      }
      counterparty = {
        key: bucketKey,
        kind: isKnown ? "account" : "anonymous",
        displayName,
        direction: "incoming",
        drops: [],
      };
      incomingByCounterparty.set(bucketKey, counterparty);
    }
    counterparty.drops.push(toInboxDrop(drop, linkSlug));
  }

  const outgoingByCounterparty = new Map<string, InboxCounterparty>();
  const ownerIds = new Set(outgoingDrops.map((d) => d.link.ownerId).filter((id): id is string => id !== null));
  const owners = ownerIds.size ? await prisma.user.findMany({ where: { id: { in: [...ownerIds] } } }) : [];
  const usernameByOwnerId = new Map(owners.map((o) => [o.id, o.username]));

  for (const drop of outgoingDrops) {
    if (isDropResolved(drop)) continue;
    if (!drop.link.ownerId) continue; // defensive: skip if the other end's link is somehow unowned
    const bucketKey = `outgoing:account:${drop.link.ownerId}`;
    let counterparty = outgoingByCounterparty.get(bucketKey);
    if (!counterparty) {
      counterparty = {
        key: bucketKey,
        kind: "account",
        displayName: usernameByOwnerId.get(drop.link.ownerId) ?? "unknown",
        direction: "outgoing",
        drops: [],
      };
      outgoingByCounterparty.set(bucketKey, counterparty);
    }
    counterparty.drops.push(toInboxDrop(drop, drop.link.slug));
  }

  return {
    counterparties: [...incomingByCounterparty.values(), ...outgoingByCounterparty.values()],
  };
}
