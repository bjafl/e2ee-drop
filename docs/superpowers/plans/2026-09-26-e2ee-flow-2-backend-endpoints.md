# E2EE flow — Plan 2/3: Backend endpoints

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every new/changed API route from the design spec on top of plan 1's schema and
helpers: three-envelope upload, sender-identity verification, the abandon/reveal-message/
complete-download/download-failed lifecycle, the claim flow, and retention validation.

**Architecture:** Route handlers stay in their existing files (`uploads.ts`, `downloads.ts`,
`links.ts`) and keep every existing correctness property (CAS updates, Serializable transactions
for one-time links, owner-row locking, per-sender reservation caps) — this plan changes *which
columns* those mechanisms operate on, not the mechanisms themselves. New endpoints follow the same
patterns already established by their neighbors (scoped by `linkId`, CAS via `updateMany`, generic
"not found" responses that don't distinguish "wrong state" from "doesn't exist" where the existing
code already does that for security reasons).

**Tech Stack:** Fastify, Prisma, existing `lib/quota.ts`/`lib/links.ts`/`lib/storage.ts`.

**Spec:** `docs/superpowers/specs/2026-09-26-e2ee-send-receive-flow-design.md`

**Plan sequence:** Plan 2 of 3. Requires plan 1 (`2026-09-26-e2ee-flow-1-backend-foundation.md`)
merged first — every task below assumes `Drop.fileUploadStatus`/`deliveryStatus`/
`messageEnvelopeStatus`/`fileEnvelopeStatus`, `Link.retentionDays` (NOT NULL) and
`Link.recipientPublicKey` (nullable) already exist, and that `toDropSummary`/`toLinkStatusResponse`/
`transitionFileUploadStatus` already have their plan-1 signatures. Plan 3 (frontend) requires this
plan merged first.

## Global Constraints

- Every existing CAS (`updateMany` guarded by a `where` status clause) must stay a single atomic
  `updateMany` — never a read-then-write.
- Every existing "don't distinguish wrong-state from not-found" response (documented inline in the
  current code, e.g. `transitionFileUploadStatus`/`transitionDropStatus`'s doc comment) must be
  preserved for the same reason: a drop id is not secret to a link holder, so a more specific error
  would leak information the current design deliberately withholds.
- No new endpoint may skip the existing rate limiting/auth patterns its neighbors use (see
  `apps/api/src/lib/rateLimit.ts` for the existing limiters and their stated keying rationale).
- `POST /api/links/:slug/upload-url`'s owned-link Serializable/row-lock transaction structure and
  lock ordering (User → Link → Drop) must not change.

## Review Focus

- **`GET /api/links/:slug` called by both the sender's and the receiver's page**: this single
  endpoint serves `/send/:slug` and `/receive/:slug` today (and after this plan). Nothing in the
  request distinguishes which page is asking — a naive implementation of "set `receiver_opened` on
  GET" would also fire when the *sender* re-polls their own link's status, corrupting the delivery
  history. Needs an explicit signal from the caller (see Task 3).
- **A sender who never finishes selecting a file abandoning cleanly vs. crashing**: the new
  `/abandon` endpoint (Task 5) only covers the case where the client is still alive to call it — a
  closed tab or crashed browser leaves a `Drop` row in `fileUploadStatus: "uploading"` forever
  unless a passive sweep also exists (Task 8) — today's codebase has *no* such sweep at all (only
  `sweepExpiredDrops`, scoped to `mode: "permanent"` and keyed off `retentionDays`, not upload
  status), so this is a gap in the current system, not just something the new UI relies on.
- **A `senderPublicKey` a logged-in sender's client didn't actually generate from their own account
  key**: without Task 4's check, an authenticated upload can claim `senderUserId` (spec 5's inbox
  will display it) while presenting a `senderPublicKey` that doesn't match — decrypts fine (it's a
  real keypair) but attributes the content to the wrong displayed identity.
- **Integrity check ordering on `/complete-download`**: the design spec is explicit that a hash
  mismatch must NOT delete the object, and a hash match must delete it regardless of whether
  decryption later succeeds. A handler that deletes first and validates after (or that conflates
  "the client says it decrypted fine" with "the hash matched") inverts the safety property this
  endpoint exists for.
- **A one-time link's single-drop invariant surviving `/abandon`**: `/abandon` deletes the `Drop`
  row outright specifically so a retry's `upload-url` call sees zero existing drops again — a
  version that only flips a status flag instead of deleting the row would leave the one-time link
  permanently stuck (the existing `link.mode === "one-time" && link.drops.length > 0` fast-path
  check, and the Serializable transaction's `tx.drop.count`, both count *any* row regardless of
  status).

---

## Task 1: `apps/api/src/env.ts` — sanity-check retention env (depends on plan 1 Task 5)

**Files:** none new — this task is a checkpoint, not a code change.

- [ ] **Step 1: Confirm plan 1's env vars exist**

```bash
grep -n "DROP_RETENTION_DAYS_DEFAULT\|DROP_RETENTION_DAYS_MAX" apps/api/src/env.ts
```

Expected: both present. If not, stop — plan 1 wasn't fully merged; do not proceed with this plan.

## Task 2: Retention validation helper

**Files:**
- Create: `apps/api/src/lib/retention.ts`
- Test: `apps/api/src/lib/retention.test.ts`

**Interfaces:**
- Produces: `resolveRetentionDays(requested: number | null | undefined, expiresAt: Date | null): number | { error: string }` — used by Task 3's link-creation routes and Task 6 (request-link route).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/lib/retention.test.ts
import { describe, it, expect } from "vitest";
import { resolveRetentionDays } from "./retention";
import { env } from "../env";

