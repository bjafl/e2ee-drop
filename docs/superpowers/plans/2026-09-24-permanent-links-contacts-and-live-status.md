# Permanent Links, Contacts, and Live Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are grouped into **Waves**; all tasks within a wave are mutually independent given the outputs of earlier waves and MAY be dispatched to parallel subagents. Do not start a task before every task in an earlier wave it depends on (see each task's **Interfaces: Consumes**) has been completed and reviewed.

**Cross-plan dependency:** This plan builds on Plan 1 (`docs/superpowers/plans/2026-09-24-infra-and-anonymous-flow.md`, already implemented) and runs **in parallel with Plan 2** ("Accounts and key management"), which this plan does not implement but depends on. Plan 2 is assumed to produce, before any task below that says so runs:
- A `User` model (fields: `id, email, emailVerified, name, username, passwordHash, passwordSalt, passwordWrappedPrivateKey, recoveryWrappedPrivateKey, publicKey, totpSecretEncrypted, totpEnabled, storageQuotaBytes, storageUsedBytes, createdAt`) and a `Contact` model (`id, userId, contactUserId, status, createdAt`) added to `packages/db/prisma/schema.prisma` via Plan 2's own migration — this plan does **not** add or modify that migration, only reads the generated `Contact`/`User` Prisma types.
- `apps/api/src/plugins/auth.ts` exporting a Fastify decorator `server.requireAuth` (a `preHandler` that 403s when unauthenticated) and populating `request.user: { id: string } | null` on **every** request (not just protected ones) via a global hook, so an unauthenticated request to a route that doesn't use `requireAuth` still has `request.user === null` available to branch on.
- `apps/web/src/hooks/useAuth.ts` exporting `{ user, login, logout, register }` where `user` is `{ id: string; username: string; publicKey: string } | null`.
- **Assumption this plan adds, not confirmed by the Plan 2 contract:** `useAuth()` also exposes `keyPair: nacl.BoxKeyPair | null` — the user's NaCl box keypair, decrypted client-side at login per spec §3.1, held in memory for the session. Without this, an owned link's recipient has no way to decrypt an incoming file on the Download page. **Flag this for reconciliation against Plan 2's actual output before Wave 3, Task 12 is implemented** — if Plan 2 exposes the secret key under a different name/shape, adjust Task 12 Step 4 accordingly; the rest of this plan does not depend on it.

**Goal:** Let logged-in users create additional named links (beyond their default personal one), accept a queue of simultaneous incoming drops on permanent links, build mutual contacts with request/accept, restrict a link to contacts-only, show senders who they're really sending to, and replace polling with Server-Sent Events for live drop status — all layered on top of Plan 1's anonymous one-time flow without changing its behavior.

**Architecture:** Additive changes to Plan 1's `apps/api` (new `contacts` and `events` routes, a new in-process `EventEmitter`-backed pub/sub for drop status, targeted modifications to `uploads.ts`/`downloads.ts`/`links.ts`) and `apps/web` (contacts page, custom-link-creation page, and an UploadPage/DownloadPage rewrite that adds the owned-link branch alongside the untouched anonymous branch).

**Tech Stack:** Same as Plan 1 (Fastify, Prisma, MinIO S3 SDK on the backend; Vite/React/shadcn/`tweetnacl`/`react-i18next` on the frontend), plus the Node.js built-in `events` module for the SSE pub/sub (no Redis — single-instance deployment, per spec §7).

**Spec:** `docs/superpowers/specs/2026-09-24-e2ee-drop-rewrite-design.md`

## Global Constraints

- Nothing in this plan may change the behavior of Plan 1's anonymous, ownerless one-time flow — every modification to a shared file (`uploads.ts`, `downloads.ts`, `links.ts`, `DownloadPage.tsx`) must keep the `ownerId === null` code path working exactly as Plan 1 left it (spec §1: "Nothing in the account system may weaken or complicate the anonymous path").
- A `contacts-only` `Link` only accepts an upload from a sender who is authenticated *and* has `accepted` `Contact` status with the link owner (spec §6).
- Contacts are mutual request/accept, not a one-directional allowlist (spec §6, confirmed in brainstorming).
- "Send to contact" is a pure navigation shortcut to the contact's link at `/send/:slug` (Plan 1's actual sender route) using their username as the slug — no separate resolution endpoint (spec §6).
- Owned links show the owner's `name` ("entered by user, not verified") and `email` (verified/unverified badge) to the sender; anonymous links keep the existing "Anonymous recipient" indicator untouched (spec §6.1).
- SSE, not polling, drives live drop status; a single in-process `EventEmitter` is sufficient because the deployment target is single-instance (spec §7).
- A custom link's slug is scoped to its owner (`@@unique([ownerId, slug])`, already in Plan 1's schema — no migration needed here) and must be validated before creation.
- This plan adds **no new Prisma migration** — `Contact`/`User` come from Plan 2's migration; this plan's first backend task must not run before that migration has been applied, and every route added here that needs `Contact`/`User` imports the generated types from `@e2ee-drop/db` rather than redefining them.

## Review Focus

- An **authenticated sender who is not an accepted contact** of a `contacts-only` link's owner must be rejected exactly like an anonymous sender (403), not accidentally let through because they merely have a valid session — covered in Task 8.
- A **pending** (not yet accepted) contact request must not grant upload access on a `contacts-only` link — accepting must be a real state transition an authenticated action performs, not implied by the request merely existing — covered in Task 3 and Task 8.
- A permanent link's drop **queue must isolate downloads**: downloading (or failing to download) one queued drop must not change the status of, or block access to, any other drop still queued on the same link — covered in Task 7.
- Requesting a **download URL for an owned link's drop as someone other than the link's owner** must be rejected (403) even with a correct `dropId` — this is a genuine access gap Plan 1 never had to consider, since Plan 1 links have no owner to protect — covered in Task 7.
- A **second SSE connection for the same link** (e.g. the recipient reloads the tab, or opens it in two tabs) must not throw, leak the old listener, or double-emit — the emitter is per-link, not per-connection, and connections must clean up on `close` — covered in Task 7.

---

## Wave 0 — Foundation modifications to Plan 1 files (parallel; both depend only on Plan 1 as already committed, plus Plan 2's migration having been applied)

### Task 1: Queue support in the upload route

**Files:**
- Modify: `apps/api/src/routes/uploads.ts`
- Modify: `apps/api/src/routes/uploads.test.ts`

**Interfaces:**
- Consumes: `getLinkBySlug`, `isLinkExpired` from `../lib/links` (Plan 1 Task 9) — unchanged signatures.
- Produces: the one-time-drop-limit check now reads `if (link.mode === "one-time" && link.drops.length > 0)` instead of `if (link.drops.length > 0)`, so a `permanent` link with an existing drop still accepts more — consumed by Task 8 (contacts-only check, layered onto the same handler) and by Task 12 (frontend queue view, which now has more than one drop to render).

- [ ] **Step 1: Add a failing test for queueing on a permanent link**

Add to `apps/api/src/routes/uploads.test.ts` (after the existing "rejects a second upload-url request once a drop already exists" test):

