# Account Deletion, Retention Polish & Deployment Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is Plan 4 of 4 and assumes Plans 1 ("infra + anonymous flow"), 2 ("accounts and key management"), and 3 ("permanent links, contacts, SSE") are already implemented. Tasks are grouped into **Waves**; all tasks within a wave are mutually independent and MAY be dispatched to parallel subagents.

**Goal:** Close the three loose ends left after Plans 1-3: extend the retention sweep to cover permanent-link drop queues (not just expired one-time links), add account deletion (password-confirmed, cascade-deletes links/drops/MinIO objects/sessions/contacts), add an automated `en`/`nb` locale-parity check, and finish `.env.example`/`README.md` so the repo is genuinely clone-and-run for a stranger.

**Architecture:** All four pieces of work touch existing services from Plans 1-3 rather than adding new ones: the `cleanup` service gets a second sweep function, `api` gets one new authenticated route, `web` gets one new dialog component, and a small standalone Node script plus root-level documentation close out the "generic self-hostable app" requirement. No new Docker Compose services.

**Tech Stack:** Same as Plans 1-3 — Node.js/Fastify/Prisma backend, Vite/React/shadcn frontend, `argon2` for password verification.

**Spec:** `docs/superpowers/specs/2026-09-24-e2ee-drop-rewrite-design.md`

## Global Constraints