describe("resolveRetentionDays", () => {
  it("defaults to DROP_RETENTION_DAYS_DEFAULT when omitted", () => {
    expect(resolveRetentionDays(undefined, null)).toBe(env.DROP_RETENTION_DAYS_DEFAULT);
    expect(resolveRetentionDays(null, null)).toBe(env.DROP_RETENTION_DAYS_DEFAULT);
  });

  it("accepts an explicit value at or below the max, for a permanent link (no expiry)", () => {
    expect(resolveRetentionDays(env.DROP_RETENTION_DAYS_MAX, null)).toBe(env.DROP_RETENTION_DAYS_MAX);
  });

  it("rejects a value above DROP_RETENTION_DAYS_MAX", () => {
    const result = resolveRetentionDays(env.DROP_RETENTION_DAYS_MAX + 1, null);
    expect(result).toEqual({ error: expect.stringContaining("retentionDays") });
  });

  it("rejects a value above the link's own expiry duration", () => {
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h from now, i.e. < 1 day
    const result = resolveRetentionDays(1, expiresAt);
    expect(result).toEqual({ error: expect.stringContaining("retentionDays") });
  });

  it("accepts a value equal to the link's own expiry duration, rounded up", () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // exactly 1 day from now
    expect(resolveRetentionDays(1, expiresAt)).toBe(1);
  });

  it("rejects zero, negative, and non-integer values", () => {
    expect(resolveRetentionDays(0, null)).toEqual({ error: expect.any(String) });
    expect(resolveRetentionDays(-1, null)).toEqual({ error: expect.any(String) });
    expect(resolveRetentionDays(1.5, null)).toEqual({ error: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/retention.test.ts
```

Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/lib/retention.ts
//
// Design spec §4.4: retentionDays is always resolved to a concrete value at link creation —
// never left to a later silent env-var fallback (that fallback existed before this file, in
// jobs/cleanup.ts's sweepExpiredDrops, and was removed by plan 1 Task 5 once Link.retentionDays
// became NOT NULL). It must never exceed DROP_RETENTION_DAYS_MAX, and never exceed the link's own
// expiry (a one-time link's content cannot outlive the link itself).
import { env } from "../env";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function resolveRetentionDays(
  requested: number | null | undefined,
  expiresAt: Date | null
): number | { error: string } {
  const maxByExpiry = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / MS_PER_DAY) : Infinity;
  const ceiling = Math.min(env.DROP_RETENTION_DAYS_MAX, maxByExpiry);

  if (requested === null || requested === undefined) {
    return Math.min(env.DROP_RETENTION_DAYS_DEFAULT, ceiling);
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return { error: "retentionDays must be a positive whole number of days" };
  }
  if (requested > ceiling) {
    return {
      error:
        maxByExpiry < env.DROP_RETENTION_DAYS_MAX
          ? "retentionDays cannot exceed the link's own expiry"
          : `retentionDays cannot exceed ${env.DROP_RETENTION_DAYS_MAX}`,
    };
  }
  return requested;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/retention.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/retention.ts apps/api/src/lib/retention.test.ts
git commit -m "feat(api): add retentionDays resolution/validation shared by all link-creation routes"
```

## Task 3: `POST /api/links` and `POST /api/links/custom` — retention + ownerNote

**Files:**
- Modify: `apps/api/src/routes/links.ts:22-53` (POST /api/links), `:62-151` (POST /api/links/custom)
- Modify: `apps/api/src/lib/links.ts` (`createOneTimeLink` call site, already changed shape in plan 1 Task 4 Step 4)

**Interfaces:**
- Consumes: `resolveRetentionDays` (Task 2), `CreateLinkRequest`/`CreateCustomLinkRequest` with
  `ownerNote`/`retentionDays` (plan 1 Task 2).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/links.test.ts` (existing file — check current test setup pattern
first with `head -40 apps/api/src/routes/links.test.ts` and match its `server.inject` style):

```typescript
it("rejects retentionDays above the anonymous one-time link's own expiry", async () => {
  const res = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "pk", retentionDays: 999 },
  });
  expect(res.statusCode).toBe(400);
});

it("stores ownerNote on an anonymous link and returns it from GET", async () => {
  const create = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "pk", ownerNote: "please send the invoice" },
  });
  expect(create.statusCode).toBe(200);
  const { slug } = create.json();
  const get = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(get.json().ownerNote).toBe("please send the invoice");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 3: Update `POST /api/links`**

```typescript
server.post<{ Body: CreateLinkRequest }>(
  "/api/links",
  {
    schema: {
      body: {
        type: "object",
        properties: {
          recipientPublicKey: { type: "string" },
          locale: { type: ["string", "null"] },
          ownerNote: { type: ["string", "null"] },
          retentionDays: { type: ["integer", "null"] },
        },
      },
    },
  },
  async (request, reply) => {
    const { recipientPublicKey, locale, ownerNote, retentionDays } = request.body;
    if (!recipientPublicKey) {
      return reply.status(400).send({ error: "Missing recipientPublicKey" });
    }
    // A one-time link's own expiry is fixed by LINK_EXPIRY_HOURS; resolve retentionDays
    // against that same window before the link is created (createOneTimeLink no longer
    // accepts an out-of-range value implicitly, since Link.retentionDays is NOT NULL).
    const provisionalExpiresAt = new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000);
    const resolvedRetention = resolveRetentionDays(retentionDays, provisionalExpiresAt);
    if (typeof resolvedRetention !== "number") {
      return reply.status(400).send(resolvedRetention);
    }
    const link = await createOneTimeLink(recipientPublicKey, resolvedRetention, locale, ownerNote ?? undefined);
    if (!link.expiresAt) throw new Error("one-time link created without expiresAt");
    const body: CreateLinkResponse = {
      linkId: link.id,
      slug: link.slug,
      codewords: deriveCodewords(link.recipientPublicKey!, resolveLocale(link.codewordLocale), CODEWORD_MAX_COUNT),
      expiresAt: link.expiresAt.getTime(),
    };
    return reply.send(body);
  }
);
```

Update `createOneTimeLink` (plan 1 Task 4 already added the `retentionDays` param; add `ownerNote`
too):

```typescript
// apps/api/src/lib/links.ts
export async function createOneTimeLink(
  recipientPublicKey: string,
  retentionDays: number,
  locale?: string,
  ownerNote?: string
): Promise<Link> {
  return prisma.link.create({
    data: {
      slug: nanoid(),
      mode: "one-time",
      recipientPublicKey,
      retentionDays,
      ownerNote,
      codewordLocale: resolveLocale(locale),
      expiresAt: new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000),
    },
  });
}
```

Add the import in `links.ts` (route file): `import { resolveRetentionDays } from "../lib/retention";`

- [ ] **Step 4: Update `POST /api/links/custom`**

Replace the existing `retentionDays` inline validation (lines 93-104) and the `data` object's
`retentionDays: retentionDays ?? null` (line 124) with:

```typescript
      const provisionalExpiresAt =
        mode === "one-time" ? new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000) : null;
      const resolvedRetention = resolveRetentionDays(retentionDays, provisionalExpiresAt);
      if (typeof resolvedRetention !== "number") {
        return reply.status(400).send(resolvedRetention);
      }
```

(remove the now-redundant `MAX_RETENTION_DAYS` constant and its inline check — `resolveRetentionDays`
subsumes it) and in the `prisma.link.create` call:

```typescript
          data: {
            ownerId: owner.id,
            slug,
            mode,
            visibility: visibility ?? "public",
            retentionDays: resolvedRetention,
            ownerNote: request.body.ownerNote ?? undefined,
            recipientPublicKey: owner.publicKey,
            expiresAt: provisionalExpiresAt,
          },
```

Add `ownerNote: { type: ["string", "null"] }` to this route's `schema.body.properties`.

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/links.ts apps/api/src/lib/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): validate retentionDays and accept ownerNote on link creation"
```

## Task 4: Sender-identity binding check

**Files:**
- Create: `apps/api/src/lib/senderIdentity.ts`
- Test: `apps/api/src/lib/senderIdentity.test.ts`

**Interfaces:**
- Produces: `assertSenderIdentity(user: { publicKey: string } | null, claimedPublicKey: string): void`
  (throws `SenderIdentityMismatchError`) — consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/lib/senderIdentity.test.ts
import { describe, it, expect } from "vitest";
import { assertSenderIdentity, SenderIdentityMismatchError } from "./senderIdentity";

describe("assertSenderIdentity", () => {
  it("passes when the authenticated user's publicKey matches the claim", () => {
    expect(() => assertSenderIdentity({ publicKey: "pk-1" }, "pk-1")).not.toThrow();
  });

  it("throws when the authenticated user's publicKey does not match the claim", () => {
    expect(() => assertSenderIdentity({ publicKey: "pk-1" }, "pk-2")).toThrow(SenderIdentityMismatchError);
  });

  it("passes for an anonymous sender (no session) regardless of the claimed key", () => {
    expect(() => assertSenderIdentity(null, "anything")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/senderIdentity.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/lib/senderIdentity.ts
//
// Design spec §3.2: Drop.senderUserId (set below in uploads.ts when a session is present) has no
// cryptographic binding to Drop.senderPublicKey on its own — nacl.box authenticates the
// ciphertext against whatever key is CLAIMED, not against any particular account. Without this
// check, a divergent senderPublicKey/senderUserId pair would let the inbox (spec 5) display a
// different account's name than the one that actually produced the ciphertext. Anonymous senders
// (no session) make no identity claim at all, so nothing to check.
export class SenderIdentityMismatchError extends Error {
  constructor() {
    super("senderPublicKey does not match the authenticated account's public key");
  }
}

export function assertSenderIdentity(
  user: { publicKey: string } | null,
  claimedPublicKey: string
): void {
  if (user && user.publicKey !== claimedPublicKey) {
    throw new SenderIdentityMismatchError();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/lib/senderIdentity.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/senderIdentity.ts apps/api/src/lib/senderIdentity.test.ts
git commit -m "feat(api): add sender-identity binding check for authenticated uploads"
```