```typescript
it("allows a second upload-url request on a permanent link (queueing)", async () => {
  const server = buildServer();
  const link = await prisma.link.create({
    data: { slug: "permanent-queue-test", mode: "permanent", recipientPublicKey: "cmVjaXBpZW50" },
  });

  const first = await server.inject({
    method: "POST",
    url: `/api/links/${link.slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
  });
  expect(first.statusCode).toBe(200);

  const second = await server.inject({
    method: "POST",
    url: `/api/links/${link.slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVyMg==", metadata: validMetadata },
  });
  expect(second.statusCode).toBe(200);

  const drops = await prisma.drop.findMany({ where: { linkId: link.id } });
  expect(drops).toHaveLength(2);
});

it("still rejects a second upload-url request on a one-time link", async () => {
  const server = buildServer();
  const slug = await createLink(server);

  const first = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
  });
  expect(first.statusCode).toBe(200);

  const second = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVyMg==", metadata: validMetadata },
  });
  expect(second.statusCode).toBe(409);
});
```

- [ ] **Step 2: Run test to verify the new "permanent link queueing" test fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- uploads`
Expected: FAIL on "allows a second upload-url request on a permanent link" with a 409 where 200 was expected (Plan 1's check rejects any second drop regardless of mode); the "still rejects... one-time link" test PASSes already (no regression to prove).

- [ ] **Step 3: Modify `apps/api/src/routes/uploads.ts`**

Change:
```typescript
      if (link.drops.length > 0) {
        return reply.status(409).send({ error: "Link already has a pending or completed drop" });
      }
```
to:
```typescript
      if (link.mode === "one-time" && link.drops.length > 0) {
        return reply.status(409).send({ error: "Link already has a pending or completed drop" });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- uploads`
Expected: PASS (all eight tests — six from Plan 1, two new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/uploads.ts apps/api/src/routes/uploads.test.ts
git commit -m "feat(api): allow permanent links to queue more than one drop"
```

### Task 2: Recipient identity fields on `LinkStatusResponse`

**Files:**
- Modify: `packages/shared/src/api.ts`
- Modify: `apps/api/src/lib/links.ts`
- Modify: `apps/api/src/routes/links.test.ts`

**Interfaces:**
- Consumes: the generated `User` type from `@e2ee-drop/db` (Plan 2's migration).
- Produces: `LinkStatusResponse` gains two additive, optional fields — `recipientName?: string` and `recipientEmailVerified?: boolean` — populated only when `link.ownerId` is set. `isAnonymous` and every other existing field are unchanged, so Plan 1's `UploadPage.tsx` (before Task 9 of this plan touches it) keeps compiling and passing against the same response shape. Consumed by Task 9 (frontend identity branch).

- [ ] **Step 1: Add the failing test**

Add to `apps/api/src/routes/links.test.ts`:

```typescript
it("includes recipient name and email-verified status for an owned link, and omits them for an anonymous one", async () => {
  const server = buildServer();

  const owner = await prisma.user.create({
    data: {
      email: "owner@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      username: "ada",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "b3duZXJrZXk=",
    },
  });
  const ownedLink = await prisma.link.create({
    data: { ownerId: owner.id, slug: "ada", mode: "permanent", recipientPublicKey: owner.publicKey },
  });

  const ownedResponse = await server.inject({ method: "GET", url: `/api/links/${ownedLink.slug}` });
  const ownedBody = ownedResponse.json();
  expect(ownedBody.isAnonymous).toBe(false);
  expect(ownedBody.recipientName).toBe("Ada Lovelace");
  expect(ownedBody.recipientEmailVerified).toBe(true);

  const anonCreate = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "YW5vbg==" },
  });
  const { slug: anonSlug } = anonCreate.json();
  const anonResponse = await server.inject({ method: "GET", url: `/api/links/${anonSlug}` });
  const anonBody = anonResponse.json();
  expect(anonBody.isAnonymous).toBe(true);
  expect(anonBody.recipientName).toBeUndefined();
  expect(anonBody.recipientEmailVerified).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: FAIL — `recipientName`/`recipientEmailVerified` are `undefined` on the owned link too (not implemented yet).

- [ ] **Step 3: Modify `packages/shared/src/api.ts`**

Change:
```typescript
export interface LinkStatusResponse {
  slug: string;
  mode: LinkMode;
  recipientPublicKey: string; // base64
  drop: DropSummary | null;
  isAnonymous: boolean;
}
```
to:
```typescript
export interface LinkStatusResponse {
  slug: string;
  mode: LinkMode;
  recipientPublicKey: string; // base64
  drop: DropSummary | null;
  isAnonymous: boolean;
  recipientName?: string;
  recipientEmailVerified?: boolean;
}
```

- [ ] **Step 4: Modify `apps/api/src/lib/links.ts`**

Change the `toLinkStatusResponse` signature and body from:
```typescript
export function toLinkStatusResponse(link: Link & { drops: Drop[] }): LinkStatusResponse {
  const activeDrop = link.drops[0] ?? null;
  return {
    slug: link.slug,
    mode: link.mode as LinkStatusResponse["mode"],
    recipientPublicKey: link.recipientPublicKey,
    drop: activeDrop ? toDropSummary(activeDrop) : null,
    isAnonymous: link.ownerId === null,
  };
}
```
to:
```typescript
export async function toLinkStatusResponse(
  link: Link & { drops: Drop[] }
): Promise<LinkStatusResponse> {
  const activeDrop = link.drops[0] ?? null;
  const base: LinkStatusResponse = {
    slug: link.slug,
    mode: link.mode as LinkStatusResponse["mode"],
    recipientPublicKey: link.recipientPublicKey,
    drop: activeDrop ? toDropSummary(activeDrop) : null,
    isAnonymous: link.ownerId === null,
  };
  if (!link.ownerId) return base;

  const owner = await prisma.user.findUnique({ where: { id: link.ownerId } });
  if (!owner) return base;

  return { ...base, recipientName: owner.name, recipientEmailVerified: owner.emailVerified };
}
```

`toLinkStatusResponse` is now async; it already lives in a file that imports `prisma` from `@e2ee-drop/db`, so no new import is needed — only the call sites change.

- [ ] **Step 5: Update the two call sites in `apps/api/src/routes/links.ts`**

Change:
```typescript
    return reply.send(toLinkStatusResponse(link));
```
to:
```typescript
    return reply.send(await toLinkStatusResponse(link));
```
(this appears once, in the `GET /api/links/:slug` handler — the `POST` and `DELETE` handlers don't call `toLinkStatusResponse`).

- [ ] **Step 6: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: PASS (all four tests — three from Plan 1, one new). This step requires Plan 2's `User` model to already exist in the database schema; if it doesn't yet, this step blocks until Plan 2's migration lands — do not stub the `User` table here.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/api.ts apps/api/src/lib/links.ts apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): add recipient name/email-verified fields to link status for owned links"
```

---

## Wave 1 — New backend building blocks (parallel; each depends on Wave 0 plus the Plan 2 contract above)

### Task 3: Contact request/accept/reject library and routes

**Files:**
- Create: `apps/api/src/lib/contacts.ts`
- Create: `apps/api/src/routes/contacts.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/contacts.test.ts`

**Interfaces:**
- Consumes: `prisma`, generated `Contact`, `User` types from `@e2ee-drop/db` (Plan 2's migration); `server.requireAuth` from `../plugins/auth` (Plan 2).
- Produces: `sendContactRequest(userId: string, targetUsername: string): Promise<Contact>`, `listContacts(userId: string): Promise<{ pending: ContactSummary[]; accepted: ContactSummary[] }>`, `acceptContactRequest(userId: string, contactId: string): Promise<Contact>`, `rejectContactRequest(userId: string, contactId: string): Promise<void>`, `hasAcceptedContact(ownerId: string, otherUserId: string): Promise<boolean>` from `lib/contacts.ts` — `hasAcceptedContact` is consumed by Task 8. Registers `POST /api/contacts`, `GET /api/contacts`, `POST /api/contacts/:id/accept`, `POST /api/contacts/:id/reject` — consumed by Task 10 (frontend contacts UI).
- **Design note:** looks up usernames via a separate `prisma.user.findMany({ where: { id: { in: [...] } } })` call rather than a Prisma `include` on an assumed relation name, since this plan cannot see Plan 2's exact relation field names on `Contact`. If Plan 2's schema does define named relations, this still works — it just doesn't rely on them.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/routes/contacts.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

async function createUser(username: string) {
  return prisma.user.create({
    data: {
      email: `${username}@example.com`,
      emailVerified: true,
      name: username,
      username,
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: `${username}-pubkey`,
    },
  });
}

describe("contact routes", () => {
  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.user.deleteMany();
  });

  it("sends a request, lists it as pending for both sides, then accepts it", async () => {
    const server = buildServer();
    const alice = await createUser("alice");
    const bob = await createUser("bob");

    const sendRes = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "bob" },
      headers: { "x-test-user-id": alice.id },
    });
    expect(sendRes.statusCode).toBe(200);

    const aliceList = await server.inject({
      method: "GET",
      url: "/api/contacts",
      headers: { "x-test-user-id": alice.id },
    });
    expect(aliceList.json().pending).toHaveLength(1);
    expect(aliceList.json().pending[0].username).toBe("bob");

    const bobList = await server.inject({
      method: "GET",
      url: "/api/contacts",
      headers: { "x-test-user-id": bob.id },
    });
    expect(bobList.json().pending).toHaveLength(1);

    const contactId = aliceList.json().pending[0].id;
    const acceptRes = await server.inject({
      method: "POST",
      url: `/api/contacts/${contactId}/accept`,
      headers: { "x-test-user-id": bob.id },
    });
    expect(acceptRes.statusCode).toBe(200);

    const aliceAfter = await server.inject({
      method: "GET",
      url: "/api/contacts",
      headers: { "x-test-user-id": alice.id },
    });
    expect(aliceAfter.json().accepted).toHaveLength(1);
    expect(aliceAfter.json().pending).toHaveLength(0);
  });

  it("rejects accept from someone who isn't the request's recipient", async () => {
    const server = buildServer();
    const alice = await createUser("alice2");
    const bob = await createUser("bob2");
    const carol = await createUser("carol2");

    const sendRes = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "bob2" },
      headers: { "x-test-user-id": alice.id },
    });
    const contactId = sendRes.json().id;

    const acceptRes = await server.inject({
      method: "POST",
      url: `/api/contacts/${contactId}/accept`,
      headers: { "x-test-user-id": carol.id },
    });
    expect(acceptRes.statusCode).toBe(403);
  });
});
```

This test relies on a `x-test-user-id` header stand-in for Plan 2's real session auth. **Before running this task's tests, confirm how Plan 2's `apps/api` test suite fakes an authenticated `request.user` in Fastify `.inject()` calls** (it must have solved the same problem for its own auth tests) and use that mechanism instead of `x-test-user-id` if it differs — this header is a placeholder assumption, not a contract Plan 2 promised.

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- contacts`
Expected: FAIL — `./contacts` route module not found.

- [ ] **Step 3: Write `apps/api/src/lib/contacts.ts`**