- This plan assumes Plans 1, 2, and 3 are already merged. It reuses, and must not redefine, the `User`, `Session`, `Contact`, `Link`, `Drop` Prisma models and the generated types from `@e2ee-drop/db`.
- All Link/Drop/MinIO cleanup for a user is delegated to `cascadeDeleteUserLinks(userId: string): Promise<void>` in `apps/api/src/lib/accountDeletion.ts`, produced by Plan 2 (it already uses this for its password-reset-without-recovery-code flow). This plan must not reimplement that logic — only call it.
- The account-deletion route is authenticated via `server.requireAuth` from `apps/api/src/plugins/auth.ts` (Plan 2). This plan assumes that decorator attaches the caller as `request.user.id` (Fastify's standard convention); Task 2 flags this as the single line to adjust if Plan 2's actual decoration differs.
- The account-deletion HTTP contract fixed by this plan (both the backend route in Task 2 and the frontend dialog in Task 3 build against this, independently, in the same wave): `DELETE /api/account`, JSON body `{ password: string }`, requires an authenticated session, requires the caller's current password as re-confirmation before anything is deleted.
- `Drop` retention uses `Link.retentionDays` (per-link override) falling back to `env.DROP_RETENTION_DAYS` (global default already defined in `apps/api/src/env.ts` from Plan 1) — spec §10.
- One-time links (anonymous or owned) keep using `runCleanup()` from Plan 1 unchanged; the new sweep in this plan only ever touches `Drop` rows belonging to `mode: "permanent"` links, and never deletes the `Link` row itself.
- `en`/`nb` locale parity is enforced by an automated check that exits non-zero on any mismatch (spec §11) — not left to manual review.
- No bundled reverse proxy/TLS; `README.md` must say operators front the `web` service themselves (spec §9.2).

## Review Focus

- Deleting an account must not leave it half-deleted if `cascadeDeleteUserLinks` fails partway (e.g. MinIO temporarily unreachable): the `User`/`Session`/`Contact` rows must only be removed after link/drop cleanup has fully succeeded — covered in Task 2.
- Deleting an account must also remove `Contact` rows where the deleted user is the *target* of a still-pending request, not only rows where they are the requester — covered in Task 2.
- A `Drop` belonging to a still-valid permanent link (the link itself has no expiry) must survive the sweep while it's within its retention window, and must only be removed once it's past that window — covered in Task 1.
- A link's own `retentionDays` override must take precedence over the global `DROP_RETENTION_DAYS` default when computing a drop's cutoff — covered in Task 1.
- The i18n parity checker must fail loudly (non-zero exit, listing every missing file/key) on any `en`/`nb` mismatch, not merely log a warning that could be ignored in CI — covered in Task 4.

---

## Wave 1 — Parallel polish tasks (all depend only on Plans 1-3 being implemented; mutually independent)

### Task 1: Extend the cleanup job to sweep expired drops on permanent links

**Files:**
- Modify: `apps/api/src/jobs/cleanup.ts`
- Modify: `apps/api/src/jobs/cleanup.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@e2ee-drop/db`; `deleteObject` from `../lib/storage`; `env` from `../env` (all already exist, Plan 1).
- Produces: `sweepExpiredDrops(): Promise<{ deletedDrops: number }>`, exported alongside the existing `runCleanup()`, and called by this file's `main()` loop every tick.

- [ ] **Step 1: Write the failing tests** (add to the existing `apps/api/src/jobs/cleanup.test.ts`, which already has `runCleanup` tests and the `vi.mock("../lib/storage", ...)` at the top — add a new `describe("sweepExpiredDrops", ...)` block and the new import)

```typescript
// apps/api/src/jobs/cleanup.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("../lib/storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { runCleanup, sweepExpiredDrops } from "./cleanup";

describe("runCleanup", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("deletes expired one-time links and their drops", async () => {
    await prisma.link.create({
      data: {
        slug: "expired-link",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.link.create({
      data: {
        slug: "fresh-link",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await runCleanup();

    expect(result.deletedLinks).toBe(1);
    expect(await prisma.link.findFirst({ where: { slug: "expired-link" } })).toBeNull();
    expect(await prisma.link.findFirst({ where: { slug: "fresh-link" } })).not.toBeNull();
  });
});

describe("sweepExpiredDrops", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  const dropDefaults = {
    senderPublicKey: "c2VuZGVy",
    nonce: "bm9uY2U=",
    fileName: "report.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
    contentMD5: "bWQ1",
    status: "uploaded" as const,
  };

  it("deletes a drop on a permanent link once it is older than the global retention default", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-1", mode: "permanent", recipientPublicKey: "x" },
    });
    const oldDrop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/old`,
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago, default retention is 7
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.deletedDrops).toBe(1);
    expect(await prisma.drop.findUnique({ where: { id: oldDrop.id } })).toBeNull();
    expect(await prisma.link.findUnique({ where: { id: link.id } })).not.toBeNull();
  });

  it("keeps a drop that is still within the retention window", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-2", mode: "permanent", recipientPublicKey: "x" },
    });
    const freshDrop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/fresh`,
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.deletedDrops).toBe(0);
    expect(await prisma.drop.findUnique({ where: { id: freshDrop.id } })).not.toBeNull();
  });

  it("honors a link's own retentionDays override over the global default", async () => {
    const link = await prisma.link.create({
      data: { slug: "perm-3", mode: "permanent", recipientPublicKey: "x", retentionDays: 1 },
    });
    const drop = await prisma.drop.create({
      data: {
        ...dropDefaults,
        linkId: link.id,
        s3Key: `${link.id}/short-retention`,
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago, override is 1 day
      },
    });

    const result = await sweepExpiredDrops();

    expect(result.deletedDrops).toBe(1);
    expect(await prisma.drop.findUnique({ where: { id: drop.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- cleanup`
Expected: the `runCleanup` tests still PASS; the three new `sweepExpiredDrops` tests FAIL — `sweepExpiredDrops` is not exported yet.

- [ ] **Step 3: Rewrite `apps/api/src/jobs/cleanup.ts`**

```typescript
// apps/api/src/jobs/cleanup.ts
import { prisma } from "@e2ee-drop/db";
import { deleteObject } from "../lib/storage";
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
    await prisma.link.delete({ where: { id: link.id } });
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

async function main() {
  const INTERVAL_MS = 15 * 60 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const linkResult = await runCleanup();
      const dropResult = await sweepExpiredDrops();
      console.log(
        `[cleanup] removed ${linkResult.deletedLinks} expired link(s), ${dropResult.deletedDrops} expired drop(s)`
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
```

- [ ] **Step 4: Run tests to verify they all pass**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- cleanup`
Expected: PASS (all four tests — one `runCleanup`, three `sweepExpiredDrops`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/cleanup.ts apps/api/src/jobs/cleanup.test.ts
git commit -m "feat(api): sweep expired drops on permanent links, respecting per-link retention overrides"
```