## Task 5: `POST /api/links/:slug/upload-url` — three-envelope body + identity check

**Files:**
- Modify: `apps/api/src/routes/uploads.ts:72-254`

**Interfaces:**
- Consumes: `RequestUploadUrlRequest` (plan 1 Task 2 — new shape), `assertSenderIdentity` (Task 4).
- Produces: `RequestUploadUrlResponse` unchanged (`{ dropId, uploadUrl }`).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/uploads.test.ts` (existing file):

```typescript
it("accepts a drop with no message envelope", async () => {
  // ...create a link via the test helpers already in this file, then:
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: {
      senderPublicKey: "sender-pk",
      encryptedMetadata: "meta-cipher",
      metadataNonce: "meta-nonce",
      metadata: { fileSize: 1024, contentMD5: "hash" },
    },
  });
  expect(res.statusCode).toBe(200);
});

it("rejects an authenticated upload whose senderPublicKey doesn't match the account", async () => {
  // ...log in as a test user (see existing auth test helpers in this file/adjacent test files)
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    headers: { cookie: sessionCookie },
    payload: {
      senderPublicKey: "not-the-users-key",
      encryptedMetadata: "meta-cipher",
      metadataNonce: "meta-nonce",
      metadata: { fileSize: 1024, contentMD5: "hash" },
    },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/uploads.test.ts
```

- [ ] **Step 3: Rewrite the handler**

Replace the request schema (lines 77-95):

```typescript
      schema: {
        body: {
          type: "object",
          properties: {
            senderPublicKey: { type: "string" },
            encryptedMessage: { type: ["string", "null"] },
            messageNonce: { type: ["string", "null"] },
            encryptedMetadata: { type: "string" },
            metadataNonce: { type: "string" },
            metadata: {
              type: "object",
              properties: {
                fileSize: { type: "integer" },
                contentMD5: { type: "string" },
              },
            },
          },
        },
      },
```

Remove `sanitizeMessage`/`MAX_MESSAGE_LENGTH` (lines 25, 54-59) — the message is now opaque
ciphertext the server never reads, so there is nothing left to sanitize.

Replace the body-destructure and validation (lines 119-134):

```typescript
      if (!request.body) {
        return reply.status(400).send({ error: "Missing metadata" });
      }
      const { senderPublicKey, encryptedMessage, messageNonce, encryptedMetadata, metadataNonce, metadata } =
        request.body;
      if (
        !senderPublicKey ||
        !encryptedMetadata ||
        !metadataNonce ||
        !metadata?.contentMD5 ||
        !metadata?.fileSize
      ) {
        return reply.status(400).send({ error: "Missing metadata" });
      }
      if ((encryptedMessage && !messageNonce) || (!encryptedMessage && messageNonce)) {
        return reply.status(400).send({ error: "encryptedMessage and messageNonce must be provided together" });
      }
      if (!Number.isSafeInteger(metadata.fileSize) || metadata.fileSize <= 0) {
        return reply.status(400).send({ error: "Invalid fileSize" });
      }
      if (metadata.fileSize > env.MAX_FILE_SIZE_BYTES) {
        return reply.status(413).send({ error: `File too large (max ${env.MAX_FILE_SIZE_BYTES} bytes)` });
      }
      try {
        assertSenderIdentity(request.user, senderPublicKey);
      } catch (err) {
        if (err instanceof SenderIdentityMismatchError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
```

Replace the `dropData` construction (lines 136-151):

```typescript
      const dropId = nanoid();
      const s3Key = `${link.id}/${dropId}`;

      const dropData: Prisma.DropUncheckedCreateInput = {
        id: dropId,
        linkId: link.id,
        senderPublicKey,
        senderUserId: request.user?.id,
        s3Key,
        archiveNonce: metadata.nonce, // NOTE: see Step 4 below — metadata.nonce is renamed
        encryptedMessage: encryptedMessage ?? undefined,
        messageNonce: messageNonce ?? undefined,
        encryptedMetadata,
        metadataNonce,
        fileSize: metadata.fileSize,
        contentMD5: metadata.contentMD5,
        fileUploadStatus: "uploading",
      };
```

Wait — `metadata.nonce` doesn't exist in the new `RequestUploadUrlRequest` shape (plan 1 Task 2's
`metadata` sub-object only has `fileSize`/`contentMD5`; the archive's own nonce is a separate,
top-level concept). This request never carries the *archive's* nonce at all today by this point —
the archive ciphertext and its nonce are only known once the client actually PUTs the encrypted
bytes, but the old code accepted the nonce up front alongside the metadata. Keep that: the archive
nonce is generated client-side before the PUT (same as today) and must travel in this same request
body, since there is no later call where it could otherwise reach the server. Add it back as an
explicit top-level field:

- [ ] **Step 3b: Add the missing `archiveNonce` field**

Go back to plan 1 Task 2's `RequestUploadUrlRequest` (`packages/shared/src/api.ts`) and add:

```typescript
export interface RequestUploadUrlRequest {
  senderPublicKey: string;
  archiveNonce: string; // base64 — the file archive's own nonce, generated client-side before the PUT
  encryptedMessage?: string;
  messageNonce?: string;
  encryptedMetadata: string;
  metadataNonce: string;
  metadata: {
    fileSize: number;
    contentMD5: string;
  };
}
```

Then use `request.body.archiveNonce` (not `metadata.nonce`) in the handler above:

```typescript
        archiveNonce,
```

(destructure `archiveNonce` alongside the other fields in Step 3's destructuring line, and add
`archiveNonce: { type: "string" }` to the schema, and `if (!archiveNonce) return ... "Missing metadata"`
to the validation.)

- [ ] **Step 4: Update the three insertion branches**

The owned-link branch, anonymous-permanent branch, and anonymous-one-time branch (lines 153-211)
are unchanged in *structure* — they still lock the owner, check quota, check sender-share, and
insert `dropData`. No line in those branches references `status`/`fileName`/`message` directly
(they operate on `dropData` as a whole and on `metadata.fileSize`, which still exists under the
same name), so no further edit is needed there beyond what `dropData`'s new shape (Step 3) already
provides.

- [ ] **Step 5: Update `toDropSummary` call and imports**

Line 248's `emitDropEvent(link.id, { type: "drop-created", drop: toDropSummary(created) })` now
needs the link for `contentExpiresAt` (plan 1 Task 4's new `toDropSummary` signature):

```typescript
      emitDropEvent(link.id, { type: "drop-created", drop: toDropSummary(created, link) });
```

Add imports: `import { assertSenderIdentity, SenderIdentityMismatchError } from "../lib/senderIdentity";`

- [ ] **Step 6: Run to verify tests pass**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/uploads.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/uploads.ts packages/shared/src/api.ts apps/api/src/routes/uploads.test.ts
git commit -m "feat(api): accept three-envelope upload body, verify sender identity"
```

## Task 6: `POST .../drops/:dropId/complete` — port to `fileUploadStatus`

**Files:**
- Modify: `apps/api/src/routes/uploads.ts:256-372`

**Interfaces:**
- Consumes: `transitionFileUploadStatus` is NOT used here directly (the owned-link branch does its
  own inline CAS combined with the quota charge, as today) — only the anonymous branch calls a
  shared helper.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/uploads.test.ts`:

```typescript
it("sets deliveryStatus to sent when complete succeeds", async () => {
  // ...create link, call upload-url, PUT the object (or mock objectHasSize as the existing
  // tests already do — check the file for the existing mocking pattern before duplicating it)
  const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
  expect(res.statusCode).toBe(200);
  const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(status.json().drop.deliveryStatus).toBe("sent");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/uploads.test.ts
```

- [ ] **Step 3: Update the handler**

Line 264-267, the initial fetch's `select`:

```typescript
      const drop = await prisma.drop.findFirst({
        where: { id: dropId, linkId: link.id },
        select: { fileUploadStatus: true, s3Key: true, fileSize: true },
      });
```

Line 31-33, `isCompletedStatus`:

```typescript
function isCompletedStatus(fileUploadStatus: string): boolean {
  return fileUploadStatus === "complete";
}
```

Line 27-29's `COMPLETED_STATUSES` constant is deleted (no longer needed — there's only one
completed value now, `"complete"`).

Line 275: `if (isCompletedStatus(drop.status))` → `if (isCompletedStatus(drop.fileUploadStatus))`.

Anonymous branch (line 300-309):

```typescript
        updated = await transitionFileUploadStatus(dropId, link.id, ["uploading"], "complete");
        if (updated) {
          await prisma.drop.update({ where: { id: dropId }, data: { deliveryStatus: "sent" } });
        }
```

(import `transitionFileUploadStatus` instead of `transitionDropStatus`.)

Owned branch (lines 328-346), inside the transaction:

```typescript
        const outcome = await prisma.$transaction(async (tx) => {
          if (!(await lockOwnerQuota(tx, ownerId))) return "not-found" as const;
          const { count } = await tx.drop.updateMany({
            where: {
              id: dropId,
              linkId: link.id,
              fileUploadStatus: "uploading",
              createdAt: { gt: reservationCutoff() },
            },
            data: { fileUploadStatus: "complete", deliveryStatus: "sent", reservationSenderKey: null },
          });
          if (count !== 1) return "lost" as const;
          await tx.user.update({
            where: { id: ownerId },
            data: { storageUsedBytes: { increment: chargedBytes(drop.fileSize) } },
          });
          return "completed" as const;
        }, QUOTA_TX_OPTIONS);
```

Line 353's re-read on lost CAS: `select: { status: true }` → `select: { fileUploadStatus: true } }`,
and line 357's check → `if (isCompletedStatus(current.fileUploadStatus))`.

Line 365-367's SSE emission needs the link for `toDropSummary`'s new signature and the new status
fields:

```typescript
      const snapshot = link.drops.find((candidate) => candidate.id === dropId);
      if (snapshot) {
        emitDropEvent(link.id, {
          type: "drop-updated",
          drop: toDropSummary({ ...snapshot, fileUploadStatus: "complete", deliveryStatus: "sent" }, link),
        });
      }
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/uploads.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/uploads.ts apps/api/src/routes/uploads.test.ts
git commit -m "refactor(api): port /complete to fileUploadStatus, set deliveryStatus sent"
```

## Task 7: `POST .../drops/:dropId/abandon`

**Files:**
- Modify: `apps/api/src/routes/uploads.ts` (add new route inside `registerUploadRoutes`)

**Interfaces:**
- Produces: `POST /api/links/:slug/drops/:dropId/abandon` → `{ abandoned: boolean }`.

- [ ] **Step 1: Write the failing test**

```typescript
it("abandon deletes a still-uploading drop and frees a one-time link's slot", async () => {
  // create a one-time link, call upload-url (creates a Drop, fileUploadStatus "uploading")
  const abandon = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/abandon`,
  });
  expect(abandon.statusCode).toBe(200);
  // a fresh upload-url call must now succeed again (the slot was freed)
  const retry = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: { /* ...same valid payload as Task 5's tests... */ },
  });
  expect(retry.statusCode).toBe(200);
});

it("abandon does nothing to an already-complete drop", async () => {
  // ...upload-url, then complete, then:
  const res = await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/abandon` });
  expect(res.json()).toEqual({ abandoned: false });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/uploads.test.ts
```

- [ ] **Step 3: Implement**

Add inside `registerUploadRoutes`, after the `/complete` route:

```typescript
  // Design spec §5.1: a sender whose upload PUT fails or is abandoned gets a clean slate, not a
  // resumed attempt — this deletes the reservation outright (message envelope included) rather
  // than leaving a stale "uploading" row that would block a one-time link's single-drop slot
  // until the passive sweep (Task 8) eventually catches it, up to an hour later.
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/abandon",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      const { dropId } = request.params;
      // Same CAS discipline as everywhere else: only a drop still "uploading" for THIS link is
      // eligible, so a late abandon call on an already-completed drop is a harmless no-op, never
      // a race that deletes real, delivered content.
      const { count } = await prisma.drop.deleteMany({
        where: { id: dropId, linkId: link.id, fileUploadStatus: "uploading" },
      });
      return reply.send({ abandoned: count === 1 });
    }
  );
```

No quota release call is needed here: an "uploading" drop was never charged (`isChargedStatus`
returns `false` for it), so there is nothing to release — deleting the row is sufficient.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/uploads.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/uploads.ts apps/api/src/routes/uploads.test.ts
git commit -m "feat(api): add abandon endpoint for interrupted uploads"
```

## Task 8: Passive sweep for abandoned uploads (new — no equivalent exists today)

**Files:**
- Modify: `apps/api/src/jobs/cleanup.ts`
- Test: `apps/api/src/jobs/cleanup.test.ts` (check if it exists; create if not, matching the
  existing test file's setup for `runCleanup`/`sweepExpiredDrops` if one exists — otherwise use the
  same `server`/Prisma test-database pattern as `uploads.test.ts`)

**Interfaces:**
- Produces: `sweepAbandonedUploads(): Promise<{ deletedDrops: number }>`, called from `main()`
  alongside the existing three sweeps.

- [ ] **Step 1: Write the failing test**

```typescript
it("sweepAbandonedUploads deletes a stale uploading drop past the reservation window", async () => {
  // Insert a Drop directly via prisma with fileUploadStatus "uploading" and createdAt far in the
  // past (older than UPLOAD_RESERVATION_WINDOW_MS from lib/quota.ts).
  const result = await sweepAbandonedUploads();
  expect(result.deletedDrops).toBe(1);
});

it("does not touch a recent uploading drop still inside its reservation window", async () => {
  // Insert a Drop with createdAt = now.
  const result = await sweepAbandonedUploads();
  expect(result.deletedDrops).toBe(0);
});

it("does not touch a complete drop regardless of age", async () => {
  // Insert a Drop with fileUploadStatus "complete" and an old createdAt.
  const result = await sweepAbandonedUploads();
  expect(result.deletedDrops).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/jobs/cleanup.ts — add:
import { reservationCutoff } from "../lib/quota";

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
```

Add it to `main()`'s loop, alongside the existing three:

```typescript
      const abandonedResult = await sweepAbandonedUploads();
      console.log(
        `[cleanup] removed ${linkResult.deletedLinks} expired link(s), ${dropResult.deletedDrops} expired drop(s), ` +
          `${abandonedResult.deletedDrops} abandoned upload(s), ${tokenResult.deletedTokens} expired password-reset token(s)`
      );
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/jobs/cleanup.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/cleanup.ts apps/api/src/jobs/cleanup.test.ts
git commit -m "feat(api): sweep abandoned uploads that were never explicitly abandoned or completed"
```

## Task 9: `POST /api/links/:slug/mark-receiver-opened` — dedicated action, replaces `role=` param

**Amended per explicit user direction** (not a judgment call): the original design for this task
used a client-supplied, unauthenticated `?role=receiver` query parameter on the shared `GET
/api/links/:slug` — a sender could pass `?role=receiver` on their own request and mark their own
drop "opened" prematurely. The user rejected this and asked for a stronger mechanism. Resolution
agreed with the user:
- **Owned links**: role is derivable server-side from session identity
  (`request.user?.id === link.ownerId`) with no client input at all — not applicable to *this*
  task though, since (as the original design already noted) an owned link's queue is read via the
  separate owner-gated `GET /drops` route, not this one.
- **Anonymous links**: there is no session to check, so role can never be more strongly
  authenticated than "which action the client deliberately chose to call" (the same fundamental
  limit as any client-reported signal in this app). Fix: drop the query param entirely and give
  the receive side its own dedicated, single-purpose endpoint instead of an ambiguous flag on the
  shared read. This doesn't make the signal cryptographically provable (nothing could, for an
  anonymous link with no account behind it), but it narrows the surface from "flip a param on any
  GET" to "call the one endpoint whose entire purpose is this action."

**Files:**
- Modify: `apps/api/src/routes/links.ts` — add the new route; `GET /api/links/:slug` itself
  (`:153-162`) is unchanged from today (no query param, no side effect — reverts to a pure read).

**Interfaces:**
- New route: `POST /api/links/:slug/mark-receiver-opened`. No auth required (matches the
  unauthenticated nature of an anonymous link's receive side). No body.
- Produces: sets `Drop.deliveryStatus` from `"sent"` to `"receiver_opened"` (CAS, one-way), only
  for the single-drop anonymous-link case (`link.ownerId === null`) — an owned permanent link's
  queue view remains spec 5's concern, unchanged from the original design's scope.
- **Cross-plan note**: `docs/superpowers/plans/2026-09-26-e2ee-flow-3-frontend.md` (Task 12,
  `ReceivePage.tsx`) currently calls `fetch(`/api/links/${slug}?role=receiver`)` in three places —
  those call sites need to change to a plain `GET /api/links/:slug` plus a separate
  `POST .../mark-receiver-opened` call. That file is out of this amendment's scope; flag it
  separately to whoever implements plan 3.

- [ ] **Step 1: Write the failing test**

```typescript
it("POST mark-receiver-opened advances deliveryStatus from sent to receiver_opened", async () => {
  // ...create link, upload-url, complete (deliveryStatus now "sent")
  await server.inject({ method: "POST", url: `/api/links/${slug}/mark-receiver-opened` });
  const res = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(res.json().drop.deliveryStatus).toBe("receiver_opened");
});

it("plain GET never advances deliveryStatus on its own", async () => {
  // ...same setup
  await server.inject({ method: "GET", url: `/api/links/${slug}` });
  const res = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(res.json().drop.deliveryStatus).toBe("sent");
});

it("mark-receiver-opened is a no-op for an owned link", async () => {
  // ...owned link, drop "sent" — the owner's queue view (spec 5) governs this case instead
  await server.inject({ method: "POST", url: `/api/links/${ownedSlug}/mark-receiver-opened` });
  const res = await server.inject({ method: "GET", url: `/api/links/${ownedSlug}/drops` }, { headers: authHeaders });
  expect(res.json().drops[0].deliveryStatus).toBe("sent");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 3: Implement**

```typescript
  // GET /api/links/:slug is unchanged from today — no query param, no side effect.

  server.post<{ Params: { slug: string } }>(
    "/api/links/:slug/mark-receiver-opened",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      // Anonymous/one-time link's single drop only (design spec §6.1) — an owned link's queue is
      // read via the separate owner-gated GET /drops route, which spec 5 will extend similarly.
      if (link.ownerId === null) {
        const drop = link.drops[0];
        if (drop) {
          await prisma.drop.updateMany({
            where: { id: drop.id, linkId: link.id, deliveryStatus: "sent" },
            data: { deliveryStatus: "receiver_opened" },
          });
        }
      }
      return reply.send({ acknowledged: true });
    }
  );
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): add mark-receiver-opened action, replacing spoofable role= query param"
```

## Task 10: `POST .../drops/:dropId/reveal-message`

**Files:**
- Modify: `apps/api/src/routes/downloads.ts` (add new route)

**Interfaces:**
- Produces: `POST /api/links/:slug/drops/:dropId/reveal-message` → `RevealMessageResponse` (plan 1
  Task 2) or 404/409.

- [ ] **Step 1: Write the failing tests**

```typescript
it("reveals the message once and scrubs it", async () => {
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ encryptedMessage: expect.any(String), messageNonce: expect.any(String) });

  const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(status.json().drop.hasMessage).toBe(false);
});