```typescript
// apps/api/src/lib/contacts.ts
import { prisma, type Contact } from "@e2ee-drop/db";

export interface ContactSummary {
  id: string;
  userId: string;
  username: string;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing";
}

export async function sendContactRequest(userId: string, targetUsername: string): Promise<Contact> {
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target) throw new Error("User not found");
  if (target.id === userId) throw new Error("Cannot add yourself as a contact");

  const existing = await prisma.contact.findFirst({
    where: {
      OR: [
        { userId, contactUserId: target.id },
        { userId: target.id, contactUserId: userId },
      ],
    },
  });
  if (existing) throw new Error("A contact relationship already exists");

  return prisma.contact.create({ data: { userId, contactUserId: target.id, status: "pending" } });
}

export async function listContacts(
  userId: string
): Promise<{ pending: ContactSummary[]; accepted: ContactSummary[] }> {
  const rows = await prisma.contact.findMany({
    where: { OR: [{ userId }, { contactUserId: userId }] },
  });
  const otherIds = rows.map((row) => (row.userId === userId ? row.contactUserId : row.userId));
  const users = await prisma.user.findMany({ where: { id: { in: otherIds } } });
  const usernameById = new Map(users.map((user) => [user.id, user.username]));

  const summaries: ContactSummary[] = rows.map((row) => {
    const isOutgoing = row.userId === userId;
    const otherId = isOutgoing ? row.contactUserId : row.userId;
    return {
      id: row.id,
      userId: otherId,
      username: usernameById.get(otherId) ?? "unknown",
      status: row.status as "pending" | "accepted",
      direction: isOutgoing ? "outgoing" : "incoming",
    };
  });

  return {
    pending: summaries.filter((summary) => summary.status === "pending"),
    accepted: summaries.filter((summary) => summary.status === "accepted"),
  };
}

export async function acceptContactRequest(userId: string, contactId: string): Promise<Contact> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw Object.assign(new Error("Contact request not found"), { statusCode: 404 });
  if (row.contactUserId !== userId) {
    throw Object.assign(new Error("Only the request's recipient can accept it"), { statusCode: 403 });
  }
  return prisma.contact.update({ where: { id: contactId }, data: { status: "accepted" } });
}

export async function rejectContactRequest(userId: string, contactId: string): Promise<void> {
  const row = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!row) throw Object.assign(new Error("Contact request not found"), { statusCode: 404 });
  if (row.userId !== userId && row.contactUserId !== userId) {
    throw Object.assign(new Error("Not part of this contact relationship"), { statusCode: 403 });
  }
  await prisma.contact.delete({ where: { id: contactId } });
}

export async function hasAcceptedContact(ownerId: string, otherUserId: string): Promise<boolean> {
  const row = await prisma.contact.findFirst({
    where: {
      status: "accepted",
      OR: [
        { userId: ownerId, contactUserId: otherUserId },
        { userId: otherUserId, contactUserId: ownerId },
      ],
    },
  });
  return row !== null;
}
```

- [ ] **Step 4: Write `apps/api/src/routes/contacts.ts`**

```typescript
// apps/api/src/routes/contacts.ts
import type { FastifyInstance } from "fastify";
import {
  sendContactRequest,
  listContacts,
  acceptContactRequest,
  rejectContactRequest,
} from "../lib/contacts";

interface ErrorWithStatus extends Error {
  statusCode?: number;
}

export function registerContactRoutes(server: FastifyInstance): void {
  server.post<{ Body: { username: string } }>(
    "/api/contacts",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      try {
        const contact = await sendContactRequest(request.user!.id, request.body.username);
        return reply.send(contact);
      } catch (error) {
        return reply.status(400).send({ error: (error as Error).message });
      }
    }
  );

  server.get("/api/contacts", { preHandler: server.requireAuth }, async (request, reply) => {
    const contacts = await listContacts(request.user!.id);
    return reply.send(contacts);
  });

  server.post<{ Params: { id: string } }>(
    "/api/contacts/:id/accept",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      try {
        const contact = await acceptContactRequest(request.user!.id, request.params.id);
        return reply.send(contact);
      } catch (error) {
        const err = error as ErrorWithStatus;
        return reply.status(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/contacts/:id/reject",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      try {
        await rejectContactRequest(request.user!.id, request.params.id);
        return reply.send({ deleted: true });
      } catch (error) {
        const err = error as ErrorWithStatus;
        return reply.status(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );
}
```

- [ ] **Step 5: Register the routes in `apps/api/src/server.ts`**

Add the import `import { registerContactRoutes } from "./routes/contacts";` and the call `registerContactRoutes(server);` alongside the other `register*Routes(server)` calls inside `buildServer()`.

- [ ] **Step 6: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- contacts`
Expected: PASS (both tests) once wired to Plan 2's real auth-faking mechanism per Step 1's note.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/contacts.ts apps/api/src/routes/contacts.ts apps/api/src/routes/contacts.test.ts apps/api/src/server.ts
git commit -m "feat(api): add mutual contact request/accept/reject library and routes"
```

### Task 4: Drop event emitter

**Files:**
- Create: `apps/api/src/lib/dropEvents.ts`
- Test: `apps/api/src/lib/dropEvents.test.ts`

**Interfaces:**
- Consumes: `DropSummary` from `@e2ee-drop/shared` (Plan 1 Task 3).
- Produces: `emitDropEvent(linkId: string, event: DropEvent): void`, `subscribeToLink(linkId: string, listener: (event: DropEvent) => void): () => void` where `DropEvent = { type: "drop-created" | "drop-updated"; drop: DropSummary }` — consumed by Task 7 (SSE route + wiring into uploads/downloads).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/dropEvents.test.ts
import { describe, it, expect, vi } from "vitest";
import { emitDropEvent, subscribeToLink } from "./dropEvents";
import type { DropSummary } from "@e2ee-drop/shared";

const drop: DropSummary = {
  id: "drop1",
  status: "uploaded",
  senderPublicKey: "x",
  nonce: "x",
  fileName: "x",
  fileSize: 1,
  mimeType: "x",
  contentMD5: "x",
  message: null,
};

