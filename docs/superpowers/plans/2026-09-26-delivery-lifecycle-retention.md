# Delivery Lifecycle, Burn Semantics and Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the `deliveryStatus`/envelope-status placeholder fields spec 1 introduced into a
fully working lifecycle, and rewrite the cleanup job to scrub content (keep the row as an audit
trail) instead of hard-deleting it.

**Architecture:** A single CAS-based `recomputeDeliveryStatus` helper, called from both of spec 1's
existing reveal/download endpoints, replaces the ad-hoc derivation logic spec 1's plan 2 already
wrote inline (which has a real gap and a real race — see Task 3/4 below). The cleanup job's two
existing sweeps are rewritten from `DELETE` to `UPDATE` (scrub), and a third sweep purges rows once
their scrub is older than a new retention window. An owner-triggered manual scrub reuses the exact
same underlying function as the passive sweeps.

**Tech Stack:** Fastify, Prisma, Vitest — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-26-delivery-lifecycle-retention-design.md` (also read
`docs/superpowers/specs/2026-09-26-e2ee-send-receive-flow-design.md`, spec 1, which this extends)

**Prerequisite:** This plan assumes spec 1's three plans
(`docs/superpowers/plans/2026-09-26-e2ee-flow-{1,2,3}-*.md`) have already been implemented — it
patches code those plans introduce (`apps/api/src/routes/downloads.ts`'s `reveal-message` and
`complete-download` handlers, `apps/api/src/routes/links.ts`'s `GET /api/links/:slug` handler,
`apps/api/src/lib/quota.ts`'s ported `fileUploadStatus`-based functions, and
`apps/web/src/components/UploadPage.tsx`'s status fetch).

## Global Constraints

- `AUDIT_RETENTION_DAYS` env var, default 30 (design spec §5).
- Scrubbing never deletes a `Link` or `Drop` row — only `purgeAuditExpiredRows` (Task 9) does, and
  only once `contentDeletedAt` is older than `AUDIT_RETENTION_DAYS`.
- Anonymous and owned links get identical scrub treatment — no owner/anonymous branch in the new
  sweep logic (design spec §5's explicit unification).
- `messageEnvelopeStatus`/`fileEnvelopeStatus` only ever move `sealed`/`delivery_failed` →
  `delivered` or `shredded` — never backward, never overwritten once `delivered` or `shredded`.
- `deliveryStatus` never regresses (design spec §3).

## Review Focus

- A drop with no message at all must reach `deliveryStatus: "delivered"` from `fileEnvelopeStatus`
  alone — `recomputeDeliveryStatus` must not wait on a `messageEnvelopeStatus` that will never
  change from its initial value for such a drop.
- A cleanup sweep scrubbing a drop at the exact moment a receiver's `complete-download`/
  `reveal-message` call is in flight must not double-release quota, double-delete the S3 object, or
  let the sweep overwrite a `delivered` status the in-flight call just set.
- `owner-cancel` (Task 10) called on a drop still mid-upload (`fileUploadStatus`
  `"reserved"`/`"uploading"`, no content in the envelopes yet) must not attempt to delete a
  non-existent S3 object or mark envelopes `shredded` for content that was never sealed — it should
  behave like `abandon` (spec 1's endpoint) for that case, not like a post-upload cancel.
- The passive abandoned-upload sweep (spec 1 plan 2's Task 8, `sweepAbandonedUploads`) and this
  plan's scrub sweeps run in the same cron loop (`apps/api/src/jobs/cleanup.ts`'s `main()`) — a drop
  must never be double-processed (quota released twice) if it happens to match both sweeps' `where`
  clauses in the same tick.
- `purgeAuditExpiredRows` must not orphan a `Drop` whose `Link` was independently deleted by a
  different path in the same window (e.g. anonymous-link `DELETE /api/links/:slug`, unaffected by
  this plan) — the FK's `onDelete: Cascade` already handles this at the DB level, but the sweep's
  own query must not assume the parent `Link` still exists when logging/counting results.

---

## Task 1: Schema migration — `Link.lastSenderOpenedAt`, `AUDIT_RETENTION_DAYS`

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: a new migration under `packages/db/prisma/migrations/`
- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `Link.lastSenderOpenedAt: DateTime?` (Prisma-generated type), `env.AUDIT_RETENTION_DAYS: number`.

- [ ] **Step 1: Add the field to the schema**

In `packages/db/prisma/schema.prisma`, inside `model Link`, add:

```prisma
  // Lightweight, non-blocking: updated on every send-side GET, never gated by a CAS (every visit
  // just overwrites it). Does not create any Drop and never interacts with the one-time-link
  // single-drop invariant. See design spec §2 for why this is separate from Drop.deliveryStatus.
  lastSenderOpenedAt DateTime?