it("a second reveal call fails", async () => {
  await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/reveal-message` });
  const second = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
  });
  expect(second.statusCode).toBe(409);
});

it("404s for a drop with no message", async () => {
  // ...a drop created without encryptedMessage
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/reveal-message`,
  });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 3: Implement**

```typescript
  // Design spec §6.2: a one-time reveal. The atomic UPDATE ... WHERE below is the only place a
  // message can be revealed — it returns the ciphertext AND scrubs the columns in the same
  // statement, so a second call (or two racing calls) sees encryptedMessage already NULL and
  // matches zero rows, never returning the same message twice or losing it to a lost race.
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/reveal-message",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      const { dropId } = request.params;

      const drop = link.drops.find((candidate) => candidate.id === dropId);
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      if (drop.encryptedMessage === null) {
        return reply.status(404).send({ error: "This drop has no message" });
      }

      // Snapshot the ciphertext BEFORE the CAS clears it — updateMany doesn't return row data.
      const { encryptedMessage, messageNonce } = drop;
      const { count } = await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id, encryptedMessage: { not: null } },
        data: {
          encryptedMessage: null,
          messageNonce: null,
          messageRevealedAt: new Date(),
          messageEnvelopeStatus: "delivered",
        },
      });
      if (count !== 1) {
        // Lost the race to a concurrent reveal call, or the message was already gone.
        return reply.status(409).send({ error: "Message already revealed" });
      }

      const body: RevealMessageResponse = { encryptedMessage, messageNonce: messageNonce! };
      return reply.send(body);
    }
  );
```