### Task 2: Account deletion route (password-confirmed, cascade-deletes links/drops/sessions/contacts)

**Files:**
- Create: `apps/api/src/routes/account.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/src/routes/account.test.ts`

**Interfaces:**
- Consumes: `cascadeDeleteUserLinks(userId: string): Promise<void>` from `../lib/accountDeletion` (Plan 2); `server.requireAuth` from Plan 2's auth plugin, assumed to decorate the request as `request.user.id`; `prisma` from `@e2ee-drop/db` (`User`, `Session`, `Contact` models from Plan 2).
- Produces: registers `DELETE /api/account` — consumed by Task 3's frontend dialog over HTTP, per the contract fixed in Global Constraints.

- [ ] **Step 1: Ensure `argon2` is a dependency of `apps/api`**

Edit `apps/api/package.json`, add to `dependencies` if not already present (Plan 2 very likely already added this for password hashing — this step is a no-op if so): `"argon2": "^0.41.1"`.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/src/routes/account.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import argon2 from "argon2";
import { prisma } from "@e2ee-drop/db";

vi.mock("../lib/accountDeletion", () => ({
  cascadeDeleteUserLinks: vi.fn().mockResolvedValue(undefined),
}));

import { cascadeDeleteUserLinks } from "../lib/accountDeletion";
import { registerAccountRoutes } from "./account";

async function buildTestServer(userId: string) {
  const server = Fastify();
  server.decorate("requireAuth", async (request: any) => {
    request.user = { id: userId };
  });
  registerAccountRoutes(server);
  return server;
}

async function createTestUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: "Delete Me",
      passwordHash: await argon2.hash("correct-horse-battery-staple"),
      publicKey: "cHVibGlj",
      passwordWrappedPrivateKey: "d3JhcHBlZA==",
      recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
      passwordSalt: "c2FsdA==",
    },
  });
}