describe("dropEvents", () => {
  it("delivers an emitted event only to subscribers of the same linkId", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubA = subscribeToLink("link-a", listenerA);
    const unsubB = subscribeToLink("link-b", listenerB);

    emitDropEvent("link-a", { type: "drop-created", drop });

    expect(listenerA).toHaveBeenCalledWith({ type: "drop-created", drop });
    expect(listenerB).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it("stops delivering events after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLink("link-c", listener);
    unsubscribe();

    emitDropEvent("link-c", { type: "drop-updated", drop });

    expect(listener).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- dropEvents`
Expected: FAIL — `./dropEvents` module not found.

- [ ] **Step 3: Write `apps/api/src/lib/dropEvents.ts`**

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

export function emitDropEvent(linkId: string, event: DropEvent): void {
  emitter.emit(linkId, event);
}

export function subscribeToLink(linkId: string, listener: (event: DropEvent) => void): () => void {
  emitter.on(linkId, listener);
  return () => emitter.off(linkId, listener);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- dropEvents`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/dropEvents.ts apps/api/src/lib/dropEvents.test.ts
git commit -m "feat(api): add in-process drop-status event emitter for SSE"
```

### Task 5: Custom link creation route

**Files:**
- Modify: `packages/shared/src/api.ts`
- Modify: `apps/api/src/routes/links.ts`
- Modify: `apps/api/src/routes/links.test.ts`

**Interfaces:**
- Consumes: `server.requireAuth` from `../plugins/auth` (Plan 2); `env.LINK_EXPIRY_HOURS` from `../env` (Plan 1 Task 4).
- Produces: `CreateCustomLinkRequest { slug: string; mode: LinkMode; visibility?: LinkVisibility; retentionDays?: number }` added to `@e2ee-drop/shared` (additive); registers `POST /api/links/custom` returning `CreateLinkResponse` (reused, unchanged) — consumed by Task 11 (frontend custom-link-creation form).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/links.test.ts`:

```typescript
it("creates a custom link with a slug scoped to the owner", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "owner2@example.com",
      emailVerified: false,
      name: "Owner Two",
      username: "ownertwo",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "b3duZXIy",
    },
  });

  const response = await server.inject({
    method: "POST",
    url: "/api/links/custom",
    payload: { slug: "team-drop", mode: "permanent", visibility: "public" },
    headers: { "x-test-user-id": owner.id },
  });

  expect(response.statusCode).toBe(200);
  const { slug } = response.json();
  expect(slug).toBe("team-drop");

  const link = await prisma.link.findFirst({ where: { ownerId: owner.id, slug: "team-drop" } });
  expect(link?.mode).toBe("permanent");
  expect(link?.recipientPublicKey).toBe(owner.publicKey);
});

it("rejects a duplicate slug for the same owner", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "owner3@example.com",
      emailVerified: false,
      name: "Owner Three",
      username: "ownerthree",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "b3duZXIz",
    },
  });

  await server.inject({
    method: "POST",
    url: "/api/links/custom",
    payload: { slug: "dupe", mode: "permanent" },
    headers: { "x-test-user-id": owner.id },
  });
  const second = await server.inject({
    method: "POST",
    url: "/api/links/custom",
    payload: { slug: "dupe", mode: "one-time" },
    headers: { "x-test-user-id": owner.id },
  });

  expect(second.statusCode).toBe(409);
});
```

(Same `x-test-user-id` caveat as Task 3, Step 1 — replace with Plan 2's real test-auth mechanism.)

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: FAIL — `POST /api/links/custom` doesn't exist yet (404).

- [ ] **Step 3: Add `CreateCustomLinkRequest` to `packages/shared/src/api.ts`**

```typescript
export interface CreateCustomLinkRequest {
  slug: string;
  mode: LinkMode;
  visibility?: LinkVisibility;
  retentionDays?: number;
}
```

- [ ] **Step 4: Modify `apps/api/src/routes/links.ts`**

Add the import `import type { CreateCustomLinkRequest } from "@e2ee-drop/shared";` and `import { env } from "../env";`, and add inside `registerLinkRoutes`, after the existing `POST /api/links` handler:

```typescript
  const SLUG_PATTERN = /^[a-z0-9-]{3,32}$/;

  server.post<{ Body: CreateCustomLinkRequest }>(
    "/api/links/custom",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const { slug, mode, visibility, retentionDays } = request.body;
      if (!slug || !SLUG_PATTERN.test(slug)) {
        return reply.status(400).send({ error: "Slug must be 3-32 lowercase letters, digits, or hyphens" });
      }
      if (mode !== "permanent" && mode !== "one-time") {
        return reply.status(400).send({ error: "Invalid mode" });
      }

      const owner = await prisma.user.findUnique({ where: { id: request.user!.id } });
      if (!owner) return reply.status(404).send({ error: "User not found" });

      const existing = await prisma.link.findUnique({
        where: { ownerId_slug: { ownerId: owner.id, slug } },
      });
      if (existing) return reply.status(409).send({ error: "You already have a link with this slug" });

      const link = await prisma.link.create({
        data: {
          ownerId: owner.id,
          slug,
          mode,
          visibility: visibility ?? "public",
          retentionDays: retentionDays ?? null,
          recipientPublicKey: owner.publicKey,
          expiresAt:
            mode === "one-time" ? new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000) : null,
        },
      });

      const body: CreateLinkResponse = { linkId: link.id, slug: link.slug };
      return reply.send(body);
    }
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: PASS (all six link tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/api.ts apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): add custom named link creation for authenticated owners"
```

### Task 6: Queue listing route

**Files:**
- Modify: `packages/shared/src/api.ts`
- Modify: `apps/api/src/routes/links.ts`
- Modify: `apps/api/src/routes/links.test.ts`

**Interfaces:**
- Consumes: `getLinkBySlug`, `toDropSummary` from `../lib/links` (Plan 1 Task 9); `server.requireAuth` (Plan 2).
- Produces: `ListDropsResponse { drops: DropSummary[] }` added to `@e2ee-drop/shared` (additive); registers `GET /api/links/:slug/drops`, owner-only, returning all non-`downloaded` drops oldest-first — consumed by Task 12 (frontend queue view, as the initial snapshot before SSE takes over).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/links.test.ts`:

```typescript
it("lists queued drops for the owner, oldest first, excluding downloaded ones", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "owner4@example.com",
      emailVerified: false,
      name: "Owner Four",
      username: "ownerfour",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "b3duZXI0",
    },
  });
  const link = await prisma.link.create({
    data: { ownerId: owner.id, slug: "queue-test", mode: "permanent", recipientPublicKey: owner.publicKey },
  });
  const older = await prisma.drop.create({
    data: {
      linkId: link.id,
      senderPublicKey: "a",
      s3Key: "k1",
      nonce: "n",
      fileName: "old.txt",
      fileSize: 1,
      mimeType: "text/plain",
      contentMD5: "m",
      status: "uploaded",
      createdAt: new Date(Date.now() - 60_000),
    },
  });
  await prisma.drop.create({
    data: {
      linkId: link.id,
      senderPublicKey: "b",
      s3Key: "k2",
      nonce: "n",
      fileName: "new.txt",
      fileSize: 1,
      mimeType: "text/plain",
      contentMD5: "m",
      status: "uploaded",
    },
  });
  await prisma.drop.create({
    data: {
      linkId: link.id,
      senderPublicKey: "c",
      s3Key: "k3",
      nonce: "n",
      fileName: "gone.txt",
      fileSize: 1,
      mimeType: "text/plain",
      contentMD5: "m",
      status: "downloaded",
    },
  });

  const response = await server.inject({
    method: "GET",
    url: `/api/links/${link.slug}/drops`,
    headers: { "x-test-user-id": owner.id },
  });

  expect(response.statusCode).toBe(200);
  const { drops } = response.json();
  expect(drops).toHaveLength(2);
  expect(drops[0].id).toBe(older.id);
  expect(drops.map((drop: { fileName: string }) => drop.fileName)).not.toContain("gone.txt");
});

it("rejects a non-owner from listing another user's queue", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "owner5@example.com",
      emailVerified: false,
      name: "Owner Five",
      username: "ownerfive",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "b3duZXI1",
    },
  });
  const intruder = await prisma.user.create({
    data: {
      email: "intruder@example.com",
      emailVerified: false,
      name: "Intruder",
      username: "intruder",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "aW50cnVkZXI=",
    },
  });
  const link = await prisma.link.create({
    data: { ownerId: owner.id, slug: "private-queue", mode: "permanent", recipientPublicKey: owner.publicKey },
  });

  const response = await server.inject({
    method: "GET",
    url: `/api/links/${link.slug}/drops`,
    headers: { "x-test-user-id": intruder.id },
  });

  expect(response.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: FAIL — `GET /api/links/:slug/drops` doesn't exist yet (404).

- [ ] **Step 3: Add `ListDropsResponse` to `packages/shared/src/api.ts`**

```typescript
export interface ListDropsResponse {
  drops: DropSummary[];
}
```

- [ ] **Step 4: Modify `apps/api/src/routes/links.ts`**

Add, inside `registerLinkRoutes`:

```typescript
  server.get<{ Params: { slug: string } }>(
    "/api/links/:slug/drops",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (link.ownerId !== request.user!.id) return reply.status(403).send({ error: "Forbidden" });

      const drops = link.drops
        .filter((drop) => drop.status !== "downloaded")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      const body: ListDropsResponse = { drops: drops.map(toDropSummary) };
      return reply.send(body);
    }
  );
```

Add `ListDropsResponse` to the existing `import type { ... } from "@e2ee-drop/shared";` line.

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: PASS (all eight link tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/api.ts apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): add owner-only queued-drops listing route"
```

---

## Wave 2 — Backend integration (parallel; each depends on specific Wave 1 tasks as noted)

### Task 7: SSE route, event wiring, and owner-checked dropId-aware download

**Files:**
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/routes/uploads.ts`
- Modify: `apps/api/src/routes/downloads.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/events.test.ts`
- Modify: `apps/api/src/routes/downloads.test.ts`

**Interfaces:**
- Consumes: `subscribeToLink`, `emitDropEvent` from `../lib/dropEvents` (Task 4); `getLinkBySlug`, `toDropSummary` from `../lib/links` (Plan 1 Task 9, unchanged); `link.mode === "one-time"` queueing from Task 1.
- Produces: `GET /api/links/:slug/events` (SSE stream; unauthenticated for `ownerId === null` links, owner-only for owned links); `GET /api/links/:slug/download-url` now accepts an optional `?dropId=` query param and, for owned links, requires the caller to be the owner; both the upload-complete and download-url/downloaded handlers now call `emitDropEvent`. Consumed by Task 12 (frontend DownloadPage rewrite).

- [ ] **Step 1: Write the failing test for owner-checked, dropId-aware downloads**

Add to `apps/api/src/routes/downloads.test.ts`:

```typescript
it("rejects a download-url request for an owned link from a non-owner", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "dlowner@example.com",
      emailVerified: false,
      name: "DL Owner",
      username: "dlowner",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "ZGxvd25lcg==",
    },
  });
  const link = await prisma.link.create({
    data: { ownerId: owner.id, slug: "owned-dl-test", mode: "permanent", recipientPublicKey: owner.publicKey },
  });
  await prisma.drop.create({
    data: {
      linkId: link.id,
      senderPublicKey: "a",
      s3Key: "k1",
      nonce: "n",
      fileName: "f.txt",
      fileSize: 1,
      mimeType: "text/plain",
      contentMD5: "m",
      status: "uploaded",
    },
  });

  const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}/download-url` });

  expect(response.statusCode).toBe(403);
});

it("selects the drop matching an explicit dropId out of a queue", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "dlowner2@example.com",
      emailVerified: false,
      name: "DL Owner 2",
      username: "dlowner2",
      passwordHash: "x",
      passwordSalt: "x",
      passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x",
      publicKey: "ZGxvd25lcjI=",
    },
  });
  const link = await prisma.link.create({
    data: { ownerId: owner.id, slug: "owned-queue-dl", mode: "permanent", recipientPublicKey: owner.publicKey },
  });
  await prisma.drop.create({
    data: {
      linkId: link.id, senderPublicKey: "a", s3Key: "k1", nonce: "n", fileName: "first.txt",
      fileSize: 1, mimeType: "text/plain", contentMD5: "m", status: "uploaded",
    },
  });
  const second = await prisma.drop.create({
    data: {
      linkId: link.id, senderPublicKey: "b", s3Key: "k2", nonce: "n", fileName: "second.txt",
      fileSize: 1, mimeType: "text/plain", contentMD5: "m", status: "uploaded",
    },
  });

  const response = await server.inject({
    method: "GET",
    url: `/api/links/${link.slug}/download-url?dropId=${second.id}`,
    headers: { "x-test-user-id": owner.id },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().fileName).toBe("second.txt");
});
```

- [ ] **Step 2: Write the failing SSE test**

```typescript
// apps/api/src/routes/events.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { emitDropEvent } from "../lib/dropEvents";
import type { DropSummary } from "@e2ee-drop/shared";