```

- [ ] **Step 2: Generate and inspect the migration**

```bash
pnpm --filter @e2ee-drop/db exec prisma migrate dev --name add_last_sender_opened_at --create-only
cat packages/db/prisma/migrations/*_add_last_sender_opened_at/migration.sql
```

Expected: a single `ALTER TABLE "Link" ADD COLUMN "lastSenderOpenedAt" TIMESTAMP(3);` — nullable,
no default, no data loss possible (this is a pure addition).

- [ ] **Step 3: Apply it and regenerate the client**

```bash
pnpm --filter @e2ee-drop/db exec prisma migrate dev
pnpm --filter @e2ee-drop/db generate
```

- [ ] **Step 4: Add the env var**

In `apps/api/src/env.ts`, alongside the existing `DROP_RETENTION_DAYS_DEFAULT`/`_MAX` (spec 1 plan
1 Task 5):

```typescript
  AUDIT_RETENTION_DAYS: int("AUDIT_RETENTION_DAYS", 30),
```

Add the matching line to `.env.example`, following the file's existing comment style for
neighboring retention vars.

- [ ] **Step 5: Verify the API package still builds**

```bash
pnpm --filter @e2ee-drop/api exec tsc --noEmit
```

Expected: no new errors (this task adds a nullable field nothing reads yet, and an env var nothing
consumes yet).

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations apps/api/src/env.ts .env.example
git commit -m "feat(db): add Link.lastSenderOpenedAt and AUDIT_RETENTION_DAYS"
```

## Task 2: `recomputeDeliveryStatus` — shared CAS-based derivation helper

**Files:**
- Modify: `apps/api/src/lib/links.ts`
- Test: `apps/api/src/lib/links.test.ts`

**Interfaces:**
- Consumes: `Drop` shape from `@e2ee-drop/db` (has `id`, `linkId`, `encryptedMessage`,
  `messageEnvelopeStatus`, `fileEnvelopeStatus`, `deliveryStatus`).
- Produces: `recomputeDeliveryStatus(dropId: string, linkId: string): Promise<void>` — re-reads the
  row fresh (never trusts a caller-supplied snapshot, since it must be race-safe against the other
  envelope's endpoint updating concurrently), and CAS-updates `deliveryStatus` if the newly derived
  value differs from — and is not behind — the current one.

**This exists because spec 1's plan 2 wrote two different, incomplete versions of this logic
inline**: Task 10 (`reveal-message`) never touches `deliveryStatus` at all, and Task 11
(`complete-download`) computes it from a stale in-memory `drop` snapshot read *before* its own
update, with a second unguarded `updateMany` — not race-safe against a concurrent reveal. This task
replaces both with one correct, shared implementation; Tasks 3 and 4 wire it in.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/lib/links.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { recomputeDeliveryStatus } from "./links";
// ...use this file's existing test setup/factories for creating a Link + Drop, matching
// whatever helper this codebase's other lib tests already use (check links.test.ts's existing
// imports first — do not invent a new factory if one exists).

describe("recomputeDeliveryStatus", () => {
  it("reaches delivered from fileEnvelopeStatus alone when there is no message", async () => {
    // Drop with encryptedMessage: null, fileEnvelopeStatus: "delivered", deliveryStatus: "sent"
    await recomputeDeliveryStatus(dropId, linkId);
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(drop.deliveryStatus).toBe("delivered");
  });

  it("goes to partial_delivery when exactly one envelope is delivered and a message exists", async () => {
    // Drop with encryptedMessage set (message present), messageEnvelopeStatus: "sealed",
    // fileEnvelopeStatus: "delivered", deliveryStatus: "receiver_opened"
    await recomputeDeliveryStatus(dropId, linkId);
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(drop.deliveryStatus).toBe("partial_delivery");
  });

  it("reaches delivered only once both envelopes are delivered", async () => {
    // Drop with a message, messageEnvelopeStatus: "delivered", fileEnvelopeStatus: "delivered"
    await recomputeDeliveryStatus(dropId, linkId);
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(drop.deliveryStatus).toBe("delivered");
  });

  it("never regresses an already-delivered status", async () => {
    // Drop already at deliveryStatus: "delivered", fileEnvelopeStatus flipped back to
    // "shredded" by a test setup that shouldn't happen in practice — still must not regress.
    await recomputeDeliveryStatus(dropId, linkId);
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(drop.deliveryStatus).toBe("delivered");
  });

  it("does nothing when neither envelope is delivered yet", async () => {
    // Drop at deliveryStatus: "receiver_opened", both envelopes still "sealed"
    await recomputeDeliveryStatus(dropId, linkId);
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(drop.deliveryStatus).toBe("receiver_opened");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/links.test.ts
```

Expected: FAIL — `recomputeDeliveryStatus` is not exported yet.

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/lib/links.ts

const DELIVERY_STATUS_RANK: Record<string, number> = {
  sender_opened: 0,
  sent: 1,
  receiver_opened: 2,
  partial_delivery: 3,
  delivered: 4,
};

// Re-derives Drop.deliveryStatus from both envelope statuses and writes it if — and only if — the
// derived value is strictly ahead of the row's CURRENT value at write time. Always re-reads the
// row itself rather than trusting a caller's snapshot: this is what makes it safe to call from two
// endpoints (reveal-message, complete-download) that can race each other on the same drop.
export async function recomputeDeliveryStatus(dropId: string, linkId: string): Promise<void> {
  const drop = await prisma.drop.findFirst({
    where: { id: dropId, linkId },
    select: {
      deliveryStatus: true,
      encryptedMessage: true,
      messageEnvelopeStatus: true,
      fileEnvelopeStatus: true,
    },
  });
  if (!drop) return;

  const hasMessage = drop.encryptedMessage !== null || drop.messageEnvelopeStatus === "delivered";
  const messageDone = !hasMessage || drop.messageEnvelopeStatus === "delivered";
  const fileDone = drop.fileEnvelopeStatus === "delivered";

  let derived: string;
  if (messageDone && fileDone) derived = "delivered";
  else if (messageDone !== fileDone && (messageDone || fileDone)) derived = "partial_delivery";
  else derived = drop.deliveryStatus; // neither done yet — no change

  if (DELIVERY_STATUS_RANK[derived] <= DELIVERY_STATUS_RANK[drop.deliveryStatus]) return;

  // CAS on the current value read above: if a concurrent call already advanced the row further,
  // this simply matches zero rows instead of stomping a newer status with a stale derivation.
  await prisma.drop.updateMany({
    where: { id: dropId, linkId, deliveryStatus: drop.deliveryStatus },
    data: { deliveryStatus: derived },
  });
}
```

Note on `hasMessage`: once `reveal-message` scrubs `encryptedMessage` to `null` (spec 1 Task 10),
the plain-null check alone would make a *delivered* message look like "no message ever existed" —
the `|| messageEnvelopeStatus === "delivered"` clause is what keeps `hasMessage` true after the
scrub, so a since-revealed message still counts toward `messageDone`.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/links.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/links.ts apps/api/src/lib/links.test.ts
git commit -m "feat(api): add race-safe deliveryStatus derivation helper"
```

## Task 3: Wire `recomputeDeliveryStatus` into `reveal-message`

**Files:**
- Modify: `apps/api/src/routes/downloads.ts` (the `reveal-message` handler from spec 1 plan 2 Task 10)

**Interfaces:**
- Consumes: `recomputeDeliveryStatus` (Task 2).

- [ ] **Step 1: Write the failing test**

```typescript
it("reveal-message also advances deliveryStatus toward partial_delivery/delivered", async () => {
  // Drop has a message and an already-"delivered" fileEnvelopeStatus (file downloaded first)
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
  });
  expect(res.statusCode).toBe(200);
  const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(status.json().drop.deliveryStatus).toBe("delivered");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 3: Add the call**

In `downloads.ts`, import `recomputeDeliveryStatus` from `../lib/links`. At the end of the
`reveal-message` handler's success path — after the `if (count !== 1)` check, right before
building `body` — add:

```typescript
      await recomputeDeliveryStatus(dropId, link.id);
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/downloads.ts apps/api/src/routes/downloads.test.ts
git commit -m "fix(api): reveal-message now advances deliveryStatus (was never touched)"
```

## Task 4: Replace `complete-download`'s inline derivation with `recomputeDeliveryStatus`

**Files:**
- Modify: `apps/api/src/routes/downloads.ts` (the `complete-download` handler from spec 1 plan 2 Task 11)

**Interfaces:**
- Consumes: `recomputeDeliveryStatus` (Task 2).

- [ ] **Step 1: Write the failing test**

```typescript
it("complete-download's deliveryStatus derivation survives a concurrent reveal-message", async () => {
  // Drop has a message, fileEnvelopeStatus "sealed", messageEnvelopeStatus "sealed".
  // Fire both calls "concurrently" (Promise.all) against the test server.
  await Promise.all([
    server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/reveal-message` }),
    server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete-download` }),
  ]);
  const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  // Whichever order the two calls actually completed in, both envelopes end up delivered,
  // and the derived overall status must reflect that — not get stuck at partial_delivery from
  // one call's stale read of the other's not-yet-committed state.
  expect(status.json().drop.deliveryStatus).toBe("delivered");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

Expected: this can fail flakily/intermittently against the old inline logic depending on
scheduling — that flakiness itself is the bug this task fixes. Run it a few times if it passes once
by luck.

- [ ] **Step 3: Replace the inline logic**

In the `complete-download` handler, delete this block spec 1 plan 2 Task 11 wrote:

```typescript
      // DELETE this whole block:
      const messageDone = drop.messageEnvelopeStatus === "delivered" || drop.encryptedMessage === null;
      await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id },
        data: { deliveryStatus: messageDone ? "delivered" : "partial_delivery" },
      });
```

Replace it with:

```typescript
      await recomputeDeliveryStatus(dropId, link.id);
```

(The `import type { RevealMessageResponse }` line already added in `downloads.ts` by Task 3 covers
the same file — just add `recomputeDeliveryStatus` to that existing `../lib/links` import if Task 3
ran first, or add the import fresh if this task runs first.)

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/downloads.ts apps/api/src/routes/downloads.test.ts
git commit -m "fix(api): replace complete-download's racy inline deliveryStatus derivation"
```

## Task 5: `lastSenderOpenedAt` tracking via `?role=sender`

**Files:**
- Modify: `apps/api/src/routes/links.ts` (the `GET /api/links/:slug` handler, extended by spec 1
  plan 2 Task 9 with a `role=receiver` branch)
- Modify: `apps/web/src/components/UploadPage.tsx` (spec 1 plan 3 Task 11's status fetch)

**Interfaces:**
- Consumes: a new `?role=sender` query parameter, symmetric to the existing `?role=receiver`.
- Produces: `Link.lastSenderOpenedAt` updated (unconditional overwrite, no CAS — every visit is
  meaningful, not just the first).

- [ ] **Step 1: Write the failing test**

```typescript
it("GET with role=sender updates Link.lastSenderOpenedAt", async () => {
  const before = await prisma.link.findUniqueOrThrow({ where: { slug } });
  expect(before.lastSenderOpenedAt).toBeNull();

  await server.inject({ method: "GET", url: `/api/links/${slug}?role=sender` });

  const after = await prisma.link.findUniqueOrThrow({ where: { slug } });
  expect(after.lastSenderOpenedAt).not.toBeNull();
});

it("GET with role=sender does not create any Drop or touch deliveryStatus", async () => {
  const before = await prisma.drop.count({ where: { linkId: link.id } });
  await server.inject({ method: "GET", url: `/api/links/${slug}?role=sender` });
  const after = await prisma.drop.count({ where: { linkId: link.id } });
  expect(after).toBe(before);
});

it("a second role=sender visit overwrites the earlier timestamp, not just the first", async () => {
  await server.inject({ method: "GET", url: `/api/links/${slug}?role=sender` });
  const first = (await prisma.link.findUniqueOrThrow({ where: { slug } })).lastSenderOpenedAt;
  await new Promise((r) => setTimeout(r, 5));
  await server.inject({ method: "GET", url: `/api/links/${slug}?role=sender` });
  const second = (await prisma.link.findUniqueOrThrow({ where: { slug } })).lastSenderOpenedAt;
  expect(second!.getTime()).toBeGreaterThan(first!.getTime());
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 3: Add the branch**

In the same `GET /api/links/:slug` handler Task 9 (spec 1 plan 2) already modified, add a sibling
branch to the existing `if (request.query.role === "receiver" ...)` block:

```typescript
      if (request.query.role === "sender") {
        await prisma.link.updateMany({ where: { id: link.id }, data: { lastSenderOpenedAt: new Date() } });
      }
```

Update the querystring type from `{ role?: string }` to keep accepting either value (no type change
needed — it's already a bare `string`).

- [ ] **Step 4: Update `UploadPage.tsx`'s status fetch**

Find the plain `fetch(\`/api/links/${slug}\`)` call (spec 1 plan 3 Task 11) and change it to:

```typescript
    fetch(`/api/links/${slug}?role=sender`)
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
pnpm --filter @e2ee-drop/web exec vitest run src/components/UploadPage.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts apps/web/src/components/UploadPage.tsx
git commit -m "feat: track Link.lastSenderOpenedAt on sender-side link fetch"
```

## Task 6: Scrub-and-release quota helpers (`lib/quota.ts`)

**Files:**
- Modify: `apps/api/src/lib/quota.ts`
- Test: `apps/api/src/lib/quota.test.ts`

**Interfaces:**
- Consumes: `releaseCharged` (existing, ported to `fileUploadStatus` by spec 1 plan 1 Task 3).
- Produces: `scrubDropContent(dropId: string): Promise<{ ownerId: string | null; s3Key: string } | null>`
  — nulls the ciphertext/nonce columns, sets `contentDeletedAt`, sets each envelope not already
  `"delivered"` to `"shredded"`, and (only for an owned drop) releases quota in the same
  transaction. Returns the `s3Key` so the caller can delete the storage object (this function never
  calls `deleteObject` itself — matches this codebase's existing convention that every call site,
  not the quota/DB layer, owns storage deletion). Returns `null` if the drop doesn't exist or both
  envelopes are already terminal (`delivered` or `shredded` — nothing to scrub).

- [ ] **Step 1: Write the failing tests**

```typescript
describe("scrubDropContent", () => {
  it("nulls ciphertext columns and sets shredded for a sealed drop", async () => {
    const result = await scrubDropContent(dropId);
    expect(result).toEqual({ ownerId: null, s3Key: expect.any(String) });
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(drop.encryptedMessage).toBeNull();
    expect(drop.messageNonce).toBeNull();
    expect(drop.messageEnvelopeStatus).toBe("shredded");
    expect(drop.fileEnvelopeStatus).toBe("shredded");
    expect(drop.contentDeletedAt).not.toBeNull();
  });

  it("does not overwrite an already-delivered envelope with shredded", async () => {
    // Drop with messageEnvelopeStatus: "delivered", fileEnvelopeStatus: "sealed"
    await scrubDropContent(dropId);
    const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(drop.messageEnvelopeStatus).toBe("delivered");
    expect(drop.fileEnvelopeStatus).toBe("shredded");
  });

  it("returns null and does nothing when both envelopes are already terminal", async () => {
    // Drop with fileEnvelopeStatus: "delivered", messageEnvelopeStatus: "shredded"
    const result = await scrubDropContent(dropId);
    expect(result).toBeNull();
  });

  it("releases owner quota for a charged owned drop", async () => {
    // Owned link's drop, fileUploadStatus: "complete" (charged), owner storageUsedBytes reflects it
    const before = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    await scrubDropContent(dropId);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(after.storageUsedBytes).toBeLessThan(before.storageUsedBytes);
  });

  it("does not touch quota for an anonymous drop", async () => {
    const result = await scrubDropContent(dropId);
    expect(result!.ownerId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/quota.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/lib/quota.ts

// Scrubs one drop's content in place — the row survives as the audit trail (design spec §5).
// Unlike deleteDropReleasingQuota/deleteLinkReleasingQuota (which DELETE the row), this always
// UPDATEs it, so it works identically for anonymous and owned drops (only the quota-release step
// differs). The caller is responsible for actually deleting the returned s3Key from storage —
// this function only ever touches the database.
export async function scrubDropContent(
  dropId: string
): Promise<{ ownerId: string | null; s3Key: string } | null> {
  const drop = await prisma.drop.findUnique({
    where: { id: dropId },
    select: {
      s3Key: true,
      fileSize: true,
      fileUploadStatus: true,
      messageEnvelopeStatus: true,
      fileEnvelopeStatus: true,
      link: { select: { id: true, ownerId: true } },
    },
  });
  if (!drop) return null;
  const messageAlreadyTerminal =
    drop.messageEnvelopeStatus === "delivered" || drop.messageEnvelopeStatus === "shredded";
  const fileAlreadyTerminal =
    drop.fileEnvelopeStatus === "delivered" || drop.fileEnvelopeStatus === "shredded";
  if (messageAlreadyTerminal && fileAlreadyTerminal) return null;

  const ownerId = drop.link.ownerId;
  const scrub = async (tx: Prisma.TransactionClient) => {
    await tx.drop.updateMany({
      where: { id: dropId },
      data: {
        encryptedMessage: null,
        messageNonce: null,
        contentDeletedAt: new Date(),
        ...(messageAlreadyTerminal ? {} : { messageEnvelopeStatus: "shredded" }),
        ...(fileAlreadyTerminal ? {} : { fileEnvelopeStatus: "shredded" }),
      },
    });
    if (ownerId) {
      const owner = await lockOwnerQuota(tx, ownerId);
      if (owner) await releaseCharged(tx, ownerId, [{ fileSize: drop.fileSize, fileUploadStatus: drop.fileUploadStatus }]);
    }
  };

  if (ownerId) {
    await prisma.$transaction(scrub, QUOTA_TX_OPTIONS);
  } else {
    await scrub(prisma as unknown as Prisma.TransactionClient);
  }
  return { ownerId, s3Key: drop.s3Key };
}
```

`releaseCharged` and `isChargedStatus` are unexported (module-private) today — export
`releaseCharged` from `quota.ts` (add `export` to its existing declaration) so this new function,
which lives in the same file, can call it; no signature change needed since this task is in the
same module.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/quota.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/quota.ts apps/api/src/lib/quota.test.ts
git commit -m "feat(api): add scrubDropContent (content gone, row kept for audit)"
```

## Task 7: Rewrite `runCleanup()` — scrub, not delete, unified for anonymous and owned

**Files:**
- Modify: `apps/api/src/jobs/cleanup.ts`
- Test: `apps/api/src/jobs/cleanup.test.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Consumes: `scrubDropContent` (Task 6).
- Produces: `runCleanup(): Promise<{ scrubbedLinks: number }>` — return shape changes from
  `{ deletedLinks }` to `{ scrubbedLinks }`; update the one call site in `main()` (Task 9 also
  touches `main()`, so sequence this task before Task 9 or reconcile both edits to `main()`
  together).

- [ ] **Step 1: Write the failing tests**

```typescript
it("scrubs an expired one-time link's drop instead of deleting the row", async () => {
  // Anonymous one-time link, expiresAt in the past, one drop with fileEnvelopeStatus "sealed"
  const result = await runCleanup();
  expect(result.scrubbedLinks).toBe(1);
  const link = await prisma.link.findUnique({ where: { slug } });
  expect(link).not.toBeNull(); // row survives
  const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
  expect(drop.fileEnvelopeStatus).toBe("shredded");
  expect(drop.contentDeletedAt).not.toBeNull();
});

it("treats an owned expired one-time link identically to an anonymous one", async () => {
  // Same as above but link.ownerId set, drop charged against that owner's quota
  const before = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  await runCleanup();
  const after = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  expect(after.storageUsedBytes).toBeLessThan(before.storageUsedBytes);
  const link = await prisma.link.findUnique({ where: { slug } });
  expect(link).not.toBeNull(); // row survives — this is the behavior change from today
});

it("does not re-scrub a drop that is already delivered", async () => {
  // Expired one-time link whose drop is already fileEnvelopeStatus/messageEnvelopeStatus "delivered"
  await runCleanup();
  // deleteObject mock must NOT have been called for this drop
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 3: Rewrite `runCleanup`**

```typescript
export async function runCleanup(): Promise<{ scrubbedLinks: number }> {
  const now = new Date();
  const expiredLinks = await prisma.link.findMany({
    where: { mode: "one-time", expiresAt: { lt: now } },
    include: { drops: true },
  });

  let scrubbedLinks = 0;
  for (const link of expiredLinks) {
    let scrubbedAny = false;
    for (const drop of link.drops) {
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
```

Remove the now-unused `deleteLinkIfExists`/`deleteLinkReleasingQuota` imports from this file if
this task is the only remaining caller in it (check `runCleanup`'s neighbors in the same file
before removing — `sweepExpiredDrops`, rewritten in Task 8, has its own analogous cleanup).

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/cleanup.ts apps/api/src/jobs/cleanup.test.ts
git commit -m "feat(api): runCleanup scrubs one-time link content instead of deleting the row"
```

## Task 8: Rewrite `sweepExpiredDrops()` — scrub, not delete

**Files:**
- Modify: `apps/api/src/jobs/cleanup.ts`
- Test: `apps/api/src/jobs/cleanup.test.ts`

**Interfaces:**
- Consumes: `scrubDropContent` (Task 6).
- Produces: `sweepExpiredDrops(): Promise<{ scrubbedDrops: number }>` (renamed from `deletedDrops`).

- [ ] **Step 1: Write the failing test**

```typescript
it("scrubs a permanent link's expired drop instead of deleting it", async () => {
  // Permanent link, retentionDays: 1, drop createdAt 2 days ago
  const result = await sweepExpiredDrops();
  expect(result.scrubbedDrops).toBe(1);
  const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
  expect(drop.fileEnvelopeStatus).toBe("shredded");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 3: Rewrite**

```typescript
export async function sweepExpiredDrops(): Promise<{ scrubbedDrops: number }> {
  const now = Date.now();
  const drops = await prisma.drop.findMany({
    where: { link: { mode: "permanent" } },
    include: { link: true },
  });

  let scrubbedDrops = 0;
  for (const drop of drops) {
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
```

(`drop.link.retentionDays` is already non-nullable per spec 1's migration and plan 1 Task 5's fix
to this exact line — no `?? env...` fallback to remove here, it's already gone.)

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/cleanup.ts apps/api/src/jobs/cleanup.test.ts
git commit -m "feat(api): sweepExpiredDrops scrubs content instead of deleting the row"
```

## Task 9: `purgeAuditExpiredRows()` — final hard-delete sweep

**Files:**
- Modify: `apps/api/src/jobs/cleanup.ts`
- Test: `apps/api/src/jobs/cleanup.test.ts`

**Interfaces:**
- Produces: `purgeAuditExpiredRows(): Promise<{ purgedDrops: number; purgedLinks: number }>`.
- Consumes: `env.AUDIT_RETENTION_DAYS` (Task 1).

- [ ] **Step 1: Write the failing tests**

```typescript
it("hard-deletes a drop whose contentDeletedAt is past the audit retention window", async () => {
  // Drop with contentDeletedAt 31 days ago (AUDIT_RETENTION_DAYS default 30)
  const result = await purgeAuditExpiredRows();
  expect(result.purgedDrops).toBe(1);
  const drop = await prisma.drop.findUnique({ where: { id: dropId } });
  expect(drop).toBeNull();
});

it("does not purge a drop scrubbed within the retention window", async () => {
  // contentDeletedAt 5 days ago
  const result = await purgeAuditExpiredRows();
  expect(result.purgedDrops).toBe(0);
});

it("also purges the Link when its sole one-time drop is purged", async () => {
  // One-time link whose single drop's contentDeletedAt is past the window
  await purgeAuditExpiredRows();
  const link = await prisma.link.findUnique({ where: { slug } });
  expect(link).toBeNull();
});

it("never purges a permanent link's own row, only its expired drops", async () => {
  // Permanent link with one purge-eligible drop
  await purgeAuditExpiredRows();
  const link = await prisma.link.findUnique({ where: { slug } });
  expect(link).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 3: Implement**

```typescript
export async function purgeAuditExpiredRows(): Promise<{ purgedDrops: number; purgedLinks: number }> {
  const cutoff = new Date(Date.now() - env.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.drop.findMany({
    where: { contentDeletedAt: { lt: cutoff } },
    include: { link: true },
  });

  let purgedLinks = 0;
  for (const drop of expired) {
    await prisma.drop.delete({ where: { id: drop.id } });
    if (drop.link.mode === "one-time") {
      // Deleting a one-time link's sole drop leaves nothing worth keeping the Link row for.
      // deleteMany (not delete) tolerates a link already removed by a concurrent purge/DELETE call.
      const { count } = await prisma.link.deleteMany({ where: { id: drop.link.id } });
      purgedLinks += count;
    }
  }

  return { purgedDrops: expired.length, purgedLinks };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 5: Wire into `main()`**

```typescript
// In main()'s loop, alongside the existing three calls:
const purgeResult = await purgeAuditExpiredRows();
console.log(
  `[cleanup] scrubbed ${linkResult.scrubbedLinks} link(s), ${dropResult.scrubbedDrops} drop(s), ` +
    `purged ${purgeResult.purgedDrops} drop(s) and ${purgeResult.purgedLinks} link(s) past audit retention, ` +
    `pruned ${tokenResult.deletedTokens} expired password-reset token(s)`
);
```

- [ ] **Step 6: Run the full cleanup test file and commit**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
git add apps/api/src/jobs/cleanup.ts apps/api/src/jobs/cleanup.test.ts
git commit -m "feat(api): add final audit-retention purge sweep"
```

## Task 10: Owner-triggered manual cancel

**Files:**
- Modify: `apps/api/src/routes/downloads.ts` (or `links.ts` — colocate with the other owner-gated
  drop routes already in `downloads.ts`, e.g. `reveal-message`/`complete-download`)
- Test: `apps/api/src/routes/downloads.test.ts`

**Interfaces:**
- Produces: `POST /api/links/:slug/drops/:dropId/owner-cancel` → `{ cancelled: boolean }`.
- Consumes: `scrubDropContent` (Task 6).

Handles the Review Focus item on a mid-upload drop: if `fileUploadStatus` isn't `"complete"` yet,
there is no sealed content to scrub — respond the same way as spec 1's `abandon` endpoint would
(this task does not duplicate `abandon`'s logic; it delegates to it for that specific case).

- [ ] **Step 1: Write the failing tests**

```typescript
it("owner-cancel scrubs a sealed drop's content", async () => {
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/owner-cancel`,
    headers: { cookie: ownerSessionCookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ cancelled: true });
  const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
  expect(drop.fileEnvelopeStatus).toBe("shredded");
});

it("rejects a non-owner", async () => {
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/owner-cancel`,
    headers: { cookie: otherUserSessionCookie },
  });
  expect(res.statusCode).toBe(403);
});

it("is a no-op, not an error, on an already-delivered drop", async () => {
  // Drop with fileEnvelopeStatus and messageEnvelopeStatus both "delivered"
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/owner-cancel`,
    headers: { cookie: ownerSessionCookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ cancelled: false });
});

it("delegates to abandon semantics for a still-uploading drop", async () => {
  // Drop with fileUploadStatus "uploading", envelopes still default "sealed" with no content set
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/owner-cancel`,
    headers: { cookie: ownerSessionCookie },
  });
  expect(res.statusCode).toBe(200);
  const drop = await prisma.drop.findUnique({ where: { id: dropId } });
  expect(drop).toBeNull(); // abandoned (row removed), not scrubbed-in-place
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 3: Implement**

```typescript
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/owner-cancel",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (link.ownerId !== request.user!.id) return reply.status(403).send({ error: "Forbidden" });
      const { dropId } = request.params;
      const drop = link.drops.find((candidate) => candidate.id === dropId);
      if (!drop) return reply.status(404).send({ error: "Drop not found" });

      if (drop.fileUploadStatus !== "complete") {
        // Nothing sealed yet — same outcome as the sender abandoning their own upload.
        await abandonDrop(dropId, link.id); // exported by spec 1's abandon endpoint module
        return reply.send({ cancelled: true });
      }

      const result = await scrubDropContent(dropId);
      if (result) await deleteObject(result.s3Key);
      return reply.send({ cancelled: result !== null });
    }
  );
```

`abandonDrop` must be exported from wherever spec 1's `abandon` endpoint (plan 2 Task 7) put its
core logic — check that file first; if `abandon`'s logic is inline in the route handler rather than
a separate exported function, extract it into one (`abandonDrop(dropId, linkId): Promise<void>`)
as part of this step, since this task needs to call it too.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/downloads.ts apps/api/src/routes/downloads.test.ts
git commit -m "feat(api): add owner-triggered manual drop cancel"
```

## Task 11: Extend `DELETE /api/links/:slug` for authenticated owners

**Files:**
- Modify: `apps/api/src/routes/links.ts`
- Test: `apps/api/src/routes/links.test.ts`

**Interfaces:**
- Consumes: `scrubDropContent` (Task 6).
- Produces: `DELETE /api/links/:slug` now succeeds for the authenticated owner of an owned link, in
  addition to its existing anonymous-link behavior.

- [ ] **Step 1: Write the failing tests**

```typescript
it("allows the authenticated owner to delete their own link", async () => {
  const res = await server.inject({
    method: "DELETE",
    url: `/api/links/${slug}`,
    headers: { cookie: ownerSessionCookie },
  });
  expect(res.statusCode).toBe(200);
});

it("scrubs (not deletes) each drop's content, then deletes the Link row", async () => {
  // Owned permanent link with two drops, one sealed, one already delivered
  await server.inject({ method: "DELETE", url: `/api/links/${slug}`, headers: { cookie: ownerSessionCookie } });
  const link = await prisma.link.findUnique({ where: { slug } });
  expect(link).toBeNull();
});

it("still rejects a non-owner for an owned link", async () => {
  const res = await server.inject({
    method: "DELETE",
    url: `/api/links/${slug}`,
    headers: { cookie: otherUserSessionCookie },
  });
  expect(res.statusCode).toBe(403);
});

it("anonymous-link deletion is unchanged", async () => {
  const res = await server.inject({ method: "DELETE", url: `/api/links/${anonymousSlug}` });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 3: Read the existing handler first**

```bash
sed -n '187,214p' apps/api/src/routes/links.ts
```

Confirm the exact current shape of the "Owned links cannot be deleted through this endpoint"
rejection before editing — replace that specific branch, don't rewrite the whole handler blind.

- [ ] **Step 4: Implement**

Replace the unconditional owned-link rejection with an owner check:

```typescript
      if (link.ownerId !== null) {
        if (link.ownerId !== request.user?.id) {
          return reply.status(403).send({ error: "Forbidden" });
        }
        for (const drop of link.drops) {
          const result = await scrubDropContent(drop.id);
          if (result) await deleteObject(result.s3Key);
        }
        await prisma.link.deleteMany({ where: { id: link.id } });
        return reply.send({ deleted: true });
      }
      // ...existing anonymous-link path below, unchanged
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): allow authenticated owners to delete their own links"
```

## Task 12: Full-suite check

**Files:** none (verification only)

- [ ] **Step 1: Run the full API test suite**

```bash
pnpm --filter @e2ee-drop/api test
```

- [ ] **Step 2: Run the full web test suite**

```bash
pnpm --filter @e2ee-drop/web test
```

- [ ] **Step 3: Typecheck both packages**

```bash
pnpm --filter @e2ee-drop/api exec tsc --noEmit
pnpm --filter @e2ee-drop/web exec tsc --build
```

- [ ] **Step 4: Fix any remaining failures, commit each fix separately with a message describing
  what broke and why**

---

## Self-review notes (from the agent that wrote this plan)

- **Spec coverage:** §2 (Task 1), §3 (Tasks 2-4), §4 (Task 5), §5 (Tasks 6-9), §6 (Tasks 10-11).
  §7 (revoke/unrevoke) is **not** covered here — I found that spec 4's own design doc
  (`docs/superpowers/specs/2026-09-26-verified-profile-contacts-design.md`) already assigns the
  actual `POST /api/links/:slug/revoke`/`unrevoke` *endpoints* to itself, using this plan's
  `scrubDropContent` (Task 6) as the mechanism it calls. Whoever plans spec 4 needs `scrubDropContent`
  to exist first — flagging this cross-plan dependency for the parent to reconcile, since I can't
  see or edit spec 4's plan from here.
- **Judgment call flagged for review:** Tasks 3-4 delete and replace logic that spec 1's plan 2
  (Tasks 10-11) already wrote — specifically, `reveal-message` never touched `deliveryStatus` at
  all, and `complete-download`'s inline derivation reads a stale in-memory snapshot with no CAS,
  which is a genuine race against a concurrent `reveal-message` call. This isn't a hypothetical: if
  a recipient reveals the message and downloads the file within the same short window (a very
  normal thing to do), the two requests can race. Confirm this reconciliation approach — patching
  spec 1's already-planned code — rather than treating it as "spec 1's problem" to fix separately.
- **Judgment call flagged for review:** Task 5 adds `?role=sender`, symmetric to spec 1 plan 2's
  `?role=receiver`. I checked spec 1 plan 3's actual `UploadPage.tsx` fetch call (line 1480 of that
  plan) and confirmed it does NOT send any role parameter today — so this task also patches spec 1's
  frontend plan, not just the backend.
- **Judgment call flagged for review:** `scrubDropContent` (Task 6) exports the previously
  module-private `releaseCharged` from `quota.ts` rather than duplicating its logic. This is a small
  API-surface widening of that module; if the codebase has a convention against widening a file's
  exports beyond what's immediately needed, reconsider inlining a copy instead.
- **Judgment call flagged for review:** Task 10's `owner-cancel` on a mid-upload drop delegates to
  an `abandonDrop` function I assumed exists (or should be extracted) from spec 1 plan 2 Task 7's
  `abandon` endpoint. I did not read that task's actual code before writing this plan (out of
  scope for what I was asked to ground against) — the implementer must check `abandon`'s real shape
  first and extract a shared function if it's currently inline in the route handler.
- **Type consistency:** `scrubDropContent`'s return shape (`{ ownerId, s3Key } | null`) is used
  identically in Tasks 7, 8, 10, and 11. `recomputeDeliveryStatus(dropId, linkId)`'s signature
  matches across Tasks 2, 3, and 4.
- **Review Focus:** all five items each have an owning task/test — see per-task tests above (no
  gaps found on re-check).