describe("DELETE /api/account", () => {
  let userId: string;

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    vi.mocked(cascadeDeleteUserLinks).mockClear().mockResolvedValue(undefined);

    const user = await createTestUser("delete-me@example.com");
    userId = user.id;
  });

  it("deletes the account, its sessions, and both directions of its contacts when the password is correct", async () => {
    await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 60_000) } });
    const otherUser = await createTestUser("other@example.com");
    await prisma.contact.create({ data: { userId, contactUserId: otherUser.id, status: "pending" } });
    await prisma.contact.create({ data: { userId: otherUser.id, contactUserId: userId, status: "pending" } });

    const server = await buildTestServer(userId);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { password: "correct-horse-battery-staple" },
    });

    expect(response.statusCode).toBe(200);
    expect(cascadeDeleteUserLinks).toHaveBeenCalledWith(userId);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.session.findMany({ where: { userId } })).toHaveLength(0);
    expect(
      await prisma.contact.findMany({ where: { OR: [{ userId }, { contactUserId: userId }] } })
    ).toHaveLength(0);
    // the other user's own row is untouched
    expect(await prisma.user.findUnique({ where: { id: otherUser.id } })).not.toBeNull();
  });

  it("rejects deletion with the wrong password and leaves the account intact", async () => {
    const server = await buildTestServer(userId);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { password: "wrong-password" },
    });

    expect(response.statusCode).toBe(403);
    expect(cascadeDeleteUserLinks).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it("does not delete the user row if cascadeDeleteUserLinks fails", async () => {
    vi.mocked(cascadeDeleteUserLinks).mockRejectedValueOnce(new Error("MinIO unavailable"));

    const server = await buildTestServer(userId);
    const response = await server.inject({
      method: "DELETE",
      url: "/api/account",
      payload: { password: "correct-horse-battery-staple" },
    });

    expect(response.statusCode).toBe(500);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- account`
Expected: FAIL — `./account` route module not found.

- [ ] **Step 4: Write `apps/api/src/routes/account.ts`**

```typescript
// apps/api/src/routes/account.ts
import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { prisma } from "@e2ee-drop/db";
import { cascadeDeleteUserLinks } from "../lib/accountDeletion";

export function registerAccountRoutes(server: FastifyInstance): void {
  server.delete<{ Body: { password: string } }>(
    "/api/account",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      // Assumes Plan 2's requireAuth decorates the request as `request.user.id`
      // (Fastify's standard convention for auth plugins). If
      // apps/api/src/plugins/auth.ts decorates it differently (e.g.
      // request.session.userId), this is the one line to change.
      const userId = (request as unknown as { user: { id: string } }).user.id;

      const { password } = request.body;
      if (!password) {
        return reply.status(400).send({ error: "Password confirmation is required" });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.status(404).send({ error: "Account not found" });

      const passwordValid = await argon2.verify(user.passwordHash, password);
      if (!passwordValid) {
        return reply.status(403).send({ error: "Incorrect password" });
      }

      // Delete links/drops/MinIO objects FIRST. If this throws (e.g. MinIO is
      // temporarily unreachable), we abort before touching Session/Contact/User
      // rows, so a storage outage never leaves the account half-deleted — the
      // whole operation can simply be retried once storage is back.
      await cascadeDeleteUserLinks(userId);

      await prisma.$transaction([
        prisma.session.deleteMany({ where: { userId } }),
        prisma.contact.deleteMany({ where: { OR: [{ userId }, { contactUserId: userId }] } }),
        prisma.user.delete({ where: { id: userId } }),
      ]);

      return reply.send({ deleted: true });
    }
  );
}
```

- [ ] **Step 5: Register the routes in `apps/api/src/server.ts`** — add the import and the `registerAccountRoutes(server)` call alongside the existing route registrations from Plans 1-3 (exact surrounding lines depend on what Plans 2/3 already added; the two lines below are what this task contributes):

```typescript
import { registerAccountRoutes } from "./routes/account";
// ...inside buildServer(), alongside the other registerXRoutes(server) calls:
registerAccountRoutes(server);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- account`
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/account.ts apps/api/src/routes/account.test.ts apps/api/src/server.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add password-confirmed account deletion, cascading to links/drops/sessions/contacts"
```

### Task 3: Account deletion confirmation dialog

**Files:**
- Create: `apps/web/src/components/DeleteAccountDialog.tsx`
- Create: `apps/web/src/locales/en/deleteAccount.json`, `apps/web/src/locales/nb/deleteAccount.json`
- Test: `apps/web/src/components/DeleteAccountDialog.test.tsx`

**Interfaces:**
- Consumes: `DELETE /api/account` (the contract fixed in Global Constraints, independent of Task 2's actual file so this task can proceed in parallel with it); shadcn's `alert-dialog` component.
- Produces: `<DeleteAccountDialog onDeleted={() => void}>` — a self-contained component intended to be mounted on whatever account/settings page Plans 2/3 built; this task does not wire it into routing, since that page is outside this plan's scope.

- [ ] **Step 1: Add the shadcn alert-dialog component (idempotent if Plans 2/3 already added it)**

Run: `pnpm --filter @e2ee-drop/web dlx shadcn@latest add alert-dialog`
Expected: `apps/web/src/components/ui/alert-dialog.tsx` exists.

- [ ] **Step 2: Write locale files**

```json
// apps/web/src/locales/en/deleteAccount.json
{
  "triggerButton": "Delete account",
  "title": "Delete your account?",
  "warning": "This permanently deletes your account, all your links, every file waiting in them, and your contacts. This cannot be undone.",
  "passwordPlaceholder": "Confirm your password",
  "cancel": "Cancel",
  "confirmButton": "Permanently delete my account",
  "errors": { "unknown": "Something went wrong. Please try again." }
}
```

```json
// apps/web/src/locales/nb/deleteAccount.json
{
  "triggerButton": "Slett konto",
  "title": "Slette kontoen din?",
  "warning": "Dette sletter kontoen din, alle lenkene dine, alle filer som venter i dem, og kontaktene dine, for godt. Dette kan ikke angres.",
  "passwordPlaceholder": "Bekreft passordet ditt",
  "cancel": "Avbryt",
  "confirmButton": "Slett kontoen min for godt",
  "errors": { "unknown": "Noe gikk galt. Prøv igjen." }
}
```

- [ ] **Step 3: Write the failing test**

```tsx
// apps/web/src/components/DeleteAccountDialog.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeleteAccountDialog } from "./DeleteAccountDialog";

describe("DeleteAccountDialog", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) }));
  });

  it("keeps the confirm button disabled until a password is entered, then calls onDeleted on success", async () => {
    const onDeleted = vi.fn();
    render(<DeleteAccountDialog onDeleted={onDeleted} />);

    fireEvent.click(screen.getByText(/delete account/i));
    const confirmButton = await screen.findByText(/permanently delete/i);
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("delete-account-password"), { target: { value: "my-password" } });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith("/api/account", expect.objectContaining({ method: "DELETE" }));
  });

  it("shows the server error and does not call onDeleted when the password is wrong", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Incorrect password" }) })
    );
    const onDeleted = vi.fn();
    render(<DeleteAccountDialog onDeleted={onDeleted} />);

    fireEvent.click(screen.getByText(/delete account/i));
    fireEvent.change(await screen.findByTestId("delete-account-password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByText(/permanently delete/i));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Incorrect password"));
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- DeleteAccountDialog`
Expected: FAIL — `./DeleteAccountDialog` module not found.

- [ ] **Step 5: Write `apps/web/src/components/DeleteAccountDialog.tsx`**

```tsx
// apps/web/src/components/DeleteAccountDialog.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";
import deleteAccountEn from "@/locales/en/deleteAccount.json";
import deleteAccountNb from "@/locales/nb/deleteAccount.json";

i18n.addResourceBundle("en", "deleteAccount", deleteAccountEn, true, false);
i18n.addResourceBundle("nb", "deleteAccount", deleteAccountNb, true, false);

export interface DeleteAccountDialogProps {
  onDeleted: () => void;
}

export function DeleteAccountDialog({ onDeleted }: DeleteAccountDialogProps) {
  const { t } = useTranslation("deleteAccount");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: t("errors.unknown") }));
        setError(body.error ?? t("errors.unknown"));
        return;
      }
      onDeleted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">{t("triggerButton")}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("warning")}</AlertDialogDescription>
        </AlertDialogHeader>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("passwordPlaceholder")}
          className="w-full rounded border p-2 text-sm"
          data-testid="delete-account-password"
        />
        {error && <p role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={!password || submitting} onClick={handleConfirm}>
            {t("confirmButton")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- DeleteAccountDialog`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/DeleteAccountDialog.tsx apps/web/src/components/DeleteAccountDialog.test.tsx apps/web/src/locales/en/deleteAccount.json apps/web/src/locales/nb/deleteAccount.json
git commit -m "feat(web): add password-confirmed account deletion dialog"
```

### Task 4: Automated `en`/`nb` locale parity check

**Files:**
- Create: `apps/web/scripts/check-i18n-parity.mjs`
- Test: `apps/web/scripts/check-i18n-parity.test.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: nothing from other tasks — reads whatever locale namespace files exist under `apps/web/src/locales/{en,nb}/` at run time, so it automatically covers every namespace Plans 1-3 added without needing to know their names in advance.
- Produces: `checkParity(localesDir: string): string[]` (empty array = no mismatches) and a CLI entry point; `node apps/web/scripts/check-i18n-parity.mjs` exits non-zero and prints every mismatch if `en` and `nb` diverge. Exposed as the root script `pnpm lint:i18n`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/scripts/check-i18n-parity.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkParity } from "./check-i18n-parity.mjs";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(files: { en: Record<string, unknown>; nb: Record<string, unknown> }) {
  tempDir = mkdtempSync(join(tmpdir(), "i18n-parity-"));
  mkdirSync(join(tempDir, "en"));
  mkdirSync(join(tempDir, "nb"));
  for (const [locale, content] of Object.entries(files)) {
    writeFileSync(join(tempDir, locale, "common.json"), JSON.stringify(content));
  }
  return tempDir;
}

describe("checkParity", () => {
  it("returns no errors when en and nb have identical key sets", () => {
    const dir = writeFixture({
      en: { title: "Hello", nested: { a: "1" } },
      nb: { title: "Hallo", nested: { a: "1" } },
    });
    expect(checkParity(dir)).toEqual([]);
  });

  it("reports a key missing from nb", () => {
    const dir = writeFixture({
      en: { title: "Hello", extra: "x" },
      nb: { title: "Hallo" },
    });
    expect(checkParity(dir)).toContain('common.json: nb is missing key "extra"');
  });

  it("reports a key missing from en", () => {
    const dir = writeFixture({
      en: { title: "Hello" },
      nb: { title: "Hallo", extra: "x" },
    });
    expect(checkParity(dir)).toContain('common.json: en is missing key "extra"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- check-i18n-parity`
Expected: FAIL — `./check-i18n-parity.mjs` module not found.

- [ ] **Step 3: Write `apps/web/scripts/check-i18n-parity.mjs`**

```javascript
// apps/web/scripts/check-i18n-parity.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function flattenKeys(obj, prefix = "") {
  let keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys = keys.concat(flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

export function checkParity(localesDir) {
  const enDir = join(localesDir, "en");
  const nbDir = join(localesDir, "nb");
  const enFiles = new Set(readdirSync(enDir).filter((f) => f.endsWith(".json")));
  const nbFiles = new Set(readdirSync(nbDir).filter((f) => f.endsWith(".json")));

  const errors = [];
  for (const file of enFiles) {
    if (!nbFiles.has(file)) errors.push(`nb is missing locale file: ${file}`);
  }
  for (const file of nbFiles) {
    if (!enFiles.has(file)) errors.push(`en is missing locale file: ${file}`);
  }

  for (const file of enFiles) {
    if (!nbFiles.has(file)) continue;
    const enKeys = new Set(flattenKeys(JSON.parse(readFileSync(join(enDir, file), "utf-8"))));
    const nbKeys = new Set(flattenKeys(JSON.parse(readFileSync(join(nbDir, file), "utf-8"))));
    for (const key of enKeys) {
      if (!nbKeys.has(key)) errors.push(`${file}: nb is missing key "${key}"`);
    }
    for (const key of nbKeys) {
      if (!enKeys.has(key)) errors.push(`${file}: en is missing key "${key}"`);
    }
  }
  return errors;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const localesDir = fileURLToPath(new URL("../src/locales/", import.meta.url));
  const errors = checkParity(localesDir);
  if (errors.length > 0) {
    console.error("i18n parity check failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("i18n parity check passed.");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- check-i18n-parity`
Expected: PASS (all three tests).

- [ ] **Step 5: Add the root `lint:i18n` script** — edit root `package.json`, add to `scripts`: `"lint:i18n": "node apps/web/scripts/check-i18n-parity.mjs"`.

- [ ] **Step 6: Run the checker against the real locale files to confirm Plans 1-3 are currently in sync**

Run: `pnpm lint:i18n`
Expected: prints `i18n parity check passed.` and exits 0. If it instead lists mismatches, fix the named locale file(s) before committing — those are real gaps left by Plans 1-3, not a bug in the checker.

- [ ] **Step 7: Commit**

```bash
git add apps/web/scripts/check-i18n-parity.mjs apps/web/scripts/check-i18n-parity.test.ts package.json
git commit -m "test: add automated en/nb locale parity check"
```

### Task 5: `README.md` and complete `.env.example`

**Files:**
- Create: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing — pure documentation, describing the env vars and services fixed across all four plans.
- Produces: the top-level documentation a stranger needs to clone and run their own instance.

- [ ] **Step 1: Ensure every env var from all four plans is present in `.env.example`** — read the current file first (Plans 2 and 3 will already have added their own account/link-related variables); add any of the following not already present, keeping existing lines and values untouched:

```
# Sessions & secrets
SESSION_SECRET=change-me-to-a-long-random-string
APP_SECRET_KEY=change-me-to-a-different-long-random-string

# Accounts
ALLOW_REGISTRATION=true
DEFAULT_STORAGE_QUOTA_BYTES=5368709120

# Outgoing email (optional — email verification and password-reset requests
# are unavailable until this is configured)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=e2ee-drop <no-reply@example.com>

# Public base URL, used when building links in emails
APP_URL=http://localhost:8080
```

- [ ] **Step 2: Write `README.md`** (the outer fence below uses four backticks specifically because the README's own content contains a nested triple-backtick `bash` block — that inner fence must not be mistaken for the end of this instruction's code block)

````markdown
# e2ee-drop

Self-hosted, end-to-end encrypted file drops. A recipient creates a
link — no account needed, or a permanent link tied to an account — and
a sender uploads a file to that link, encrypted in their browser before
it ever leaves their machine. The server brokers presigned upload/
download URLs against its own MinIO storage and never sees plaintext
file bytes, the file's ciphertext, or anyone's private key — only the
recipient's browser can decrypt what was sent to them.

## Quickstart

\`\`\`bash
cp .env.example .env
# edit .env: at minimum change every "change-me" value
docker compose up -d --build
\`\`\`

The app is served on `http://localhost:8080` (see `docker-compose.yml`
to change the published port). `docker compose ps` should show
`migrate` exited with code 0 and the rest of the services running.

## Environment variables

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | — (required) | `api`, `migrate`, `cleanup` | Postgres connection string |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | — (required) | `postgres` | Postgres container credentials, must match `DATABASE_URL` |
| `PORT` | `3000` | `api` | Port the Fastify server listens on inside its container |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | — (required) | `minio` | MinIO admin credentials |
| `MINIO_ENDPOINT` | — (required) | `api`, `cleanup` | MinIO S3-compatible endpoint URL |
| `MINIO_REGION` | `us-east-1` | `api`, `cleanup` | S3 region (MinIO ignores the value but the SDK requires one) |
| `MINIO_BUCKET` | — (required) | `api`, `cleanup` | Bucket used for encrypted file storage |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | — (required) | `api`, `cleanup` | Credentials the API uses to sign presigned URLs |
| `MAX_FILE_SIZE_BYTES` | `524288000` (500 MB) | `api` | Largest file a sender may upload |
| `LINK_EXPIRY_HOURS` | `24` | `api` | How long an anonymous/one-time link stays valid before it's swept |
| `DROP_RETENTION_DAYS` | `7` | `api`, `cleanup` | Default max age for an undownloaded drop on a permanent link before it's purged; overridable per link |
| `SESSION_SECRET` | — (required once accounts are enabled) | `api` | Signs the httpOnly session cookie |
| `APP_SECRET_KEY` | — (required once accounts are enabled) | `api` | Encrypts stored TOTP secrets at rest |
| `ALLOW_REGISTRATION` | `true` | `api` | Set to `false` to close self-registration on this instance |
| `DEFAULT_STORAGE_QUOTA_BYTES` | — | `api` | Default per-account storage quota for new accounts |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — (optional) | `api` | Outgoing mail for email verification and password-reset requests; those flows are unavailable if unset |
| `APP_URL` | — | `api` | Public base URL, used when building links in emails |

## Fronting with TLS

`docker-compose.yml` does not include a reverse proxy or TLS
termination — it publishes the `web` service on a plain HTTP port and
expects you to put your own reverse proxy (Caddy, Traefik, nginx-proxy,
etc.) in front of it for a real domain and HTTPS, the same way you
would for Immich or Vaultwarden. Point your proxy at the `web`
service's published port.

## Development

Each workspace package has its own `dev`/`test` scripts; see
`package.json` at the repo root and in `apps/api`, `apps/web`,
`packages/db`, `packages/shared`. Run `pnpm -r test` to run every
package's test suite, and `pnpm lint:i18n` to verify the `en`/`nb`
locale files stay in sync.
````

- [ ] **Step 3: Verify the README's fenced code blocks are valid**

Run: `grep -c '```' README.md`
Expected: an even number (every opened fence is closed) — with the `bash` quickstart block and the table needing no fence, this should print `2`.

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example
git commit -m "docs: add README with env var reference and TLS note"
```