const drop: DropSummary = {
  id: "drop1", status: "uploaded", senderPublicKey: "x", nonce: "x",
  fileName: "x", fileSize: 1, mimeType: "x", contentMD5: "x", message: null,
};

describe("SSE events route", () => {
  it("returns 404 for an unknown link", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/links/does-not-exist/events" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a non-owner from subscribing to an owned link's events", async () => {
    const server = buildServer();
    const owner = await prisma.user.create({
      data: {
        email: "sseowner@example.com", emailVerified: false, name: "SSE Owner", username: "sseowner",
        passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
        recoveryWrappedPrivateKey: "x", publicKey: "c3Nlb3duZXI=",
      },
    });
    const link = await prisma.link.create({
      data: { ownerId: owner.id, slug: "sse-owned", mode: "permanent", recipientPublicKey: owner.publicKey },
    });

    const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}/events` });

    expect(response.statusCode).toBe(403);
  });

  it("allows an unauthenticated subscriber to an anonymous link's events", async () => {
    const server = buildServer();
    const createRes = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50" },
    });
    const { slug } = createRes.json();

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/events` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });
});
```

Note: `.inject()` against a hanging SSE stream resolves once Fastify flushes headers — it does not wait for the connection to close, so this test only asserts the initial handshake (status/headers), not delivered events. Event delivery is exercised indirectly by Step 6's upload/download wiring tests (they call `emitDropEvent` via the route handlers and rely on Task 4's own unit tests to prove delivery semantics).

- [ ] **Step 3: Run tests to verify they fail**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- events downloads`
Expected: FAIL — `./events` route module not found; the two new `downloads.test.ts` cases fail because `download-url` doesn't check ownership or `dropId` yet.

- [ ] **Step 4: Write `apps/api/src/routes/events.ts`**

```typescript
// apps/api/src/routes/events.ts
import type { FastifyInstance } from "fastify";
import { getLinkBySlug } from "../lib/links";
import { subscribeToLink } from "../lib/dropEvents";

export function registerEventRoutes(server: FastifyInstance): void {
  server.get<{ Params: { slug: string } }>("/api/links/:slug/events", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    if (link.ownerId && link.ownerId !== request.user?.id) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    reply.hijack(); // take over the response so Fastify doesn't also try to send one
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = subscribeToLink(link.id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    request.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });
  });
}
```

This route relies on `request.user` being populated (nullable) by Plan 2's global auth hook even without `server.requireAuth` — see this plan's header note on the Plan 2 contract. Without that hook, `request.user` is `undefined`, which still correctly fails the `!==` check for owned links (denying access) but never grants it either, so the failure mode is "SSE for owned links never works" rather than "anyone can subscribe to anyone's queue" — confirm Plan 2 actually sets `request.user = null` globally before this route is exercised against owned links in practice.

- [ ] **Step 5: Register the route in `apps/api/src/server.ts`**

Add the import `import { registerEventRoutes } from "./routes/events";` and the call `registerEventRoutes(server);`.

- [ ] **Step 6: Modify `apps/api/src/routes/downloads.ts`**

Replace the whole file:

```typescript
// apps/api/src/routes/downloads.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { DownloadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired, toDropSummary } from "../lib/links";
import { getSignedDownloadUrl } from "../lib/storage";
import { emitDropEvent } from "../lib/dropEvents";

export function registerDownloadRoutes(server: FastifyInstance): void {
  server.get<{ Params: { slug: string }; Querystring: { dropId?: string } }>(
    "/api/links/:slug/download-url",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (isLinkExpired(link)) {
        await prisma.link.delete({ where: { id: link.id } });
        return reply.status(404).send({ error: "Link not found" });
      }
      if (link.ownerId && link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const drop = request.query.dropId
        ? link.drops.find((candidate) => candidate.id === request.query.dropId)
        : link.drops[0];
      if (!drop) return reply.status(404).send({ error: "No uploaded file for this link" });
      if (drop.status !== "uploaded") {
        return reply.status(403).send({ error: "File is not ready for download yet" });
      }

      const downloadUrl = await getSignedDownloadUrl(drop.s3Key);
      const updated = await prisma.drop.update({ where: { id: drop.id }, data: { status: "downloading" } });
      emitDropEvent(link.id, { type: "drop-updated", drop: toDropSummary(updated) });

      const body: DownloadUrlResponse = {
        downloadUrl,
        fileName: drop.fileName,
        fileSize: drop.fileSize,
        mimeType: drop.mimeType,
        nonce: drop.nonce,
        senderPublicKey: drop.senderPublicKey,
        contentMD5: drop.contentMD5,
      };
      return reply.send(body);
    }
  );

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/downloaded",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      const drop = await prisma.drop.findUnique({ where: { id: request.params.dropId } });
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      const updated = await prisma.drop.update({ where: { id: drop.id }, data: { status: "downloaded" } });
      if (link) emitDropEvent(link.id, { type: "drop-updated", drop: toDropSummary(updated) });
      return reply.send({ updated: true });
    }
  );
}
```

- [ ] **Step 7: Modify `apps/api/src/routes/uploads.ts`** to emit events on creation and completion

Add the import `import { emitDropEvent } from "../lib/dropEvents";` and add `toDropSummary` to the existing `../lib/links` import. In the `upload-url` handler, change:
```typescript
      const dropId = nanoid();
      const s3Key = `${link.id}/${dropId}`;
      await prisma.drop.create({
        data: {
          id: dropId,
          linkId: link.id,
          senderPublicKey,
          s3Key,
          nonce: metadata.nonce,
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
          contentMD5: metadata.contentMD5,
          message: sanitizeMessage(message),
          status: "uploading",
        },
      });

      const uploadUrl = await getSignedUploadUrl(s3Key);
```
to:
```typescript
      const dropId = nanoid();
      const s3Key = `${link.id}/${dropId}`;
      const created = await prisma.drop.create({
        data: {
          id: dropId,
          linkId: link.id,
          senderPublicKey,
          s3Key,
          nonce: metadata.nonce,
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
          contentMD5: metadata.contentMD5,
          message: sanitizeMessage(message),
          status: "uploading",
        },
      });
      emitDropEvent(link.id, { type: "drop-created", drop: toDropSummary(created) });

      const uploadUrl = await getSignedUploadUrl(s3Key);
```
And in the `.../complete` handler, replace:
```typescript
      await prisma.drop.update({ where: { id: drop.id }, data: { status: "uploaded" } });
      return reply.send({ updated: true });
```
with:
```typescript
      const updated = await prisma.drop.update({ where: { id: drop.id }, data: { status: "uploaded" } });
      emitDropEvent(drop.linkId, { type: "drop-updated", drop: toDropSummary(updated) });
      return reply.send({ updated: true });
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- events downloads uploads`
Expected: PASS across all three suites.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/events.ts apps/api/src/routes/downloads.ts apps/api/src/routes/downloads.test.ts apps/api/src/routes/uploads.ts apps/api/src/routes/events.test.ts apps/api/src/server.ts
git commit -m "feat(api): add SSE drop-status stream, owner-checked downloads, and dropId selection"
```

### Task 8: Contacts-only upload enforcement

**Files:**
- Modify: `apps/api/src/routes/uploads.ts`
- Modify: `apps/api/src/routes/uploads.test.ts`

**Interfaces:**
- Consumes: `hasAcceptedContact` from `../lib/contacts` (Task 3).
- Produces: the `upload-url` handler now rejects (403) when `link.visibility === "contacts-only"` and the sender is either unauthenticated or not an accepted contact of `link.ownerId`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/uploads.test.ts`:

```typescript
it("rejects an anonymous sender on a contacts-only link", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "co-owner@example.com", emailVerified: false, name: "CO Owner", username: "coowner",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "Y28tb3duZXI=",
    },
  });
  const link = await prisma.link.create({
    data: {
      ownerId: owner.id, slug: "contacts-only-test", mode: "permanent",
      visibility: "contacts-only", recipientPublicKey: owner.publicKey,
    },
  });

  const response = await server.inject({
    method: "POST",
    url: `/api/links/${link.slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
  });

  expect(response.statusCode).toBe(403);
});