Add `import type { RevealMessageResponse } from "@e2ee-drop/shared";` to `downloads.ts`.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/downloads.ts apps/api/src/routes/downloads.test.ts
git commit -m "feat(api): add one-time message reveal endpoint"
```

## Task 11: `GET .../download-url` simplified + `complete-download` + `download-failed`

**Files:**
- Modify: `apps/api/src/routes/downloads.ts` (rewrite `download-url`, remove the old `/downloaded`
  route, add the two new ones)

**Interfaces:**
- Produces: `DownloadUrlResponse` (plan 1 Task 2, no `fileName`/`fileSize`/`mimeType` — those moved
  into the encrypted metadata envelope, already available via `GET /api/links/:slug`).
  `POST .../complete-download` → `{ completed: boolean }`. `POST .../download-failed` → `{ ok: true }`.

**Design note carried from the spec review:** `download-url` drops its old CAS side effect
entirely (no more `"uploaded"` → `"downloading"` marking) — the new `complete-download`/
`download-failed` pair gives strictly better signal (the client explicitly reports success or
failure, gated on the recomputed content-hash match per design spec §3.3/§6.3), so the old
intermediate marking is redundant. This also means `fileEnvelopeStatus`'s `"sealed"` value now
covers the entire "not yet resolved" span (never attempted through fully-fetched-but-not-yet-
confirmed) — there is no separate "in progress" value, matching the type as already defined in
plan 1.

- [ ] **Step 1: Write the failing tests**

```typescript
it("download-url no longer requires or advances any drop status", async () => {
  // A drop with deliveryStatus "sent" (not yet "receiver_opened") must still get a valid URL —
  // download-url performed no gating on the old "uploading" status either, so this preserves that.
  const res = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    downloadUrl: expect.any(String),
    archiveNonce: expect.any(String),
    senderPublicKey: expect.any(String),
    contentMD5: expect.any(String),
  });
});

