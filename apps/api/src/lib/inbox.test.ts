// apps/api/src/lib/inbox.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { getInboxForUser } from "./inbox";

async function makeUser(username: string, overrides: Partial<{ }> = {}) {
  return prisma.user.create({
    data: {
      email: `${username}@example.com`,
      username,
      name: username,
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: `${username}-pubkey`,
      storageQuotaBytes: 1000,
    },
  });
}

async function makeDrop(overrides: {
  linkId: string;
  senderPublicKey: string;
  senderUserId?: string | null;
  deliveryStatus?: string;
  fileEnvelopeStatus?: string;
  messageEnvelopeStatus?: string;
  encryptedMessage?: string | null;
  messageRevealedAt?: Date | null;
  createdAt?: Date;
}) {
  return prisma.drop.create({
    data: {
      linkId: overrides.linkId,
      senderPublicKey: overrides.senderPublicKey,
      senderUserId: overrides.senderUserId ?? null,
      s3Key: "k",
      archiveNonce: "n",
      contentMD5: "m",
      encryptedMetadata: "e",
      metadataNonce: "n",
      fileSize: 1,
      fileUploadStatus: "complete",
      deliveryStatus: overrides.deliveryStatus ?? "sent",
      fileEnvelopeStatus: overrides.fileEnvelopeStatus ?? "sealed",
      messageEnvelopeStatus: overrides.messageEnvelopeStatus ?? "sealed",
      encryptedMessage: overrides.encryptedMessage ?? null,
      messageRevealedAt: overrides.messageRevealedAt ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

describe("getInboxForUser", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.user.deleteMany();
  });

  it("groups a known sender's drops by senderUserId under their username, as incoming", async () => {
    const owner = await makeUser("inbox-owner-1");
    const sender = await makeUser("inbox-sender-1");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-1", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: link.id, senderPublicKey: "s1", senderUserId: sender.id });

    const inbox = await getInboxForUser(owner.id);

    expect(inbox.counterparties).toHaveLength(1);
    expect(inbox.counterparties[0]).toMatchObject({
      kind: "account",
      displayName: "inbox-sender-1",
      direction: "incoming",
    });
  });

  it("buckets anonymous drops by senderPublicKey, numbering separate keys Anonym1/Anonym2 in first-seen order", async () => {
    const owner = await makeUser("inbox-owner-2");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-2", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: link.id, senderPublicKey: "key-b" });
    await makeDrop({ linkId: link.id, senderPublicKey: "key-a" });
    await makeDrop({ linkId: link.id, senderPublicKey: "key-b" }); // same key again — must not create a third bucket

    const inbox = await getInboxForUser(owner.id);
    const anon = inbox.counterparties.filter((c) => c.kind === "anonymous");

    expect(anon).toHaveLength(2);
    expect(anon.find((c) => c.displayName === "Anonym1")!.drops).toHaveLength(2); // key-b, first-seen
    expect(anon.find((c) => c.displayName === "Anonym2")!.drops).toHaveLength(1); // key-a
  });

  it("includes outgoing drops on links the user does not own, attributed by senderUserId", async () => {
    const owner = await makeUser("inbox-owner-3");
    const sender = await makeUser("inbox-sender-3");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-3", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: link.id, senderPublicKey: "s3", senderUserId: sender.id });

    const inbox = await getInboxForUser(sender.id);

    expect(inbox.counterparties).toHaveLength(1);
    expect(inbox.counterparties[0]).toMatchObject({ displayName: "inbox-owner-3", direction: "outgoing" });
  });

  it("never attributes an anonymous drop to an account, even for the account that happened to send it", async () => {
    const owner = await makeUser("inbox-owner-4");
    const sender = await makeUser("inbox-sender-4");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-4", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: link.id, senderPublicKey: "s4" }); // senderUserId left null on purpose

    const senderInbox = await getInboxForUser(sender.id);
    expect(senderInbox.counterparties).toHaveLength(0);
  });

  it("excludes a drop from a sender the recipient has blocked", async () => {
    const owner = await makeUser("inbox-owner-5");
    const blocked = await makeUser("inbox-blocked-5");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-5", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: link.id, senderPublicKey: "s5", senderUserId: blocked.id });
    await prisma.contact.create({
      data: { userId: owner.id, contactUserId: blocked.id, status: "blocked", blockedByUserId: owner.id },
    });

    const inbox = await getInboxForUser(owner.id);
    expect(inbox.counterparties).toHaveLength(0);
  });

  it("drops a counterparty once every drop is resolved (delivered or shredded on both envelopes)", async () => {
    const owner = await makeUser("inbox-owner-6");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-6", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({
      linkId: link.id,
      senderPublicKey: "s6",
      deliveryStatus: "delivered",
      fileEnvelopeStatus: "delivered",
      messageEnvelopeStatus: "sealed", // never had a message — must not count as unresolved
      encryptedMessage: null,
      messageRevealedAt: null,
    });

    const inbox = await getInboxForUser(owner.id);
    expect(inbox.counterparties).toHaveLength(0);
  });

  it("keeps a counterparty visible while the file envelope is still sealed, even if there was never a message", async () => {
    const owner = await makeUser("inbox-owner-7");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-7", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: link.id, senderPublicKey: "s7", fileEnvelopeStatus: "sealed" });

    const inbox = await getInboxForUser(owner.id);
    expect(inbox.counterparties).toHaveLength(1);
  });

  it("keeps a counterparty visible when the file is delivered but a real message is still sealed", async () => {
    const owner = await makeUser("inbox-owner-8");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-8", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({
      linkId: link.id,
      senderPublicKey: "s8",
      fileEnvelopeStatus: "delivered",
      messageEnvelopeStatus: "sealed",
      encryptedMessage: "ciphertext-still-present",
    });

    const inbox = await getInboxForUser(owner.id);
    expect(inbox.counterparties).toHaveLength(1);
  });

  it("counts a drop whose message was already revealed as message-resolved (messageRevealedAt set, encryptedMessage null)", async () => {
    const owner = await makeUser("inbox-owner-9");
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-9", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({
      linkId: link.id,
      senderPublicKey: "s9",
      fileEnvelopeStatus: "delivered",
      messageEnvelopeStatus: "delivered",
      encryptedMessage: null,
      messageRevealedAt: new Date(),
    });

    const inbox = await getInboxForUser(owner.id);
    expect(inbox.counterparties).toHaveLength(0);
  });

  it("gives incoming and outgoing counterparties for the same person structurally different keys", async () => {
    const owner = await makeUser("inbox-owner-11");
    const other = await makeUser("inbox-other-11");
    // owner's own link: `other` sends owner a drop -> incoming counterparty for owner.
    const ownerLink = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-11", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: ownerLink.id, senderPublicKey: "s11a", senderUserId: other.id });
    // other's own link: owner sends other a drop -> outgoing counterparty for owner.
    const otherLink = await prisma.link.create({
      data: { ownerId: other.id, slug: "inbox-other-11", mode: "permanent", recipientPublicKey: other.publicKey, retentionDays: 7 },
    });
    await makeDrop({ linkId: otherLink.id, senderPublicKey: "s11b", senderUserId: owner.id });

    const inbox = await getInboxForUser(owner.id);

    expect(inbox.counterparties).toHaveLength(2);
    const incoming = inbox.counterparties.find((c) => c.direction === "incoming")!;
    const outgoing = inbox.counterparties.find((c) => c.direction === "outgoing")!;
    expect(incoming).toBeDefined();
    expect(outgoing).toBeDefined();
    expect(incoming.key).not.toBe(outgoing.key);
    // Both describe the same counterparty ("inbox-other-11") so they'd share a display name too.
    expect(incoming.displayName).toBe("inbox-other-11");
    expect(outgoing.displayName).toBe("inbox-other-11");
  });

  it("never shows the caller their own username as an incoming sender to themselves (sender-initiated request-link shape)", async () => {
    const owner = await makeUser("inbox-owner-12");
    // Simulate the claimed sender-initiated request-link shape directly (per lib/links.ts's
    // isClaimedSenderInitiatedLink): an owned link whose ownerId is the request's initiator,
    // who later uploads a drop to their own link (senderUserId === ownerId).
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-12", mode: "permanent", recipientPublicKey: "claimant-pubkey", retentionDays: 7 },
    });
    await makeDrop({ linkId: link.id, senderPublicKey: owner.publicKey, senderUserId: owner.id });

    const inbox = await getInboxForUser(owner.id);
    const incoming = inbox.counterparties.filter((c) => c.direction === "incoming");

    expect(incoming).toHaveLength(0);
  });

  it("numbers anonymous buckets by first-seen order across ALL of the owner's links, not per-link", async () => {
    const owner = await makeUser("inbox-owner-10");
    // Link A is created first, so an unordered `findMany` is likely (though
    // not guaranteed) to return it before link B — the bug this test guards
    // against numbered buckets by link iteration order instead of true
    // first-seen (createdAt) order across the owner's whole inbox.
    const linkA = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-10-a", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    const linkB = await prisma.link.create({
      data: { ownerId: owner.id, slug: "inbox-owner-10-b", mode: "permanent", recipientPublicKey: owner.publicKey, retentionDays: 7 },
    });
    // Drop on link B is created with an EARLIER createdAt than the drop on
    // link A, even though link A itself was created first.
    await makeDrop({
      linkId: linkB.id,
      senderPublicKey: "key-on-b",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    await makeDrop({
      linkId: linkA.id,
      senderPublicKey: "key-on-a",
      createdAt: new Date("2020-01-02T00:00:00Z"),
    });

    const inbox = await getInboxForUser(owner.id);
    const anon = inbox.counterparties.filter((c) => c.kind === "anonymous");

    expect(anon).toHaveLength(2);
    const anonymOne = anon.find((c) => c.displayName === "Anonym1")!;
    const anonymTwo = anon.find((c) => c.displayName === "Anonym2")!;
    expect(anonymOne.drops[0].linkSlug).toBe("inbox-owner-10-b"); // earlier createdAt, despite link A existing first
    expect(anonymTwo.drops[0].linkSlug).toBe("inbox-owner-10-a");
  });
});