it("rejects an authenticated but non-contact sender on a contacts-only link", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "co-owner2@example.com", emailVerified: false, name: "CO Owner 2", username: "coowner2",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "Y28tb3duZXIy",
    },
  });
  const stranger = await prisma.user.create({
    data: {
      email: "stranger@example.com", emailVerified: false, name: "Stranger", username: "stranger",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "c3RyYW5nZXI=",
    },
  });
  const link = await prisma.link.create({
    data: {
      ownerId: owner.id, slug: "contacts-only-test2", mode: "permanent",
      visibility: "contacts-only", recipientPublicKey: owner.publicKey,
    },
  });

  const response = await server.inject({
    method: "POST",
    url: `/api/links/${link.slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    headers: { "x-test-user-id": stranger.id },
  });

  expect(response.statusCode).toBe(403);
});

it("rejects a sender whose contact request is still pending (not yet accepted)", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "co-owner2b@example.com", emailVerified: false, name: "CO Owner 2b", username: "coowner2b",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "Y28tb3duZXIyYg==",
    },
  });
  const pendingSender = await prisma.user.create({
    data: {
      email: "pending@example.com", emailVerified: false, name: "Pending", username: "pendingsender",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "cGVuZGluZw==",
    },
  });
  await prisma.contact.create({
    data: { userId: pendingSender.id, contactUserId: owner.id, status: "pending" },
  });
  const link = await prisma.link.create({
    data: {
      ownerId: owner.id, slug: "contacts-only-pending-test", mode: "permanent",
      visibility: "contacts-only", recipientPublicKey: owner.publicKey,
    },
  });

  const response = await server.inject({
    method: "POST",
    url: `/api/links/${link.slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    headers: { "x-test-user-id": pendingSender.id },
  });

  expect(response.statusCode).toBe(403);
});

it("allows an accepted contact to upload to a contacts-only link", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "co-owner3@example.com", emailVerified: false, name: "CO Owner 3", username: "coowner3",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "Y28tb3duZXIz",
    },
  });
  const friend = await prisma.user.create({
    data: {
      email: "friend@example.com", emailVerified: false, name: "Friend", username: "friend",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "ZnJpZW5k",
    },
  });
  await prisma.contact.create({ data: { userId: owner.id, contactUserId: friend.id, status: "accepted" } });
  const link = await prisma.link.create({
    data: {
      ownerId: owner.id, slug: "contacts-only-test3", mode: "permanent",
      visibility: "contacts-only", recipientPublicKey: owner.publicKey,
    },
  });

  const response = await server.inject({
    method: "POST",
    url: `/api/links/${link.slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    headers: { "x-test-user-id": friend.id },
  });

  expect(response.statusCode).toBe(200);
});

it("still allows an anonymous sender on a public permanent link", async () => {
  const server = buildServer();
  const owner = await prisma.user.create({
    data: {
      email: "co-owner4@example.com", emailVerified: false, name: "CO Owner 4", username: "coowner4",
      passwordHash: "x", passwordSalt: "x", passwordWrappedPrivateKey: "x",
      recoveryWrappedPrivateKey: "x", publicKey: "Y28tb3duZXI0",
    },
  });
  const link = await prisma.link.create({
    data: { ownerId: owner.id, slug: "public-permanent-test", mode: "permanent", recipientPublicKey: owner.publicKey },
  });

  const response = await server.inject({
    method: "POST",
    url: `/api/links/${link.slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
  });

  expect(response.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run test to verify the new tests fail**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- uploads`
Expected: FAIL on the four `contacts-only` cases (currently return 200 instead of the asserted 403/200); the "public permanent link" case already passes.

- [ ] **Step 3: Modify `apps/api/src/routes/uploads.ts`**

Add the import `import { hasAcceptedContact } from "../lib/contacts";`. Insert, immediately after the existing `isLinkExpired` check and before the one-time-queue-limit check:

```typescript
      if (link.visibility === "contacts-only") {
        const allowed = request.user
          ? await hasAcceptedContact(link.ownerId!, request.user.id)
          : false;
        if (!allowed) {
          return reply.status(403).send({ error: "This link only accepts uploads from approved contacts" });
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- uploads`
Expected: PASS (all thirteen upload tests: six from Plan 1, two from Task 1, five from this task).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/uploads.ts apps/api/src/routes/uploads.test.ts
git commit -m "feat(api): enforce contacts-only visibility on upload"
```

---

## Wave 3 — Frontend (parallel; each depends on the specific Wave 0-2 tasks noted)

### Task 9: UploadPage recipient identity branch

**Files:**
- Modify: `apps/web/src/components/UploadPage.tsx`
- Modify: `apps/web/src/components/UploadPage.test.tsx`
- Modify: `apps/web/src/locales/en/upload.json`, `apps/web/src/locales/nb/upload.json`

**Interfaces:**
- Consumes: the extended `LinkStatusResponse` (`recipientName?`, `recipientEmailVerified?`) from Task 2, via the existing `GET /api/links/:slug` call already in this component.
- Produces: for an owned link, the recipient badge shows the owner's name (labeled "entered by user, not verified") and an email-verified/unverified badge instead of the generic "Sending to a registered account" placeholder text Plan 1 shipped; the anonymous branch is untouched.

- [ ] **Step 1: Add the failing test**

Add to `apps/web/src/components/UploadPage.test.tsx`:

```tsx
it("shows the owner's name (unverified label) and email-verified badge for an owned link", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        recipientPublicKey: "cmVjaXBpZW50",
        isAnonymous: false,
        recipientName: "Ada Lovelace",
        recipientEmailVerified: true,
      }),
    })
  );

  renderAt("ada");

  await waitFor(() => {
    expect(screen.getByTestId("recipient-badge")).toHaveTextContent("Ada Lovelace");
    expect(screen.getByTestId("recipient-badge")).toHaveTextContent(/not verified/i);
    expect(screen.getByTestId("recipient-badge")).toHaveTextContent(/verified/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- UploadPage`
Expected: FAIL — the badge still renders the static `t("verifiedRecipient")` string, not the owner's name.

- [ ] **Step 3: Update locale files**

Add to `apps/web/src/locales/en/upload.json` (inside the existing object, replacing the `verifiedRecipient` key):
```json
  "recipientNameLabel": "{{name}} (entered by the user, not verified)",
  "emailVerified": "Email verified",
  "emailUnverified": "Email not verified",
```

Add to `apps/web/src/locales/nb/upload.json` similarly:
```json
  "recipientNameLabel": "{{name}} (angitt av brukeren, ikke verifisert)",
  "emailVerified": "E-post verifisert",
  "emailUnverified": "E-post ikke verifisert",
```

(`verifiedRecipient` can stay in both files unused, or be removed — either is fine, it's no longer referenced after Step 4.)

- [ ] **Step 4: Modify `apps/web/src/components/UploadPage.tsx`**

Change the `LinkStatus` interface from:
```typescript
interface LinkStatus {
  recipientPublicKey: string;
  isAnonymous: boolean;
}
```
to:
```typescript
interface LinkStatus {
  recipientPublicKey: string;
  isAnonymous: boolean;
  recipientName?: string;
  recipientEmailVerified?: boolean;
}
```

Change the fetch-then-`setLink` call from:
```typescript
      .then((data) => setLink({ recipientPublicKey: data.recipientPublicKey, isAnonymous: data.isAnonymous }))
```
to:
```typescript
      .then((data) =>
        setLink({
          recipientPublicKey: data.recipientPublicKey,
          isAnonymous: data.isAnonymous,
          recipientName: data.recipientName,
          recipientEmailVerified: data.recipientEmailVerified,
        })
      )
```

Change the badge markup from:
```tsx
        <div data-testid="recipient-badge">
          {link.isAnonymous ? t("anonymousRecipient") : t("verifiedRecipient")}
        </div>
```
to:
```tsx
        <div data-testid="recipient-badge">
          {link.isAnonymous ? (
            t("anonymousRecipient")
          ) : (
            <>
              {t("recipientNameLabel", { name: link.recipientName })}
              {" — "}
              {link.recipientEmailVerified ? t("emailVerified") : t("emailUnverified")}
            </>
          )}
        </div>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- UploadPage`
Expected: PASS (all three tests — two from Plan 1, one new).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/UploadPage.tsx apps/web/src/components/UploadPage.test.tsx apps/web/src/locales/en/upload.json apps/web/src/locales/nb/upload.json
git commit -m "feat(web): show owner name/email-verified badge on owned link upload page"
```

### Task 10: Contacts page and "send to contact" shortcut

**Files:**
- Create: `apps/web/src/components/ContactsPage.tsx`
- Create: `apps/web/src/locales/en/contacts.json`, `apps/web/src/locales/nb/contacts.json`
- Test: `apps/web/src/components/ContactsPage.test.tsx`

**Interfaces:**
- Consumes: `useAuth` from `@/hooks/useAuth` (Plan 2, for `user`); talks to `GET /api/contacts`, `POST /api/contacts`, `POST /api/contacts/:id/accept`, `POST /api/contacts/:id/reject` (Task 3) over `fetch`.
- Produces: `<ContactsPage />`, routed at `/contacts` by Task 13. Each accepted contact row links to `/send/:username` (Plan 1's real sender route, using the contact's `username` as the slug — valid because every account's default personal link's slug equals its username per spec §5).

- [ ] **Step 1: Write locale files**

```json
// apps/web/src/locales/en/contacts.json
{
  "title": "Contacts",
  "addPlaceholder": "Username to add",
  "addButton": "Send request",
  "pendingHeading": "Pending",
  "acceptedHeading": "Contacts",
  "acceptButton": "Accept",
  "rejectButton": "Reject",
  "sendFileButton": "Send a file",
  "incoming": "wants to connect",
  "outgoing": "request sent",
  "errors": { "addFailed": "Could not send that request." }
}
```

```json
// apps/web/src/locales/nb/contacts.json
{
  "title": "Kontakter",
  "addPlaceholder": "Brukernavn å legge til",
  "addButton": "Send forespørsel",
  "pendingHeading": "Ventende",
  "acceptedHeading": "Kontakter",
  "acceptButton": "Godta",
  "rejectButton": "Avvis",
  "sendFileButton": "Send en fil",
  "incoming": "ønsker kontakt",
  "outgoing": "forespørsel sendt",
  "errors": { "addFailed": "Kunne ikke sende forespørselen." }
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/components/ContactsPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "me", publicKey: "x" }, login: vi.fn(), logout: vi.fn(), register: vi.fn() }),
}));

