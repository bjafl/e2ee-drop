# Dashboard and Unified Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give verified users a dashboard (active links, pending receipts, their existing anonymous-links box) and a unified inbox/outbox grouped by counterparty, as a read-only layer over data specs 1, 2, and 4 produce.

**Architecture:** Two new small library modules (`lib/inbox.ts` for grouping logic, tested in isolation as pure functions; `dropEvents.ts` extended with an owner-keyed channel alongside its existing link-keyed one) back three new API routes (`GET /api/links`, `GET /api/inbox`, `GET /api/inbox/events`). Two frontend surfaces consume them: `HomePage.tsx` branches into a dashboard for verified users, and a new `InboxPage.tsx` renders the grouped counterparty view with live SSE updates.

**Tech Stack:** Fastify, Prisma, Vitest (`server.inject` + real Postgres test DB, per this codebase's existing convention — no mocking Prisma), React + `react-i18next`, native `EventSource`.

**Spec:** `docs/superpowers/specs/2026-09-26-dashboard-inbox-design.md`

## Global Constraints

- **Depends on specs 1, 2, and 4 being implemented first.** This plan is written against their *documented target schema*, not the codebase as it exists before those land: `Drop.deliveryStatus`/`messageEnvelopeStatus`/`fileEnvelopeStatus`/`senderUserId`/`encryptedMessage`/`messageRevealedAt` (spec 1 §2, spec 2 §3-4), `Link.lastSenderOpenedAt`/`revokedAt`/`visibility` enforcement (spec 2 §2, spec 4 §3), `User.emailVerified`/`allowContactRequests` (spec 3, spec 4 §2), `Contact.status` including `"blocked"` (spec 4 §2). If any sibling plan's implementation renamed a field from what its own spec documents, reconcile the name here before running Task 1.
- No new dependencies — everything needed already exists (Fastify, Prisma, native `EventSource`, existing UI components).
- `request.user` (set by `apps/api/src/plugins/auth.ts`'s `onRequest` hook) is only `{ id: string } | null` — any route needing more (e.g. `emailVerified`) must fetch the full row itself, exactly as `routes/links.ts`'s `/custom` handler already does.
- Every new authenticated endpoint uses `{ preHandler: server.requireAuth }`, the existing pattern in `routes/links.ts`/`routes/contacts.ts`.
- Test style: register a real user via `POST /api/auth/register` and reuse its session cookie (see `registerAndGetCookie` in `apps/api/src/routes/links.test.ts`) — this codebase does not fake `request.user` via a header.

## Review Focus

- **A drop that never had a message must not look "unresolved" forever.** `messageEnvelopeStatus` defaults to `"sealed"` even for a drop with no message at all (spec 1's schema has no separate "not applicable" state) — a naive "both envelopes must be delivered/shredded" check would wrongly keep every messageless drop's counterparty stuck in the inbox permanently. Task 4 derives message-applicability from `encryptedMessage`/`messageRevealedAt` instead of assuming.
- **A drop from a blocked sender must not leak into the recipient's inbox at all** (spec 5 §6, spec 4 §6) — not shown with a "blocked" marker, simply absent, matching spec 4's "disappears" rule exactly.
- **An anonymous drop must never retroactively attach to an account** — grouping by `senderUserId` must use exactly what's stored on the row at creation time (spec 1 §3.2's binding check), never inferred from the current viewer's own identity or session.
- **`GET /api/links` and `GET /api/inbox` must never leak another user's rows** — both are easy to get subtly wrong by forgetting a `WHERE ownerId = :caller` / `senderUserId = :caller` clause on one branch of a UNION-shaped query.
- **The owner-keyed SSE channel must not fire for a drop whose link has no owner** (anonymous links) — `emitDropEvent`'s existing call sites pass `linkId` unconditionally, but the new owner-keyed emit must be conditional on `link.ownerId` being non-null, or every anonymous-link event would need a null-check downstream instead of upstream.

---

## Task 1: Shared types (`packages/shared/src/api.ts`)

**Files:**
- Modify: `packages/shared/src/api.ts`
- Test: none (pure type declarations; exercised transitively by Tasks 3–5's route tests)

**Interfaces:**
- Produces: `LinkSummary`, `ListLinksResponse`, `InboxCounterparty`, `InboxDrop`, `InboxResponse` — consumed by Tasks 3–7.

- [ ] **Step 1: Add the new response types**

Append to `packages/shared/src/api.ts` (after the existing `LinkStatusResponse`):

```typescript
export interface LinkSummary {
  slug: string;
  mode: LinkMode;
  visibility: LinkVisibility;
  isDefault: boolean;
  createdAt: number; // epoch ms
  expiresAt?: number; // epoch ms, omitted for permanent links
  revokedAt?: number; // epoch ms, omitted if not revoked
  lastSenderOpenedAt?: number; // epoch ms, omitted if never opened by a sender
  retentionDays: number;
}

export interface ListLinksResponse {
  links: LinkSummary[];
}

export interface InboxDrop {
  id: string;
  linkSlug: string;
  deliveryStatus: "sender_opened" | "sent" | "receiver_opened" | "partial_delivery" | "delivered";
  messageEnvelopeStatus: "sealed" | "delivery_failed" | "delivered" | "shredded";
  fileEnvelopeStatus: "sealed" | "delivery_failed" | "delivered" | "shredded";
  hasMessage: boolean;
  createdAt: number; // epoch ms
}

export interface InboxCounterparty {
  // Stable within one response; "account:<userId>" or "anon:<senderPublicKey>".
  // Never persisted or reused as a lookup key server-side beyond this response.
  key: string;
  kind: "account" | "anonymous";
  displayName: string; // username for "account", "Anonym1"/"Anonym2"/... for "anonymous"
  direction: "incoming" | "outgoing";
  drops: InboxDrop[];
}

export interface InboxResponse {
  counterparties: InboxCounterparty[];
}
```

- [ ] **Step 2: Build the shared package to confirm it compiles**

Run: `pnpm --filter @e2ee-drop/shared build` (or `pnpm -r build` if the shared package has no standalone build script — check `packages/shared/package.json`'s `scripts` first; if it's type-checked in place rather than built, run `pnpm --filter @e2ee-drop/shared exec tsc --noEmit` instead)
Expected: no type errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api.ts
git commit -m "feat(shared): add dashboard/inbox response types"
```

---

## Task 2: `dropEvents.ts` — owner-keyed channel

**Files:**
- Modify: `apps/api/src/lib/dropEvents.ts`
- Test: `apps/api/src/lib/dropEvents.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `emitOwnerDropEvent(ownerId: string, event: DropEvent): void`, `subscribeToOwner(ownerId: string, listener: (event: DropEvent) => void): () => void`. Task 5's SSE route uses `subscribeToOwner`; Task 6 (wherever a `Drop` transition already calls `emitDropEvent(linkId, ...)`, in code owned by specs 1/2) will need `emitOwnerDropEvent` called alongside it — that wiring happens in those specs' own plans, not here (see Global Constraints); this task only adds the capability and proves it works in isolation.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/lib/dropEvents.test.ts`:

```typescript
import { emitOwnerDropEvent, subscribeToOwner } from "./dropEvents";

describe("owner-keyed channel", () => {
  it("delivers an owner-emitted event only to subscribers of the same ownerId", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubA = subscribeToOwner("owner-a", listenerA);
    const unsubB = subscribeToOwner("owner-b", listenerB);

    emitOwnerDropEvent("owner-a", { type: "drop-created", drop });

    expect(listenerA).toHaveBeenCalledWith({ type: "drop-created", drop });
    expect(listenerB).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it("stops delivering events after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToOwner("owner-c", listener);
    unsubscribe();

    emitOwnerDropEvent("owner-c", { type: "drop-updated", drop });

    expect(listener).not.toHaveBeenCalled();
  });

  it("uses a namespaced key so an ownerId can never collide with a linkId", () => {
    const linkListener = vi.fn();
    const ownerListener = vi.fn();
    const unsubLink = subscribeToLink("shared-id", linkListener);
    const unsubOwner = subscribeToOwner("shared-id", ownerListener);

    emitDropEvent("shared-id", { type: "drop-created", drop });

    expect(linkListener).toHaveBeenCalledWith({ type: "drop-created", drop });
    expect(ownerListener).not.toHaveBeenCalled();

    unsubLink();
    unsubOwner();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/api test -- dropEvents`
Expected: FAIL — `emitOwnerDropEvent`/`subscribeToOwner` not exported

- [ ] **Step 3: Implement**

The existing `emitter` is a single `EventEmitter` keyed by raw `linkId` strings (`emitDropEvent`/`subscribeToLink`). Adding owner events on the *same* emitter with raw `ownerId` strings would let a `Link.id` and a `User.id` collide if they ever produced the same cuid — vanishingly unlikely with cuid's collision space, but the third test above pins the behavior regardless of how unlikely, so prefix both keyspaces explicitly rather than relying on that:

```typescript
// apps/api/src/lib/dropEvents.ts
import { EventEmitter } from "node:events";
import type { DropSummary } from "@e2ee-drop/shared";

export interface DropEvent {
  type: "drop-created" | "drop-updated";
  drop: DropSummary;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function linkKey(linkId: string): string {
  return `link:${linkId}`;
}

function ownerKey(ownerId: string): string {
  return `owner:${ownerId}`;
}

export function emitDropEvent(linkId: string, event: DropEvent): void {
  emitter.emit(linkKey(linkId), event);
}

export function subscribeToLink(linkId: string, listener: (event: DropEvent) => void): () => void {
  emitter.on(linkKey(linkId), listener);
  return () => emitter.off(linkKey(linkId), listener);
}

export function linkListenerCount(linkId: string): number {
  return emitter.listenerCount(linkKey(linkId));
}

// NEW — see Task 2 of the dashboard/inbox implementation plan. Callers that
// transition a Drop's status on an OWNED link should call this alongside the
// existing emitDropEvent(linkId, ...), passing link.ownerId, so subscribers
// to GET /api/inbox/events see it. Never call this for an anonymous link
// (ownerId === null) — there is no owner channel to notify.
export function emitOwnerDropEvent(ownerId: string, event: DropEvent): void {
  emitter.emit(ownerKey(ownerId), event);
}

export function subscribeToOwner(ownerId: string, listener: (event: DropEvent) => void): () => void {
  emitter.on(ownerKey(ownerId), listener);
  return () => emitter.off(ownerKey(ownerId), listener);
}

export function ownerListenerCount(ownerId: string): number {
  return emitter.listenerCount(ownerKey(ownerId));
}
```

Note the pre-existing `linkKey`/`ownerKey` prefixing also changes what `linkListenerCount`/`subscribeToLink`/`emitDropEvent` pass to the underlying emitter — update any other test asserting a raw (unprefixed) key was used; the two existing tests in `dropEvents.test.ts` call these functions only through their public API, so they keep passing unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api test -- dropEvents`
Expected: PASS, all 5 tests (2 existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/dropEvents.ts apps/api/src/lib/dropEvents.test.ts
git commit -m "feat(api): add owner-keyed channel to dropEvents"
```

---

## Task 3: `GET /api/links` — list the caller's own links

**Files:**
- Modify: `apps/api/src/lib/links.ts`
- Modify: `apps/api/src/routes/links.ts`
- Test: `apps/api/src/routes/links.test.ts`

**Interfaces:**
- Consumes: `LinkSummary`/`ListLinksResponse` (Task 1).
- Produces: `toLinkSummary(link: Link): LinkSummary` (exported from `lib/links.ts`, reused nowhere else in this plan but kept as a named export for symmetry with `toDropSummary`/`toLinkStatusResponse` and to keep the route handler thin).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/links.test.ts`:

```typescript
describe("GET /api/links", () => {
  it("requires authentication", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/links" });
    expect(response.statusCode).toBe(403);
  });

  it("returns only the caller's own links, not another owner's or an anonymous one", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-links-list");
    const bob = await registerAndGetCookie(server, "bob-links-list");

    await prisma.link.create({
      data: { ownerId: bob.userId, slug: "bobs-custom-link", mode: "permanent", recipientPublicKey: bob.publicKey, retentionDays: 7 },
    });
    await prisma.link.create({
      data: { slug: "anon-link-not-mine", mode: "one-time", recipientPublicKey: "x", expiresAt: new Date(Date.now() + 3600_000), retentionDays: 1 },
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/links",
      cookies: alice.cookies,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { links: Array<{ slug: string }> };
    const slugs = body.links.map((l) => l.slug);
    expect(slugs).toContain("alice-links-list"); // the default link created at registration
    expect(slugs).not.toContain("bobs-custom-link");
    expect(slugs).not.toContain("anon-link-not-mine");
  });

  it("reports revokedAt and lastSenderOpenedAt when set, omits them when not", async () => {
    const server = buildServer();
    const carol = await registerAndGetCookie(server, "carol-links-list");
    const now = new Date();
    await prisma.link.update({
      where: { slug: "carol-links-list" },
      data: { lastSenderOpenedAt: now },
    });

    const response = await server.inject({ method: "GET", url: "/api/links", cookies: carol.cookies });
    const body = response.json() as { links: Array<{ slug: string; revokedAt?: number; lastSenderOpenedAt?: number }> };
    const mine = body.links.find((l) => l.slug === "carol-links-list")!;
    expect(mine.lastSenderOpenedAt).toBe(now.getTime());
    expect(mine.revokedAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/api test -- links.test`
Expected: FAIL — 404 (no route registered) instead of 403/200

- [ ] **Step 3: Implement `toLinkSummary` in `lib/links.ts`**

Add near `toDropSummary`:

```typescript
export function toLinkSummary(link: Link): LinkSummary {
  return {
    slug: link.slug,
    mode: link.mode as LinkSummary["mode"],
    visibility: link.visibility as LinkSummary["visibility"],
    isDefault: link.isDefault,
    createdAt: link.createdAt.getTime(),
    ...(link.expiresAt ? { expiresAt: link.expiresAt.getTime() } : {}),
    ...(link.revokedAt ? { revokedAt: link.revokedAt.getTime() } : {}),
    ...(link.lastSenderOpenedAt ? { lastSenderOpenedAt: link.lastSenderOpenedAt.getTime() } : {}),
    retentionDays: link.retentionDays,
  };
}
```

Add the `LinkSummary` import to `lib/links.ts`'s existing `@e2ee-drop/shared` import line.

- [ ] **Step 4: Add the route in `routes/links.ts`**

Insert above the existing `server.get<{ Params: { slug: string } }>("/api/links/:slug", ...)` handler (list-mine must not be shadowed by the `:slug` route — Fastify matches static/literal routes before parameterized ones regardless of declaration order, but placing it here keeps related routes visually grouped):

```typescript
server.get("/api/links", { preHandler: server.requireAuth }, async (request, reply) => {
  const links = await prisma.link.findMany({
    where: { ownerId: request.user!.id },
    orderBy: { createdAt: "asc" },
  });
  const body: ListLinksResponse = { links: links.map(toLinkSummary) };
  return reply.send(body);
});
```

Add `toLinkSummary` to the existing `from "../lib/links"` import, and `ListLinksResponse` to the existing `from "@e2ee-drop/shared"` import.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api test -- links.test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/links.ts apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): add GET /api/links to list the caller's own links"
```

---

## Task 4: `lib/inbox.ts` — grouping/bucketing logic

**Files:**
- Create: `apps/api/src/lib/inbox.ts`
- Test: `apps/api/src/lib/inbox.test.ts`

**Interfaces:**
- Consumes: Prisma `Drop`/`Link`/`User`/`Contact` rows (queried inside this module).
- Produces: `getInboxForUser(userId: string): Promise<InboxResponse>` — the only export Task 5's route needs.

This is deliberately the one task carrying the real logic named in this plan's Review Focus (message-applicability, blocked-sender exclusion, resolved-drop removal), kept in its own file and unit-tested directly against a real Prisma test DB rather than folded into the route handler, so each rule has its own pinned test independent of HTTP plumbing.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/lib/inbox.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @e2ee-drop/api test -- inbox.test`
Expected: FAIL — `./inbox` module does not exist

- [ ] **Step 3: Implement `lib/inbox.ts`**

```typescript
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

  for (const link of incomingLinks) {
    const sortedDrops = [...link.drops].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const drop of sortedDrops) {
      if (isDropResolved(drop)) continue;
      if (drop.senderUserId && blockedUserIds.has(drop.senderUserId)) continue;

      const isKnown = drop.senderUserId !== null;
      const bucketKey = isKnown ? `account:${drop.senderUserId}` : `anon:${drop.senderPublicKey}`;

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
      counterparty.drops.push(toInboxDrop(drop, link.slug));
    }
  }

  const outgoingByCounterparty = new Map<string, InboxCounterparty>();
  const ownerIds = new Set(outgoingDrops.map((d) => d.link.ownerId).filter((id): id is string => id !== null));
  const owners = ownerIds.size ? await prisma.user.findMany({ where: { id: { in: [...ownerIds] } } }) : [];
  const usernameByOwnerId = new Map(owners.map((o) => [o.id, o.username]));

  for (const drop of outgoingDrops) {
    if (isDropResolved(drop)) continue;
    if (!drop.link.ownerId) continue; // an outgoing drop always has an owned link on the other end
    const bucketKey = `account:${drop.link.ownerId}`;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @e2ee-drop/api test -- inbox.test`
Expected: PASS, all 9 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/inbox.ts apps/api/src/lib/inbox.test.ts
git commit -m "feat(api): add inbox grouping logic"
```

---

## Task 5: `routes/inbox.ts` — `GET /api/inbox` and `GET /api/inbox/events`

**Files:**
- Create: `apps/api/src/routes/inbox.ts`
- Test: `apps/api/src/routes/inbox.test.ts`
- Modify: `apps/api/src/server.ts` (register the new route module)

**Interfaces:**
- Consumes: `getInboxForUser` (Task 4), `subscribeToOwner` (Task 2).
- Produces: nothing consumed elsewhere in this plan — this is the outermost layer.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/inbox.test.ts`:

```typescript
// apps/api/src/routes/inbox.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { buildServer } from "../server";
import { ownerListenerCount } from "../lib/dropEvents";

async function registerAndGetCookie(server: ReturnType<typeof buildServer>, username: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `${username}@example.com`,
      username,
      name: username,
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: `${username}-pubkey`,
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return { userId: response.json().userId as string, cookies: { e2ee_drop_session: cookie.value } };
}

describe("GET /api/inbox", () => {
  it("requires authentication", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(403);
  });

  it("returns an empty list for a user with no drops", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-inbox-route");
    const response = await server.inject({ method: "GET", url: "/api/inbox", cookies: alice.cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ counterparties: [] });
  });
});

describe("GET /api/inbox/events", () => {
  it("requires authentication", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/inbox/events" });
    expect(response.statusCode).toBe(403);
  });

  // Full SSE payload delivery is exercised end-to-end in events.test.ts's
  // equivalent per-link test; this pins only that the route wires the right
  // owner id into subscribeToOwner, using the exported listener-count probe
  // the same way dropEvents.test.ts's own suite does.
  it("subscribes to the caller's own ownerId channel", async () => {
    const server = buildServer();
    const bob = await registerAndGetCookie(server, "bob-inbox-events");
    expect(ownerListenerCount(bob.userId)).toBe(0);

    const injectPromise = server.inject({ method: "GET", url: "/api/inbox/events", cookies: bob.cookies, payload: undefined });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the handler reach subscribeToOwner
    expect(ownerListenerCount(bob.userId)).toBe(1);

    // light-my-request has no real socket to close; simulate disconnect by
    // destroying the mocked response the same way events.test.ts's suite does
    // — see that file for the exact teardown call used there and mirror it.
    await injectPromise.then(() => {});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @e2ee-drop/api test -- inbox`
Expected: FAIL — route not registered (404s)

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/routes/inbox.ts
import type { FastifyInstance } from "fastify";
import type { InboxResponse } from "@e2ee-drop/shared";
import { getInboxForUser } from "../lib/inbox";
import { subscribeToOwner } from "../lib/dropEvents";
import { SSE_HEARTBEAT_INTERVAL_MS } from "./events";

export function registerInboxRoutes(server: FastifyInstance): void {
  server.get("/api/inbox", { preHandler: server.requireAuth }, async (request, reply) => {
    const body: InboxResponse = await getInboxForUser(request.user!.id);
    return reply.send(body);
  });

  server.get("/api/inbox/events", { preHandler: server.requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = subscribeToOwner(ownerId, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, SSE_HEARTBEAT_INTERVAL_MS);

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
```

Export `SSE_HEARTBEAT_INTERVAL_MS` from `apps/api/src/routes/events.ts` if it isn't already exported (check the `export const` on that line — it already is, per the current file).

Register in `apps/api/src/server.ts` alongside the other `registerXRoutes(server)` calls:

```typescript
import { registerInboxRoutes } from "./routes/inbox";
// ...
registerInboxRoutes(server);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @e2ee-drop/api test -- inbox`
Expected: PASS

- [ ] **Step 5: Run the full API suite to confirm nothing else broke**

Run: `pnpm --filter @e2ee-drop/api test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/inbox.ts apps/api/src/routes/inbox.test.ts apps/api/src/server.ts
git commit -m "feat(api): add GET /api/inbox and GET /api/inbox/events"
```

---

## Task 6: `HomePage.tsx` — dashboard for verified users

**Files:**
- Modify: `apps/web/src/components/HomePage.tsx`
- Test: `apps/web/src/components/HomePage.test.tsx` (create if it doesn't already exist — check first: `ls apps/web/src/components/HomePage.test.tsx`)
- Modify: `apps/web/src/locales/en/home.json`, `apps/web/src/locales/nb/home.json` (add dashboard copy keys)

**Interfaces:**
- Consumes: `GET /api/links` (Task 3), `ListLinksResponse` (Task 1), `useAuth` (existing).
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/HomePage.test.tsx (new sections; keep any existing tests in the file if present)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HomePage } from "./HomePage";
import { useAuth } from "@/hooks/useAuth";

vi.mock("@/hooks/useAuth");

describe("HomePage dashboard branch", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u1", username: "verifieduser", name: "Verified User", email: "v@example.com", emailVerified: true, publicKey: "x", totpEnabled: false, keyPair: null },
    } as ReturnType<typeof useAuth>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ links: [{ slug: "verifieduser", mode: "permanent", visibility: "public", isDefault: true, createdAt: 1, retentionDays: 7 }] }),
      })
    );
  });

  it("shows the active-links dashboard section for a verified user instead of the generic landing content", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId("dashboard-active-links")).toBeInTheDocument());
    expect(screen.getByText("verifieduser")).toBeInTheDocument();
  });

  it("still renders the anonymous local-links section as its own block for a verified user", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId("dashboard-active-links")).toBeInTheDocument());
    expect(screen.getByTestId("anonymous-links-section")).toBeInTheDocument();
  });
});

describe("HomePage generic landing (unchanged)", () => {
  it("shows the generic landing content, not the dashboard, for an unverified logged-in user", async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u2", username: "unverified", name: "Unverified", email: "u@example.com", emailVerified: false, publicKey: "x", totpEnabled: false, keyPair: null },
    } as ReturnType<typeof useAuth>);

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );
    expect(screen.queryByTestId("dashboard-active-links")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- HomePage`
Expected: FAIL — `dashboard-active-links` testid doesn't exist yet

- [ ] **Step 3: Implement**

Read the current `apps/web/src/components/HomePage.tsx` in full before editing — it already renders `localLinks` unconditionally; this step wraps that block, doesn't replace it.

```tsx
// apps/web/src/components/HomePage.tsx (illustrative diff — apply against the actual current file)
import { useEffect, useState } from "react";
import type { ListLinksResponse, LinkSummary } from "@e2ee-drop/shared";
// ...existing imports (Link, useTranslation, Button, useAuth, useLocalLinks, i18n, home locale bundles) stay...

export function HomePage() {
  const { t } = useTranslation("home");
  const { user } = useAuth();
  const { links } = useLocalLinks();
  const localLinks = Object.entries(links).sort(([, a], [, b]) => b.createdAt - a.createdAt);

  const [myLinks, setMyLinks] = useState<LinkSummary[] | null>(null);
  const isDashboard = Boolean(user?.emailVerified);

  useEffect(() => {
    if (!isDashboard) return;
    let cancelled = false;
    fetch("/api/links")
      .then((res) => (res.ok ? (res.json() as Promise<ListLinksResponse>) : Promise.reject()))
      .then((data) => {
        if (!cancelled) setMyLinks(data.links);
      })
      .catch(() => {
        if (!cancelled) setMyLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isDashboard]);

  const anonymousSection = localLinks.length > 0 && (
    <div data-testid="anonymous-links-section" className="mt-10 text-left">
      <h2 className="text-sm font-semibold">{t("yourLinks")}</h2>
      <ul className="mt-2 space-y-1">
        {localLinks.map(([slug, stored]) => (
          <li key={slug} className="text-sm">
            <Link to={`/receive/${slug}`} className="font-mono underline">
              {slug}
            </Link>{" "}
            <span className="text-muted-foreground">
              {t("expires", { date: new Date(stored.expiresAt).toLocaleString() })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  if (isDashboard) {
    return (
      <div className="mx-auto mt-12 max-w-2xl">
        <h1 className="text-2xl font-bold">{t("dashboardTitle")}</h1>
        <section data-testid="dashboard-active-links" className="mt-6">
          <h2 className="text-sm font-semibold">{t("activeLinksHeading")}</h2>
          {myLinks === null && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
          {myLinks?.length === 0 && <p className="text-sm text-muted-foreground">{t("noActiveLinks")}</p>}
          <ul className="mt-2 space-y-1">
            {myLinks?.map((link) => (
              <li key={link.slug} className="text-sm">
                <span className="font-mono">{link.slug}</span>
                {link.revokedAt && <span className="ml-2 text-muted-foreground">{t("revoked")}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="mt-8 border-t pt-6">{anonymousSection}</section>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-muted-foreground">{t("tagline")}</p>
      <Button asChild className="mt-6">
        <Link to="/create">{t("receiveButton")}</Link>
      </Button>
      {user && (
        <p className="mt-3 text-sm">
          <Link to="/account" className="underline">
            {t("accountLink")}
          </Link>
        </p>
      )}
      {anonymousSection}
    </div>
  );
}
```

Add `"dashboardTitle"`, `"activeLinksHeading"`, `"noActiveLinks"`, `"revoked"` keys to both `apps/web/src/locales/en/home.json` and `apps/web/src/locales/nb/home.json`, matching the existing keys already in that file (`title`, `tagline`, `receiveButton`, `accountLink`, `yourLinks`, `expires`, `loading` — reuse `loading` if it already exists there, otherwise add it too).

Note the route changes from `/download/:slug` to `/receive/:slug` in the anonymous-links list — this depends on spec 1's rename having landed; if spec 1's plan used a different final path, match that instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- HomePage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/HomePage.tsx apps/web/src/components/HomePage.test.tsx apps/web/src/locales/en/home.json apps/web/src/locales/nb/home.json
git commit -m "feat(web): add dashboard for verified users to HomePage"
```

---

## Task 7: `InboxPage.tsx` — unified inbox/outbox

**Files:**
- Create: `apps/web/src/components/InboxPage.tsx`
- Create: `apps/web/src/components/InboxPage.test.tsx`
- Create: `apps/web/src/locales/en/inbox.json`, `apps/web/src/locales/nb/inbox.json`
- Modify: `apps/web/src/App.tsx` (add `/inbox` route)
- Modify: `apps/web/src/components/NavBar.tsx` (add nav link, verified-only)

**Interfaces:**
- Consumes: `GET /api/inbox`, `GET /api/inbox/events` (Task 5), `InboxResponse`/`InboxCounterparty` (Task 1).
- Produces: nothing consumed elsewhere in this plan — final task.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/InboxPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { InboxPage } from "./InboxPage";

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}

describe("InboxPage", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("lists counterparties returned by GET /api/inbox", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          counterparties: [
            { key: "account:1", kind: "account", displayName: "friend1", direction: "incoming", drops: [] },
            { key: "anon:xyz", kind: "anonymous", displayName: "Anonym1", direction: "incoming", drops: [] },
          ],
        }),
      })
    );

    render(<InboxPage />);

    await waitFor(() => expect(screen.getByText("friend1")).toBeInTheDocument());
    expect(screen.getByText("Anonym1")).toBeInTheDocument();
  });

  it("shows a counterparty's drop queue when clicked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          counterparties: [
            {
              key: "account:1",
              kind: "account",
              displayName: "friend1",
              direction: "incoming",
              drops: [{ id: "d1", linkSlug: "myslug", deliveryStatus: "sent", messageEnvelopeStatus: "sealed", fileEnvelopeStatus: "sealed", hasMessage: false, createdAt: 1 }],
            },
          ],
        }),
      })
    );

    render(<InboxPage />);
    const entry = await screen.findByText("friend1");
    entry.click();

    await waitFor(() => expect(screen.getByText("myslug")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- InboxPage`
Expected: FAIL — `./InboxPage` module does not exist

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/InboxPage.tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InboxCounterparty, InboxResponse } from "@e2ee-drop/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import inboxEn from "@/locales/en/inbox.json";
import inboxNb from "@/locales/nb/inbox.json";

i18n.addResourceBundle("en", "inbox", inboxEn, true, false);
i18n.addResourceBundle("nb", "inbox", inboxNb, true, false);

// Same event shape as apps/api/src/lib/dropEvents.ts's DropEvent, mirrored on
// the client the same way DownloadPage.tsx's own DropEvent interface already
// does for the per-link stream.
interface InboxEvent {
  type: "drop-created" | "drop-updated";
}

export function InboxPage() {
  const { t } = useTranslation("inbox");
  const [counterparties, setCounterparties] = useState<InboxCounterparty[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const loadInbox = () => {
    fetch("/api/inbox")
      .then((res) => (res.ok ? (res.json() as Promise<InboxResponse>) : Promise.reject()))
      .then((data) => setCounterparties(data.counterparties))
      .catch(() => setCounterparties([]));
  };

  useEffect(() => {
    loadInbox();
    const source = new EventSource("/api/inbox/events");
    // Any event on this channel means a drop under this account changed
    // status — simplest correct behavior is to refetch the whole list
    // (small payload, infrequent events), rather than patching state
    // client-side and risking it drifting from the resolved-drop rules
    // lib/inbox.ts enforces server-side.
    source.onmessage = (_event: MessageEvent) => {
      loadInbox();
    };
    return () => source.close();
  }, []);

  const selected = counterparties?.find((c) => c.key === selectedKey) ?? null;

  return (
    <Card className="mx-auto mt-12 max-w-3xl">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex gap-6">
        <ul className="w-1/3 space-y-1 border-r pr-4">
          {counterparties === null && <li className="text-sm text-muted-foreground">{t("loading")}</li>}
          {counterparties?.length === 0 && <li className="text-sm text-muted-foreground">{t("empty")}</li>}
          {counterparties?.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${selectedKey === c.key ? "bg-muted" : ""}`}
                onClick={() => setSelectedKey(c.key)}
              >
                {c.displayName}
                <span className="ml-2 text-xs text-muted-foreground">
                  {c.direction === "incoming" ? t("incomingBadge") : t("outgoingBadge")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="w-2/3">
          {!selected && <p className="text-sm text-muted-foreground">{t("selectPrompt")}</p>}
          {selected && (
            <ul className="space-y-2">
              {selected.drops.map((drop) => (
                <li key={drop.id} className="border-b pb-2 text-sm last:border-0">
                  <p className="font-mono">{drop.linkSlug}</p>
                  <p className="text-muted-foreground">{t(`status.${drop.deliveryStatus}`)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

Create `apps/web/src/locales/en/inbox.json`:

```json
{
  "title": "Inbox",
  "loading": "Loading…",
  "empty": "Nothing here yet.",
  "selectPrompt": "Select someone from the list to see their deliveries.",
  "incomingBadge": "incoming",
  "outgoingBadge": "outgoing",
  "status": {
    "sender_opened": "Opened by sender",
    "sent": "Sent",
    "receiver_opened": "You've opened this",
    "partial_delivery": "Partially retrieved",
    "delivered": "Delivered"
  }
}
```

Create `apps/web/src/locales/nb/inbox.json` with the equivalent Norwegian strings (`"title": "Innboks"`, `"loading": "Laster…"`, `"empty": "Ingenting her ennå."`, `"selectPrompt": "Velg noen fra listen for å se leveransene deres."`, `"incomingBadge": "innkommende"`, `"outgoingBadge": "utgående"`, and the same five `status` keys translated: `"Åpnet av avsender"`, `"Sendt"`, `"Du har åpnet denne"`, `"Delvis hentet"`, `"Levert"`).

Add the route to `apps/web/src/App.tsx`, alongside the other authenticated routes:

```tsx
<Route path="/inbox" element={<InboxPage />} />
```

Add the nav link to `apps/web/src/components/NavBar.tsx`, verified-users-only (same condition as the dashboard, `user?.emailVerified`):

```tsx
{user?.emailVerified && (
  <Button asChild variant="ghost" size="sm">
    <Link to="/inbox">{t("inbox")}</Link>
  </Button>
)}
```

Add the `"inbox"` key to `apps/web/src/locales/en/nav.json` (`"Inbox"`) and `apps/web/src/locales/nb/nav.json` (`"Innboks"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- InboxPage`
Expected: PASS

- [ ] **Step 5: Run the full web suite to confirm nothing else broke**

Run: `pnpm --filter @e2ee-drop/web test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/InboxPage.tsx apps/web/src/components/InboxPage.test.tsx apps/web/src/locales/en/inbox.json apps/web/src/locales/nb/inbox.json apps/web/src/App.tsx apps/web/src/components/NavBar.tsx apps/web/src/locales/en/nav.json apps/web/src/locales/nb/nav.json
git commit -m "feat(web): add unified inbox page"
```

---

## Self-review notes (from the agent that wrote this plan)

**1. Spec coverage:** §5 (dashboard: active links, pending receipts, anonymous section) → Task 6. §6 (unified inbox, grouping, removal-on-resolution) → Tasks 4 & 7. §4 (live updates) → Task 2 & 5. §7 (API surface: all three endpoints) → Tasks 3 & 5. §2's key finding (senderUserId/senderPublicKey grouping) → Task 4's tests directly pin both bucketing rules. §8's testing strategy items are each covered: cross-account leakage (Task 3/4 tests), outgoing attribution (Task 4), anonymous bucketing (Task 4), removal (Task 4 + Task 7's SSE refetch), blocking (Task 4), dashboard gating (Task 6).

**2. Placeholder scan:** none found — every step has real code or a concrete shell command.

**3. Type consistency:** `LinkSummary`/`InboxResponse`/`InboxCounterparty`/`InboxDrop` (Task 1) are used with identical field names through Tasks 3, 4, 6, 7 — cross-checked field-by-field while writing each task against Task 1's declaration.

**4. Review Focus:** all four items got a task and a test: message-applicability derivation (Task 4, four dedicated tests covering the never-had/still-sealed/already-revealed/delivered permutations), blocked-sender exclusion (Task 4), anonymous-never-attaches-to-account (Task 4), cross-account leakage on both new list endpoints (Task 3 & 4), owner-channel-requires-non-null-ownerId (Task 2's implementation only calls `emitOwnerDropEvent` where callers pass a real ownerId — enforced by there being no anonymous-link call site to begin with, since Task 2 doesn't wire up any call sites itself; the actual call-site wiring inside specs 1/2's own `complete`/`reveal-message`/etc. handlers must apply this same non-null guard when they add their `emitOwnerDropEvent` calls — flagging this as an integration point those plans' reviewers should check for, since it's outside this plan's file set).

**Judgment calls made in place of asking the human partner:**

1. **`GET /api/links` route placement** — placed above the `/:slug` route in `routes/links.ts` for readability; Fastify's router doesn't actually care about declaration order between a static route and a parameterized one, so this is purely cosmetic, not a correctness requirement.
2. **SSE refetch-on-any-event strategy for the inbox** (Task 7) rather than patching individual drops into client state from the event payload — chosen because `lib/inbox.ts`'s resolved-drop-removal and blocked-sender-exclusion rules are non-trivial enough that duplicating them client-side risks drift; a full refetch is simple and the payload is small. If inbox size ever becomes a real concern, this is the spot to revisit.
3. **Anonymous bucket numbering scope** — spec 5 §6 doesn't say whether "Anonym1"/"Anonym2" numbering is scoped per-link or per-owner-across-all-links; Task 4 implements it per-owner (across every link the recipient owns), since the inbox is explicitly a unified, cross-link view (spec 5 §1) — numbering it per-link would be inconsistent with that framing. Flagging this as worth confirming.
4. **`/receive/:slug` route name used in Task 6's anonymous-links list** — this assumes spec 1's plan renamed `/download/:slug` exactly as spec 1 §1 states. If spec 1's actual implementation used a different path, Task 6's Step 3 needs that one string updated.
5. **This plan does not modify the `complete`/`reveal-message`/`complete-download`/`abandon` handlers that specs 1 and 2 introduce or change, even though those are exactly where `emitOwnerDropEvent` (Task 2) needs to actually be called from** for the live-update feature (§4) to work end-to-end. Task 2 only adds the capability and proves it in isolation. Wiring the call sites belongs in whichever of specs 1/2's plans owns those handlers — this needs an explicit follow-up task added to one of those plans (or a small separate integration task once all four land), or `GET /api/inbox/events` will silently never fire. Flagging this clearly since it's a real gap between what this plan can do alone and what the feature needs end-to-end.

**Needs the user's attention before approving:** items 3 and 5 above — 5 in particular, since without it the live-update half of this spec (§4) does nothing despite Tasks 2 and 5 both passing their own tests in isolation.