it("complete-download marks fileEnvelopeStatus delivered and deletes the object", async () => {
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/complete-download`,
  });
  expect(res.statusCode).toBe(200);
  // deleteObject should have been called — check via the existing storage mock used elsewhere
  // in this test file, or via a direct HEAD-equivalent assertion if the test setup supports one.
});

it("download-failed marks fileEnvelopeStatus delivery_failed and does not delete the object", async () => {
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/download-failed`,
  });
  expect(res.statusCode).toBe(200);
});

it("complete-download is idempotent-safe against a second call", async () => {
  await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete-download` });
  const second = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/drops/${dropId}/complete-download`,
  });
  expect(second.statusCode).toBe(200);
  expect(second.json()).toEqual({ completed: false });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 3: Rewrite `download-url`**

```typescript
  server.get<{ Params: { slug: string }; Querystring: { dropId?: string } }>(
    "/api/links/:slug/download-url",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      if (link.ownerId && link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const { dropId } = request.query;
      const drop = dropId ? link.drops.find((candidate) => candidate.id === dropId) : link.drops[0];
      if (!drop) return reply.status(404).send({ error: "No uploaded file for this link" });
      if (drop.fileUploadStatus !== "complete") {
        return reply.status(403).send({ error: "File is not ready for download yet" });
      }

      const downloadUrl = await getSignedDownloadUrl(drop.s3Key);
      const body: DownloadUrlResponse = {
        downloadUrl,
        archiveNonce: drop.archiveNonce,
        senderPublicKey: drop.senderPublicKey,
        contentMD5: drop.contentMD5,
      };
      return reply.send(body);
    }
  );
```