import { ContactsPage } from "./ContactsPage";

describe("ContactsPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pending: [{ id: "c1", userId: "u2", username: "bob", status: "pending", direction: "incoming" }],
          accepted: [{ id: "c2", userId: "u3", username: "carol", status: "accepted", direction: "outgoing" }],
        }),
      })
    );
  });

  it("renders pending and accepted contacts, with a send-file link for accepted ones", async () => {
    render(
      <MemoryRouter>
        <ContactsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("bob")).toBeInTheDocument();
      expect(screen.getByText("carol")).toBeInTheDocument();
    });
    const sendLink = screen.getByRole("link", { name: /send a file/i });
    expect(sendLink).toHaveAttribute("href", "/send/carol");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- ContactsPage`
Expected: FAIL — `./ContactsPage` module not found.

- [ ] **Step 4: Write `apps/web/src/components/ContactsPage.tsx`**

```tsx
// apps/web/src/components/ContactsPage.tsx
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import contactsEn from "@/locales/en/contacts.json";
import contactsNb from "@/locales/nb/contacts.json";

i18n.addResourceBundle("en", "contacts", contactsEn, true, false);
i18n.addResourceBundle("nb", "contacts", contactsNb, true, false);

interface ContactSummary {
  id: string;
  userId: string;
  username: string;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing";
}