- [ ] **Step 4: Replace `/downloaded` with `complete-download` and `download-failed`**

```typescript
  // Design spec §3.3/§6.3: the client has already recomputed the ciphertext hash and confirmed
  // it matches contentMD5 before calling this — deletion is gated on that match, never on
  // whether decryption (attempted client-side afterward) also succeeded.
  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/complete-download",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      if (link.ownerId && link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const { dropId } = request.params;
      const drop = link.drops.find((candidate) => candidate.id === dropId);
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      if (drop.fileEnvelopeStatus === "delivered" || drop.fileEnvelopeStatus === "shredded") {
        // Idempotent: bytes are already gone either way; report success without re-deleting.
        return reply.send({ completed: false });
      }

      await deleteObject(drop.s3Key);
      const { count } = await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id },
        data: { fileEnvelopeStatus: "delivered", contentDeletedAt: new Date() },
      });

      // Derive the overall deliveryStatus from both envelope statuses (design spec's
      // partial_delivery/delivered derivation — owned by this plan's endpoints per the design
      // spec's note that plan 1/2 write these fields even though spec 2 owns the full read side).
      const messageDone = drop.messageEnvelopeStatus === "delivered" || drop.encryptedMessage === null;
      await prisma.drop.updateMany({
        where: { id: dropId, linkId: link.id },
        data: { deliveryStatus: messageDone ? "delivered" : "partial_delivery" },
      });

      return reply.send({ completed: count === 1 });
    }
  );

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/download-failed",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      const { dropId } = request.params;
      // No CAS gate needed beyond scoping to this link+drop: marking an already-delivered drop
      // "delivery_failed" would be a lost race in the caller's own logic (it already succeeded),
      // and is harmless to overwrite here since deliveryStatus is not the source of truth for
      // whether the object still exists — fileEnvelopeStatus's terminal values are.
      if (
        link.drops.find((d) => d.id === dropId)?.fileEnvelopeStatus !== "delivered"
      ) {
        await prisma.drop.updateMany({
          where: { id: dropId, linkId: link.id },
          data: { fileEnvelopeStatus: "delivery_failed" },
        });
      }
      return reply.send({ ok: true });
    }
  );
```

Remove the old `transitionDropStatus` import (no longer used in this file) and add
`import { deleteObject } from "../lib/storage";`.

- [ ] **Step 5: Run to verify tests pass**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/downloads.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/downloads.ts apps/api/src/routes/downloads.test.ts
git commit -m "feat(api): integrity-gated download completion, drop the old downloading marker"
```

## Task 12: `POST /api/links/request` (sender-initiated flow)

**Files:**
- Modify: `apps/api/src/routes/links.ts` (add new route)

**Interfaces:**
- Consumes: `CreateRequestLinkRequest`/`CreateRequestLinkResponse` (plan 1 Task 2).

- [ ] **Step 1: Write the failing test**

```typescript
it("creates an unclaimed link owned by the authenticated user", async () => {
  const res = await server.inject({
    method: "POST",
    url: "/api/links/request",
    headers: { cookie: sessionCookie },
    payload: { ownerNote: "please claim this" },
  });
  expect(res.statusCode).toBe(200);
  const { slug } = res.json();
  const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(status.json().recipientPublicKey).toBeNull();
  expect(status.json().ownerNote).toBe("please claim this");
});

it("rejects an anonymous caller", async () => {
  const res = await server.inject({ method: "POST", url: "/api/links/request", payload: {} });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 3: Implement**

```typescript
  // Design spec §4.1: the initiator here becomes the link's owner and therefore the party
  // charged for quota once content flows (lib/quota.ts already keys everything off
  // Link.ownerId, unchanged by this endpoint) — the eventual recipient is unknown at creation
  // time and supplies their own key later via /claim (Task 13).
  server.post<{ Body: CreateRequestLinkRequest }>(
    "/api/links/request",
    {
      preHandler: server.requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            ownerNote: { type: ["string", "null"] },
            retentionDays: { type: ["integer", "null"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { ownerNote, retentionDays } = request.body ?? {};
      const resolvedRetention = resolveRetentionDays(retentionDays, null); // permanent by default
      if (typeof resolvedRetention !== "number") {
        return reply.status(400).send(resolvedRetention);
      }
      const link = await prisma.link.create({
        data: {
          ownerId: request.user!.id,
          slug: customAlphabetSlug(), // same generator as createOneTimeLink's nanoid — see Step 4
          mode: "permanent",
          visibility: "public",
          retentionDays: resolvedRetention,
          ownerNote: ownerNote ?? undefined,
          recipientPublicKey: null,
        },
      });
      const body: CreateRequestLinkResponse = { slug: link.slug };
      return reply.send(body);
    }
  );
```

- [ ] **Step 4: Reuse the existing slug generator**

`lib/links.ts`'s `nanoid` (the module-scoped `customAlphabet(...)` instance, line 8) is not
exported today. Export it as `generateAnonymousSlug` and import it here instead of duplicating the
alphabet/length:

```typescript
// apps/api/src/lib/links.ts — rename the module-scoped `nanoid` binding for clarity now that it's
// exported and used outside this file, and export it:
export const generateAnonymousSlug = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 16);
```

Update `createOneTimeLink`'s own use of `nanoid()` to `generateAnonymousSlug()`, and in
`links.ts` (routes), `import { generateAnonymousSlug } from "../lib/links";` and call
`generateAnonymousSlug()` in place of `customAlphabetSlug()` above.

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/links.ts apps/api/src/lib/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): add sender-initiated link request flow"
```

## Task 13: `POST /api/links/:slug/claim`

**Files:**
- Modify: `apps/api/src/routes/links.ts` (add new route)

- [ ] **Step 1: Write the failing tests**

```typescript
it("claims an unclaimed link", async () => {
  // ...create via /api/links/request
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/claim`,
    payload: { recipientPublicKey: "recipient-pk" },
  });
  expect(res.statusCode).toBe(200);
  const status = await server.inject({ method: "GET", url: `/api/links/${slug}` });
  expect(status.json().recipientPublicKey).toBe("recipient-pk");
});

it("rejects claiming an already-claimed link", async () => {
  await server.inject({
    method: "POST",
    url: `/api/links/${slug}/claim`,
    payload: { recipientPublicKey: "first" },
  });
  const second = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/claim`,
    payload: { recipientPublicKey: "second" },
  });
  expect(second.statusCode).toBe(409);
});