export function ContactsPage() {
  const { t } = useTranslation("contacts");
  const [pending, setPending] = useState<ContactSummary[]>([]);
  const [accepted, setAccepted] = useState<ContactSummary[]>([]);
  const [usernameInput, setUsernameInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/contacts");
    if (!res.ok) return;
    const data = await res.json();
    setPending(data.pending);
    setAccepted(data.accepted);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const sendRequest = async () => {
    setError(null);
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usernameInput }),
    });
    if (!res.ok) {
      setError(t("errors.addFailed"));
      return;
    }
    setUsernameInput("");
    await reload();
  };

  const accept = async (id: string) => {
    await fetch(`/api/contacts/${id}/accept`, { method: "POST" });
    await reload();
  };

  const reject = async (id: string) => {
    await fetch(`/api/contacts/${id}/reject`, { method: "POST" });
    await reload();
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex gap-2">
          <input
            value={usernameInput}
            onChange={(e) => setUsernameInput(e.target.value)}
            placeholder={t("addPlaceholder")}
            className="flex-1 rounded border p-2 text-sm"
          />
          <Button onClick={sendRequest}>{t("addButton")}</Button>
        </div>
        {error && <p role="alert">{error}</p>}

        <div>
          <h2 className="font-semibold">{t("pendingHeading")}</h2>
          {pending.map((contact) => (
            <div key={contact.id} className="flex items-center justify-between py-1">
              <span>
                {contact.username} ({contact.direction === "incoming" ? t("incoming") : t("outgoing")})
              </span>
              {contact.direction === "incoming" && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => accept(contact.id)}>
                    {t("acceptButton")}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => reject(contact.id)}>
                    {t("rejectButton")}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div>
          <h2 className="font-semibold">{t("acceptedHeading")}</h2>
          {accepted.map((contact) => (
            <div key={contact.id} className="flex items-center justify-between py-1">
              <span>{contact.username}</span>
              <Button asChild size="sm">
                <Link to={`/send/${contact.username}`}>{t("sendFileButton")}</Link>
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- ContactsPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ContactsPage.tsx apps/web/src/components/ContactsPage.test.tsx apps/web/src/locales/en/contacts.json apps/web/src/locales/nb/contacts.json
git commit -m "feat(web): add contacts page with request/accept/reject and send-to-contact shortcut"
```

### Task 11: Custom link creation UI

**Files:**
- Create: `apps/web/src/components/NewLinkPage.tsx`
- Create: `apps/web/src/locales/en/newLink.json`, `apps/web/src/locales/nb/newLink.json`
- Test: `apps/web/src/components/NewLinkPage.test.tsx`

**Interfaces:**
- Consumes: talks to `POST /api/links/custom` (Task 5) over `fetch`.
- Produces: `<NewLinkPage />`, routed at `/links/new` by Task 13.

- [ ] **Step 1: Write locale files**

```json
// apps/web/src/locales/en/newLink.json
{
  "title": "Create a named link",
  "slugLabel": "Link name (letters, digits, hyphens)",
  "modeLabel": "Type",
  "modePermanent": "Permanent (accepts multiple files over time)",
  "modeOneTime": "One-time (expires after one file)",
  "visibilityLabel": "Who can send to it",
  "visibilityPublic": "Anyone with the link",
  "visibilityContactsOnly": "Only my accepted contacts",
  "createButton": "Create link",
  "success": "Link created:",
  "errors": { "createFailed": "Could not create that link. The name might already be taken." }
}
```

```json
// apps/web/src/locales/nb/newLink.json
{
  "title": "Opprett en navngitt lenke",
  "slugLabel": "Lenkenavn (bokstaver, tall, bindestrek)",
  "modeLabel": "Type",
  "modePermanent": "Permanent (tar imot flere filer over tid)",
  "modeOneTime": "Engangs (utløper etter én fil)",
  "visibilityLabel": "Hvem som kan sende til den",
  "visibilityPublic": "Alle med lenken",
  "visibilityContactsOnly": "Kun mine godkjente kontakter",
  "createButton": "Opprett lenke",
  "success": "Lenke opprettet:",
  "errors": { "createFailed": "Kunne ikke opprette lenken. Navnet kan allerede være i bruk." }
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/components/NewLinkPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewLinkPage } from "./NewLinkPage";

describe("NewLinkPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ linkId: "l1", slug: "team-drop" }) })
    );
  });

  it("submits the form and shows the created link", async () => {
    render(<NewLinkPage />);

    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(screen.getByText(/team-drop/)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- NewLinkPage`
Expected: FAIL — `./NewLinkPage` module not found.

- [ ] **Step 4: Write `apps/web/src/components/NewLinkPage.tsx`**

```tsx
// apps/web/src/components/NewLinkPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import newLinkEn from "@/locales/en/newLink.json";
import newLinkNb from "@/locales/nb/newLink.json";

i18n.addResourceBundle("en", "newLink", newLinkEn, true, false);
i18n.addResourceBundle("nb", "newLink", newLinkNb, true, false);

export function NewLinkPage() {
  const { t } = useTranslation("newLink");
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<"permanent" | "one-time">("permanent");
  const [visibility, setVisibility] = useState<"public" | "contacts-only">("public");
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const res = await fetch("/api/links/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, mode, visibility }),
    });
    if (!res.ok) {
      setError(t("errors.createFailed"));
      return;
    }
    const body = await res.json();
    setCreatedSlug(body.slug);
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {createdSlug && (
          <p>
            {t("success")} <code>{createdSlug}</code>
          </p>
        )}
        <div>
          <label htmlFor="slug">{t("slugLabel")}</label>
          <input id="slug" value={slug} onChange={(e) => setSlug(e.target.value)} className="w-full rounded border p-2 text-sm" />
        </div>
        <div>
          <label htmlFor="mode">{t("modeLabel")}</label>
          <select
            id="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as "permanent" | "one-time")}
            className="w-full rounded border p-2 text-sm"
          >
            <option value="permanent">{t("modePermanent")}</option>
            <option value="one-time">{t("modeOneTime")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="visibility">{t("visibilityLabel")}</label>
          <select
            id="visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "public" | "contacts-only")}
            className="w-full rounded border p-2 text-sm"
          >
            <option value="public">{t("visibilityPublic")}</option>
            <option value="contacts-only">{t("visibilityContactsOnly")}</option>
          </select>
        </div>
        <Button onClick={submit}>{t("createButton")}</Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- NewLinkPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/NewLinkPage.tsx apps/web/src/components/NewLinkPage.test.tsx apps/web/src/locales/en/newLink.json apps/web/src/locales/nb/newLink.json
git commit -m "feat(web): add custom named link creation form"
```

### Task 12: DownloadPage rewrite — SSE and queue view

**Files:**
- Modify: `apps/web/src/components/DownloadPage.tsx`
- Modify: `apps/web/src/components/DownloadPage.test.tsx`
- Modify: `apps/web/src/locales/en/download.json`, `apps/web/src/locales/nb/download.json`

**Interfaces:**
- Consumes: `useLocalLinks` (Plan 1 Task 13, unchanged — anonymous branch); `useFileEncryption` (Plan 1 Task 8, unchanged); **assumed** `keyPair` from `useAuth()` (Plan 2 — see this plan's header note); talks to `GET /api/links/:slug` (unchanged, one-time/anonymous snapshot), `GET /api/links/:slug/drops` (Task 6, owned-link snapshot), `GET /api/links/:slug/events` (Task 7, SSE for both), `GET /api/links/:slug/download-url?dropId=` (Task 7), `POST /api/links/:slug/drops/:dropId/downloaded` (Plan 1 Task 11, unchanged).
- Produces: `<DownloadPage />` now branches on whether `useAuth().user` is set and matches the link's owner (queue view, SSE-driven, multiple simultaneous drops with individual download buttons) versus the existing anonymous/one-time single-drop view (now SSE-driven instead of 3-second polling, otherwise unchanged behavior).

- [ ] **Step 1: Add the failing test for the owned-link queue view**

Add to `apps/web/src/components/DownloadPage.test.tsx`, alongside the existing `vi.mock` calls at the top of the file:

```tsx
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "owner1", username: "ada", publicKey: "b3duZXJrZXk=" },
    keyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
  }),
}));
```

and a new test:

```tsx
describe("DownloadPage — owned permanent link queue", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.toString().includes("/drops")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              drops: [
                { id: "d1", status: "uploaded", fileName: "first.pdf", message: null },
                { id: "d2", status: "uploaded", fileName: "second.pdf", message: "hi" },
              ],
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      })
    );
    class FakeEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("lists every queued drop for an owned permanent link", async () => {
    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText("first.pdf")).toBeInTheDocument();
      expect(screen.getByText("second.pdf")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- DownloadPage`
Expected: FAIL — the current component only ever renders a single `drop`, sourced from `useLocalLinks`, and has no owned-link branch.

- [ ] **Step 3: Update locale files** — add to both `apps/web/src/locales/en/download.json` and `apps/web/src/locales/nb/download.json`:

English additions:
```json
  "queueEmpty": "No files waiting.",
  "queueTitle": "Incoming files"
```
Norwegian additions:
```json
  "queueEmpty": "Ingen filer venter.",
  "queueTitle": "Innkommende filer"
```

- [ ] **Step 4: Rewrite `apps/web/src/components/DownloadPage.tsx`**

```tsx
// apps/web/src/components/DownloadPage.tsx
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { decodeBase64 } from "tweetnacl-util";
import nacl from "tweetnacl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import downloadEn from "@/locales/en/download.json";
import downloadNb from "@/locales/nb/download.json";

i18n.addResourceBundle("en", "download", downloadEn, true, false);
i18n.addResourceBundle("nb", "download", downloadNb, true, false);

interface DropInfo {
  id: string;
  status: string;
  fileName: string;
  message: string | null;
}

export function DownloadPage() {
  const { t } = useTranslation("download");
  const { slug } = useParams<{ slug: string }>();
  const { links } = useLocalLinks();
  const { keyPair: authKeyPair } = useAuth();
  const { setKeyPair, decryptFile } = useFileEncryption();
  const [drops, setDrops] = useState<DropInfo[]>([]);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const stored = slug ? links[slug] : undefined;
  const owned = Boolean(authKeyPair && !stored);

  useEffect(() => {
    if (stored) {
      setKeyPair(nacl.box.keyPair.fromSecretKey(decodeBase64(stored.privateKey)));
    } else if (authKeyPair) {
      setKeyPair(authKeyPair);
    }
  }, [stored, authKeyPair, setKeyPair]);

  useEffect(() => {
    if (!slug) return;

    async function loadSnapshot() {
      if (owned) {
        const res = await fetch(`/api/links/${slug}/drops`);
        if (!res.ok) {
          setError(t("errors.linkNotFound"));
          return;
        }
        const data = await res.json();
        setDrops(data.drops);
      } else {
        const res = await fetch(`/api/links/${slug}`);
        if (!res.ok) {
          setError(t("errors.linkNotFound"));
          return;
        }
        const data = await res.json();
        setDrops(data.drop ? [data.drop] : []);
      }
    }
    loadSnapshot();

    const source = new EventSource(`/api/links/${slug}/events`);
    eventSourceRef.current = source;
    source.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as { type: string; drop: DropInfo };
      setDrops((prev) => {
        const withoutThisDrop = prev.filter((existing) => existing.id !== parsed.drop.id);
        return [...withoutThisDrop, parsed.drop];
      });
    };

    return () => {
      source.close();
    };
  }, [slug, owned, t]);

  const handleDownload = async (drop: DropInfo) => {
    if (!slug) return;
    try {
      const res = await fetch(`/api/links/${slug}/download-url?dropId=${drop.id}`);
      if (!res.ok) throw new Error("download-url failed");
      const info = await res.json();
      const fileRes = await fetch(info.downloadUrl);
      const blob = await fileRes.blob();
      const file = await decryptFile(blob, {
        nonce: info.nonce,
        senderPublicKey: info.senderPublicKey,
        fileName: info.fileName,
        mimeType: info.mimeType,
      });
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
      await fetch(`/api/links/${slug}/drops/${drop.id}/downloaded`, { method: "POST" });
      setDownloadedIds((prev) => new Set(prev).add(drop.id));
    } catch {
      setError(t("errors.downloadFailed"));
    }
  };

  if (!stored && !owned) return <p>{t("errors.noLocalKey")}</p>;
  if (error) return <p role="alert">{error}</p>;

  const visibleDrops = drops.filter(
    (drop) => drop.status === "uploaded" && !downloadedIds.has(drop.id)
  );

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{owned ? t("queueTitle") : t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {visibleDrops.length === 0 && <p>{owned ? t("queueEmpty") : t("waitingForFile")}</p>}
        {visibleDrops.map((drop) => (
          <div key={drop.id} className="space-y-2 border-b pb-4 last:border-0">
            <p>{drop.fileName}</p>
            {drop.message && <p className="italic">{drop.message}</p>}
            <Button onClick={() => handleDownload(drop)}>{t("downloadButton")}</Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- DownloadPage`
Expected: PASS (both the original Plan 1 test — now driven by the mocked `EventSource` instead of polling — and the new queue test). The Plan 1 test's `fetch` mock returns `{drop: {...}}` from `GET /api/links/:slug`, which this rewrite still reads via `loadSnapshot`'s non-owned branch, so no change to that test file's setup is required beyond adding the `useAuth` mock (Step 1) and the `EventSource` stub (also needed by the original test now, since every code path constructs an `EventSource`) — add the same `FakeEventSource` `vi.stubGlobal` to the original `describe("DownloadPage", ...)` block's `beforeEach` alongside its existing `fetch` stub.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/DownloadPage.tsx apps/web/src/components/DownloadPage.test.tsx apps/web/src/locales/en/download.json apps/web/src/locales/nb/download.json
git commit -m "feat(web): replace download polling with SSE and add owned-link queue view"
```

---

## Wave 4 — Integration (sequential; depends on all of Wave 3)

### Task 13: Route the new pages

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `<ContactsPage />` (Task 10), `<NewLinkPage />` (Task 11).
- Produces: `/contacts` and `/links/new` added to the router, alongside Plan 1's existing four routes.

- [ ] **Step 1: Add the failing test**

Add to `apps/web/src/App.test.tsx`:

```tsx
it("renders the contacts page at /contacts", () => {
  vi.mock("@/hooks/useAuth", () => ({
    useAuth: () => ({ user: { id: "u1", username: "me", publicKey: "x" }, login: vi.fn(), logout: vi.fn(), register: vi.fn() }),
  }));
  render(
    <MemoryRouter initialEntries={["/contacts"]}>
      <App />
    </MemoryRouter>
  );
  expect(screen.getByText(/contacts/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- App`
Expected: FAIL — `/contacts` isn't routed, so nothing matching "contacts" renders.

- [ ] **Step 3: Modify `apps/web/src/App.tsx`**

Add the imports `import { ContactsPage } from "@/components/ContactsPage";` and `import { NewLinkPage } from "@/components/NewLinkPage";`, and add inside `<Routes>`:
```tsx
      <Route path="/contacts" element={<ContactsPage />} />
      <Route path="/links/new" element={<NewLinkPage />} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- App`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): route the contacts and new-link pages"
```

---

## Post-plan reconciliation note

Two assumptions in this plan need a one-line confirmation against Plan 2's actual output once both land on the same branch, since Plan 2 was written in parallel without visibility into this plan and vice versa:

1. **Auth test-faking mechanism.** Tasks 3, 5, 6, 7, and 8 use an `x-test-user-id` request header as a stand-in for an authenticated `request.user` inside Fastify `.inject()` calls, since this plan cannot see how Plan 2's own test suite fakes a session. Replace every occurrence with whatever Plan 2 actually uses (e.g. a signed test cookie, a `request.user` override option on `buildServer()`, or similar) before running this plan's test suite for real.
2. **`useAuth().keyPair`.** Task 12 assumes `useAuth()` exposes the logged-in user's decrypted `nacl.BoxKeyPair` under a `keyPair` field, which the Plan 2 contract handed to this plan's author did not explicitly promise (it only specified `user: { id, username, publicKey }`). If Plan 2 exposes the decrypted secret key differently, update Task 12 Step 4's `authKeyPair` source accordingly — everything else in this plan is independent of that name.