it("rejects claiming a link that already had a recipient key (recipient-initiated flow)", async () => {
  // ...create via POST /api/links (always sets recipientPublicKey)
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/claim`,
    payload: { recipientPublicKey: "x" },
  });
  expect(res.statusCode).toBe(409);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 3: Implement**

```typescript
  // Design spec §4.2: no auth required (anonymous claim is allowed, generating a local keypair
  // exactly like the existing anonymous CreateLinkPage flow — plan 3 builds that UI). The CAS is
  // the whole safety property: two concurrent claims can never both win, and an already-claimed
  // link (from either flow — recipient-initiated links always have a key from creation) cannot be
  // re-claimed.
  server.post<{ Params: { slug: string }; Body: ClaimLinkRequest }>(
    "/api/links/:slug/claim",
    {
      schema: {
        body: {
          type: "object",
          properties: { recipientPublicKey: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { recipientPublicKey } = request.body ?? {};
      if (!recipientPublicKey) return reply.status(400).send({ error: "Missing recipientPublicKey" });

      const link = await getLinkBySlug(request.params.slug);
      if (!link || isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });

      const { count } = await prisma.link.updateMany({
        where: { id: link.id, recipientPublicKey: null },
        data: { recipientPublicKey },
      });
      if (count !== 1) return reply.status(409).send({ error: "This link has already been claimed" });
      return reply.send({ claimed: true });
    }
  );
```

Add `import type { ClaimLinkRequest } from "@e2ee-drop/shared";`.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/api exec vitest run src/routes/links.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): add link claim endpoint for the sender-initiated flow"
```

## Task 14: Fix remaining call sites and run the full suite

**Files:**
- Modify: `apps/api/src/routes/links.ts:170-185` (`GET /:slug/drops`, references `drop.status`)
- Modify: any other file `pnpm --filter @e2ee-drop/api exec tsc --noEmit` still flags.

- [ ] **Step 1: Fix `GET /:slug/drops`**

```typescript
      const drops = link.drops
        .filter((drop) => drop.fileEnvelopeStatus !== "delivered" && drop.fileEnvelopeStatus !== "shredded")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      const body: ListDropsResponse = { drops: drops.map((drop) => toDropSummary(drop, link)) };
```

- [ ] **Step 2: Remove any remaining `@ts-expect-error` markers plan 1 Task 6 left in `apps/api`**

```bash
grep -rn "@ts-expect-error — rewritten in plan 2\|@ts-expect-error — fixed in plan 2" apps/api/src
```

For each hit, confirm this plan's tasks already fixed the underlying line (they should — Tasks 5,
6, 9, 11 cover `uploads.ts`, `downloads.ts`, `links.ts`) and remove the marker. If `tsc` reports an
unused-suppression error for a marker that no longer matches a real error, that confirms the fix
landed; if `tsc` still reports a real error at that line, the corresponding task above is
incomplete — fix it before removing the marker.

- [ ] **Step 3: Full typecheck and test run**

```bash
pnpm --filter @e2ee-drop/api exec tsc --noEmit
pnpm --filter @e2ee-drop/api test
```

Expected: clean typecheck, all `apps/api` tests pass. `apps/web` will still have its own
`@ts-expect-error` markers (plan 3's job) and is not expected to pass yet.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(api): finish porting remaining call sites off Drop.status"
```

---

## Self-review notes (from the agent that wrote this plan)

- **Spec coverage:** covers design spec §3.2 (Task 4/5), §3.3 (Task 11), §4.1/§4.2 (Tasks 12/13),
  §4.4 (Tasks 2/3), §5/§5.1 (Tasks 5-8), §6.1/§6.2/§6.3 (Tasks 9-11), §7 (the full endpoint table).
  §3.1 (actual zip/encrypt), §3.4 (PIN), and everything in §8 (frontend) belong to plan 3.
- **Judgment call flagged for review:** the `role=receiver` query parameter (Task 9) is a pragmatic
  solution to a real gap I found during grounding — the design spec says `GET /api/links/:slug`
  "sets deliveryStatus: receiver_opened" without specifying how the server would know which side is
  asking, since the identical endpoint serves both `/send/:slug` and `/receive/:slug`. It's
  unauthenticated and spoofable by design (see Task 9's inline note) — flag if a stronger mechanism
  is wanted.
- **Judgment call flagged for review:** Task 8's `sweepAbandonedUploads` is new work with no
  existing equivalent — the design spec's §5.1 text ("the passive reservation-timeout sweep remains
  as the safety net... and is extended to scrub message fields") reads as if such a sweep already
  existed; grounding against `apps/api/src/jobs/cleanup.ts` showed it didn't (only
  `sweepExpiredDrops`, scoped to permanent links' `retentionDays`, and `runCleanup`, scoped to a
  whole one-time link's own `expiresAt`— neither keyed on upload status at all). Confirm the ~1
  hour cadence (`UPLOAD_RESERVATION_WINDOW_MS`) is the intended window, not something longer.
- **Type consistency:** confirmed `toDropSummary(drop, link)`'s two-argument signature (plan 1 Task
  4) is used identically at every call site across this plan (Tasks 5, 6, 9, 14).
