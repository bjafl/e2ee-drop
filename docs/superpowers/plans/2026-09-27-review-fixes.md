# Post-Merge Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every "important" and "moderate" finding from a full-project static review conducted after all four spec-3/4/dashboard plans merged to `main`. No new features — this plan closes real gaps in already-shipped code.

**Architecture:** A flat punch-list, not a vertical slice. Tasks are ordered by severity/risk, not by dependency — later tasks do not build on earlier ones' new interfaces except where noted. Read each task's cited file/line references against the *current* code before writing anything; line numbers are a pointer from the review, not a guarantee — the code may have shifted slightly.

**Tech Stack:** Fastify + Prisma (API), React 19 + react-i18next (web), Vitest for both. No new dependencies expected.

**Spec:** This plan's own text is the spec — it was generated directly from a full-codebase review (`apps/api/src`, `apps/web/src`, `packages/shared`, `packages/db/prisma/schema.prisma`), not from a separate design doc. Where a task references an existing design spec under `docs/superpowers/specs/`, that spec is still the binding authority for the feature it describes.

## Global Constraints

- Every fix here is a bug fix or a hardening change to *already-shipped* behavior. Do not redesign surrounding code, do not rename things beyond what a task explicitly asks for, and do not add abstractions beyond what's needed to close the specific gap.
- This codebase's existing convention: real state changes that other requests can race use compare-and-swap (`updateMany` with a `where` clause narrow enough to fail on a stale read, then check `count`) — never a plain `update` after a separate read, when concurrency is plausible. Follow it wherever a task below touches a write.
- This codebase's existing convention for "caller isn't allowed to know this exists": return **404**, never 403, with the same body shape as a genuinely nonexistent resource (see `apps/api/src/routes/links.ts`'s `GET /:slug` handler for the canonical example). Follow it wherever a task below touches an authorization check.
- No `--no-verify` on any commit.
- Do not touch `docker-compose.yml`, `.env.example`, or anything already fixed by the separate, already-merged `status-gaps-fixes` work (check `git log --oneline main` for recent unrelated fixes before assuming something here is still broken).

## Review Focus

- **F1's fix must not break the existing server-derived `codewords` field's consumers.** Keep the server field for backward compatibility (some UI paths may still read it); the fix is about which value each *party* trusts and displays, not about deleting the API field.
- **F2/F6 must not break the claimant-detection use of a 403 in `ReceivePage.tsx`.** `ReceivePage.tsx` deliberately reads a 403 from `GET .../drops` to detect "I'm a request link's claimant, not its owner" — this is a *public* link case and is unaffected by a masking rule scoped to `visibility === "contacts-only"` or an active block, but verify this explicitly before changing any 403→404.
- **F3's fix must apply the exact same 404 shape `GET` already uses for a blocked caller**, not a new error shape.
- **F5's orphan sweep must never delete an object that has a live `Drop` row**, even one created moments ago — false positives here delete real user data. Err on the side of a conservative age threshold.
- **F4's size limits must not break any existing passing test** that sends realistic-sized payloads — check test fixtures before picking exact numbers.

---

## Task 1: Revoke shreds pending drops; consistent `isLinkInactive` gating on receive-side routes

**Files:**
- Modify: `apps/api/src/routes/links.ts` (`/revoke` handler)
- Modify: `apps/api/src/routes/downloads.ts` (all handlers currently gating on `isLinkExpired` alone)
- Modify: `apps/api/src/routes/events.ts` (`/events` handler)
- Modify: `apps/api/src/routes/uploads.ts` (`/abandon` handler)
- Test: `apps/api/src/routes/links.test.ts`, `apps/api/src/routes/downloads.test.ts`, `apps/api/src/routes/events.test.ts`

**Review finding (F2):** `POST /api/links/:slug/revoke` (`links.ts` around line 456-470) only sets `revokedAt` — it never shreds the link's pending drops, even though both the verified-profile-contacts spec (§3.1: revoke "immediately shreds any of the link's drops still sealed/delivery_failed") and the delivery-lifecycle-retention spec (§7) say it should. `scrubDropContent` (in `apps/api/src/lib/quota.ts`, used already by the owner-cancel and cleanup-sweep code paths) is the existing primitive to reuse — do not write a new shredding function.

Separately, `downloads.ts`'s `download-url`, `complete-download`, `download-failed`, `reveal-message` handlers, `events.ts`'s `/events` handler, and `uploads.ts`'s `/abandon` handler all gate on `isLinkExpired` only — none of them check `isLinkInactive` (which covers `revokedAt`), so a revoked link's content stays fully reachable through every one of those routes even after this task adds shredding (the shredded envelope will eventually make those routes 404/409 on their own downstream checks, but there's a window, and true management routes like `unrevoke`/`PATCH`/`DELETE`/`owner-cancel` should stay reachable on a revoked link — this task is about the *receive*-side routes specifically, not the owner's management routes).

- [ ] **Step 1:** In the `/revoke` handler, after the `revokedAt` update succeeds, iterate the link's drops where `fileUploadStatus === "complete"` and either envelope is non-terminal, call `scrubDropContent(dropId)`, delete the corresponding storage object, and emit a `drop-updated` event — mirroring the existing `owner-cancel` handler's pattern in `downloads.ts` exactly (read that handler first, reuse its shape). For drops still `"reserved"`/`"uploading"`, call `abandonDrop` instead (same distinction `owner-cancel` already makes).
- [ ] **Step 2:** Add an `isLinkInactive` check (import from `../lib/links` if not already imported) to `downloads.ts`'s `download-url`, `complete-download`, `download-failed`, and `reveal-message` handlers, `events.ts`'s `/events` handler, and `uploads.ts`'s `/abandon` handler — same 404 response shape those handlers already use for "link not found"/expired. Do not add this check to true owner-management routes (`unrevoke`, `PATCH /:slug`, `DELETE /:slug`, `owner-cancel`) — those must stay reachable on a revoked link by design.
- [ ] **Step 3:** Add a test: revoking a link with a sealed, complete drop shreds it (envelope status becomes `shredded`, storage object deleted, row survives as audit trail) and a subsequent `download-url`/`reveal-message` call on that drop 404s. Add a test that `unrevoke`/`PATCH`/`DELETE`/`owner-cancel` remain reachable after revoke.

---

## Task 2: Consistent 404 masking for contacts-only and blocked-relationship links

**Files:**
- Modify: `apps/api/src/lib/links.ts` (add a small helper)
- Modify: `apps/api/src/routes/downloads.ts`, `apps/api/src/routes/events.ts`, `apps/api/src/routes/links.ts` (apply the helper)
- Test: same files' `.test.ts` counterparts

**Review finding (F6):** `GET /:slug` and `upload-url` already correctly return 404 (never 403) for a non-contact caller on a `contacts-only` link, or a blocked caller on any link — matching this codebase's existing "never let a 403 leak existence" convention (see this plan's Global Constraints). But `download-url`, `complete-download`, `download-failed`, `reveal-message` (all in `downloads.ts`), `/events` (`events.ts`), `GET .../drops` (`links.ts`), `DELETE /:slug` (`links.ts`), and the shared `requireOwnedLink` helper backing `revoke`/`unrevoke`/`PATCH` (`links.ts`) all still return 403 in the equivalent case — leaking whether a guessable custom slug exists and is owned.

**Important:** this must NOT change behavior for a *public* link's non-owner caller (403 there is fine — existence of a public link isn't secret), and must NOT change the existing 403 that `ReceivePage.tsx` deliberately reads from `GET .../drops` to detect "I am this request link's claimant, not its owner" — request links are always `visibility: "public"`, so a masking rule scoped to `visibility === "contacts-only"` or an active block relationship does not touch that case. Verify this by reading `ReceivePage.tsx`'s use of that 403 before changing `GET .../drops`.

- [ ] **Step 1:** Add a helper (e.g. `shouldMaskAsNotFound(link, callerId)`in `lib/links.ts`) returning `true` when `link.visibility === "contacts-only"` and the caller is neither the owner nor an accepted contact of the owner, OR when the caller has an active block relationship with the owner (either direction) — reuse `hasAcceptedContact`/`hasBlockRelationship` from `lib/contacts.ts`, do not reimplement the logic.
- [ ] **Step 2:** Call this helper right after resolving the link in `downloads.ts`'s four handlers, `events.ts`'s `/events`, and `links.ts`'s `GET .../drops` and `DELETE /:slug` — return the same 404 body those routes already use for "link not found" when it's true, before any existing 403 branch is reached. Leave the public-link 403 branches untouched.
- [ ] **Step 3:** Add a test per modified route: a non-contact caller on a `contacts-only` link gets 404, byte-identical to a genuinely nonexistent slug's 404. Add/keep a test proving the request-link claimant case still gets its existing 403 unaffected.

---

## Task 3: Block a blocked user's uploads, not just their reads

**Files:**
- Modify: `apps/api/src/routes/uploads.ts` (`upload-url` handler)
- Test: `apps/api/src/routes/uploads.test.ts`

**Review finding (F3):** `upload-url` (`uploads.ts` around line 108-113) checks `contacts-only` visibility but never `hasBlockRelationship`, unlike `GET /:slug` which masks blocked callers with 404. An authenticated caller blocked by the link owner can still `POST upload-url` directly (bypassing the UI, which correctly hides the send button) and have their uploads charged to the owner's quota — and those drops then silently disappear from the owner's inbox (`lib/inbox.ts` filters blocked senders), so the owner sees quota shrink with no explanation.

- [ ] **Step 1:** Before (or alongside) the existing contacts-only check in `upload-url`, when `request.user` is set and `link.ownerId` is non-null, check `hasBlockRelationship(link.ownerId, request.user.id)` (from `lib/contacts.ts`) and return the same 404 shape the contacts-only branch already returns if true.
- [ ] **Step 2:** Add a test: a blocked authenticated caller's `upload-url` request 404s, matching a nonexistent-link 404 byte-for-byte. Add a test that an *anonymous* (logged-out) caller is unaffected (blocking cannot cover anonymous callers by design — this is expected, just confirm no regression).

---

## Task 4: Bound request body sizes that currently have none

**Files:**
- Modify: `apps/api/src/routes/uploads.ts` (upload-url body schema: `encryptedMessage`, `encryptedMetadata`)
- Modify: `apps/api/src/routes/links.ts` (`ownerNote` field, wherever it's accepted)
- Modify: `apps/api/src/routes/auth.ts` (`name`, `email` fields on register/update)
- Test: corresponding `.test.ts` files

**Review finding (F4):** None of these fields have a `maxLength` in their Fastify JSON schema, so a caller can attach an arbitrarily large `encryptedMessage`/`encryptedMetadata`/`ownerNote`/`name`/`email` to a request that otherwise costs almost nothing (a 1-byte file, 17 bytes of quota) — cheap, repeatable Postgres-storage growth at the existing rate limit ceiling. The web client already caps the message at 500 chars (`UploadPage.tsx`); the API does not enforce any equivalent limit.

- [ ] **Step 1:** Add `maxLength` to each field's JSON schema: `encryptedMessage` ≈ 2800 (base64 of ~500 UTF-8 chars + nacl.box overhead, with headroom), `encryptedMetadata` a few KB (check what the client actually sends for a multi-file upload's metadata blob and size the limit with headroom above the largest realistic case, not an arbitrary round number), `ownerNote` ≈ 2000, `name` ≈ 100, `email` ≈ 254 (RFC limit).
- [ ] **Step 2:** Check existing test fixtures in the modified files' test suites for any payload that would now exceed a chosen limit (search for long string literals) and adjust the limit upward if a legitimate existing test needs more headroom — never shrink a limit to fail a real, already-passing test.
- [ ] **Step 3:** Add one test per field: a payload just over the limit gets a 400 with a clear validation error (Fastify's schema validation gives you this for free — confirm the error shape matches this codebase's existing validation-error convention), a payload at or under the limit is accepted.

---

## Task 5: Fix the non-CAS write in anonymous upload completion

**Files:**
- Modify: `apps/api/src/routes/uploads.ts` (`/complete` handler, anonymous branch)
- Test: `apps/api/src/routes/uploads.test.ts`

**Review finding (F7):** The anonymous branch of `/complete` (`uploads.ts` around line 344-347) writes `deliveryStatus` in a second, separate `prisma.drop.update({ where: { id: dropId } })` call after the CAS-based `fileUploadStatus` transition — unlike the owned-link branch a few lines below (around 366-377), which correctly folds `deliveryStatus: "sent"` into the same CAS `updateMany`. This is exactly the class of race the codebase's CAS discipline exists to prevent (a concurrent `complete-download`/`reveal-message` could legitimately advance `deliveryStatus` further between the two writes, and the second write would clobber it backward), and the second write isn't even link-scoped like its neighbors.

- [ ] **Step 1:** Fold the `deliveryStatus: "sent"` field into the same `updateMany` that performs the `fileUploadStatus` CAS transition, matching the owned-link branch's shape exactly. Delete the separate second write.
- [ ] **Step 2:** Add a regression test proving `deliveryStatus` and `fileUploadStatus` land in the same statement (e.g. assert both are set correctly with a single mocked/spied Prisma call, or simply confirm no second `prisma.drop.update` call happens for this path — check how similar "one write not two" assertions are done elsewhere in this file's tests, if at all, and use a comparable technique).

---

## Task 6: Sweep orphaned storage objects

**Files:**
- Modify: `apps/api/src/lib/storage.ts` (add a list-objects capability)
- Modify: `apps/api/src/jobs/cleanup.ts` (add a new sweep)
- Test: `apps/api/src/lib/storage.test.ts`, `apps/api/src/jobs/cleanup.test.ts` (check for an existing cleanup test file; if none exists, add one following this codebase's existing test style for jobs/routes)

**Review finding (F5):** `abandonDrop` and the passive abandoned-upload sweep both delete the `Drop` row and then the storage object. A presigned PUT that completes *after* that deletion (the reservation window already documents that a PUT which starts before expiry can finish well after) leaves an object in MinIO with no `Drop` row referencing it — permanently, since nothing anywhere reconciles bucket contents against the database. This is both a benign occasional occurrence and a repeatable abuse vector on anonymous links (drop IDs are public via `GET /:slug` and SSE; a bystander can `/abandon` someone else's in-flight upload).

- [ ] **Step 1:** Add a function to `storage.ts` that lists objects under the bucket (paginated `ListObjectsV2`), returning key + `LastModified`.
- [ ] **Step 2:** Add a new sweep to `cleanup.ts`'s `main()` loop: list objects, parse each key as `${linkId}/${dropId}` (matching this codebase's existing key format — confirm the exact format in `storage.ts` before assuming), skip any key whose `dropId` still has a live `Drop` row, and delete only objects older than the existing upload reservation window constant (reuse it, don't invent a new one) to avoid racing a PUT that's still legitimately in flight. Log a count of objects swept, matching this file's existing logging convention for its other sweeps.
- [ ] **Step 3:** Add a test: an object with no matching `Drop` row, old enough to clear the reservation window, gets deleted; an object with no matching row but *within* the window is left alone; an object with a live matching row is left alone regardless of age.

---

## Task 7: Remove the password-reset timing oracle

**Files:**
- Modify: `apps/api/src/routes/passwordReset.ts` (`/request` handler)
- Test: `apps/api/src/routes/passwordReset.test.ts`

**Review finding (F8):** For a registered email, `/password-reset/request` awaits both the token insert and the actual SMTP send before responding; for an unregistered email it responds immediately — a measurable timing difference that defeats the route's own stated anti-enumeration goal (see its existing comments and `lib/rateLimit.ts`'s). `routes/auth.ts`'s registration-email send is already fire-and-forget for a related reason, and login already pays a dummy Argon2id cost specifically to equalize timing — this task applies the same idea here.

- [ ] **Step 1:** Make the email send fire-and-forget (matching `auth.ts`'s registration-email pattern exactly — same error-logging-not-throwing behavior on send failure), so the response no longer waits on SMTP round-trip time. Keep the token insert itself awaited (it's fast and not the timing signal in question), or fire-and-forget it too if that's simpler and doesn't break the "token exists by the time a legitimate follow-up request needs it" property — check how the token is consumed downstream before deciding.
- [ ] **Step 2:** Add a test confirming the response for a registered email doesn't wait on the mailer (e.g. a slow/rejected mock mailer doesn't slow down or fail the response), matching however `auth.ts`'s equivalent test (if one exists) verifies the same property for registration.

---

## Task 8: Derive codewords client-side instead of trusting the server's value

**Files:**
- Modify: `packages/shared/src/` (new module, e.g. `codewords.ts` — move logic from `apps/api/src/lib/codewords.ts`)
- Modify: `apps/api/src/lib/codewords.ts` (re-export from shared, or leave as-is if it already matches — check for duplication risk)
- Modify: `apps/web/src/components/UploadPage.tsx`, `apps/web/src/components/ReceivePage.tsx`, `apps/web/src/components/CreateLinkPage.tsx`, `apps/web/src/components/NewLinkPage.tsx`, `apps/web/src/components/HomePage.tsx`
- Test: corresponding `.test.tsx`/`.test.ts` files

**Review finding (F1) — the highest-value fix in this plan:** Codewords exist as a TOFU safety net — sender and recipient are supposed to independently derive a phrase from the recipient's public key and compare it out-of-band. Today, both sides instead display whatever `GET /api/links/:slug` returns, which the API derives server-side from the DB-stored `recipientPublicKey`. If that stored value is ever wrong (compromised DB, a bug, a malicious operator with DB access), the server derives matching words from the *wrong* key for both parties — the exact attack this feature exists to catch produces no visible difference. Separately, an account-owned link's owner has no UI surface showing their own link's codewords at all (`NewLinkPage.tsx` discards them, the dashboard shows only the slug, the owned-link receive queue doesn't render them), so the comparison can't even be attempted for owned links today. The sender also currently sees only 3 of `CODEWORD_WORD_COUNT` words while the receiver sees all of them — align this too.

- [ ] **Step 1:** Move `deriveCodewords` and the wordlist(s) from `apps/api/src/lib/codewords.ts` into `packages/shared/src/` so browser code can call the exact same derivation the API uses (check whether the current implementation has any Node-only dependency — e.g. a specific crypto/hash primitive — and swap it for something that runs in both environments if so; do not change the derivation's output for a given input, since the two sides must keep matching, and existing tests already pin specific outputs).
- [ ] **Step 2:** In `UploadPage.tsx`, derive the displayed codewords client-side from the actual `recipientPublicKey` bytes about to be passed to `nacl.box`, not from the API response's `codewords` field. In whatever component drives `CreateLinkPage`/the claim flow, derive from the locally generated key pair. In the owned-link receive queue (`ReceivePage.tsx`) and wherever an owner can view their own link's details (dashboard/`NewLinkPage.tsx`'s post-creation state, `HomePage.tsx`), derive from `user.publicKey` and render them — this is new UI surface for the owner, not just a swap; add a reasonably placed label consistent with this codebase's existing i18n conventions (new locale keys in both `en`/`nb` bundles, following whatever bundle the component already uses).
- [ ] **Step 3:** Show the same word count on both the sender's and receiver's display (currently sender shows a hardcoded slice of 3; receiver shows all `CODEWORD_WORD_COUNT`). Keep the server's `codewords` field in the API response for now (do not remove it — something else may still read it), but stop having the frontend trust it for the comparison UI.
- [ ] **Step 4:** Update/add tests: a component-level test proving the displayed words come from the locally-held key, not the API response (e.g. mock the API response with a *different* set of words than the local key would produce, and assert the UI shows the locally-derived ones, not the mocked API ones). Add a test for the new owner-facing display surface(s).

---

## Task 9: Guard against silent localStorage failures during key claim/creation

**Files:**
- Modify: `apps/web/src/components/ReceivePage.tsx` (anonymous claim flow, plus any other unguarded `localStorage` access in this file)
- Modify: `apps/web/src/components/CreateLinkPage.tsx` (anonymous link creation, same ordering issue)
- Test: corresponding `.test.tsx` files

**Review finding (F9):** In `ReceivePage.tsx`'s anonymous-claim flow, the server-side claim (irreversible — there's no unclaim route) happens *before* the private key is persisted to `localStorage`; if that write throws (private browsing, blocked storage, quota exceeded) the failure is swallowed silently by `useLocalLinks.ts`'s existing catch-all, and the user is left with a permanently claimed link whose key exists only in memory for that one tab. `CreateLinkPage.tsx` has the same ordering for anonymous link creation, with a milder consequence (an unused link just expires). Separately, a couple of `localStorage` accesses directly in `ReceivePage.tsx` (not routed through `useLocalLinks.ts`'s existing try/catch wrapper) are unguarded and can white-screen the page if storage access throws.

- [ ] **Step 1:** In both flows, either (a) probe storage capability before the irreversible server call — write and read back a small sentinel value, and if that fails, show a blocking warning that the key can only survive in this tab/session before proceeding — or (b) reorder so the local persistence attempt happens first and the claim/create call only proceeds on success, surfacing a clear error otherwise. Pick whichever fits each component's existing control flow more naturally; they don't need the same mechanism.
- [ ] **Step 2:** Find the specific unguarded `localStorage` calls in `ReceivePage.tsx` that don't go through `useLocalLinks.ts`'s wrapper and wrap them in the same try/catch discipline that hook already uses elsewhere, so a storage failure degrades gracefully instead of throwing past an error boundary (or with no error boundary, blank-screening).
- [ ] **Step 3:** Add a test: simulate `localStorage.setItem` throwing during an anonymous claim/create, and assert the user sees an explicit warning rather than silent success followed by data loss.

---

## Task 10: Backend hygiene batch — races, arbitrary selection, and cleanup gaps

**Files:**
- Modify: `apps/api/src/lib/contacts.ts` (`/accept`, `/block` handlers or their underlying lib functions)
- Modify: `apps/api/src/routes/links.ts` (`mark-receiver-opened`, `mark-sender-opened`)
- Modify: `apps/api/src/routes/twoFactor.ts` (`/disable`)
- Modify: `apps/api/src/jobs/cleanup.ts` (token pruning)
- Test: corresponding `.test.ts` files

Five independent, small fixes — batch them into one dispatch since each is a handful of lines with no shared file conflicts beyond what's listed:

- [ ] **Contact accept/block race:** `contacts.ts`'s accept and block operations currently do a plain `update` after a separate read. Change both to `updateMany({ where: { id, status: "pending" } })` (or whatever the correct current-state predicate is per each operation) and check `count === 1` before treating it as success, matching this codebase's CAS convention. Add a test: an `/accept` racing a `/block` on the same contact row can't un-block it (whichever CAS wins, wins cleanly — no lost update).
- [ ] **`mark-receiver-opened` picks an arbitrary drop:** `links.ts`'s handler currently uses `link.drops[0]`, which this codebase's own code elsewhere already notes is unordered — for a claimed request link with multiple drops this advances an arbitrary one instead of a meaningful one. Pick a deterministic, meaningful drop (e.g. the most recently created undelivered one — check what "opened" should logically mean here and pick accordingly) or, if the route's purpose only ever makes sense for single-drop links, add a comment explaining why `[0]` is acceptable there and leave it, whichever is actually correct after reading the route's real purpose.
- [ ] **`mark-sender-opened` under-gated:** currently only checks `isLinkExpired`. Switch to `isLinkInactive` (consistent with Task 1's fix elsewhere) so a revoked/otherwise-inactive link doesn't keep recording this telemetry field.
- [ ] **Stale backup codes after 2FA disable:** `/2fa/disable` leaves unused `TotpBackupCode` rows behind. Delete them (or mark them unusable) when 2FA is disabled, so a future re-enable starts from a clean slate rather than accumulating stale rows across enable/disable cycles.
- [ ] **`EmailVerificationToken` rows never pruned:** `cleanup.ts` already prunes expired `PasswordResetToken` rows on a timer; add the equivalent for expired `EmailVerificationToken` rows, reusing the exact same pattern.

---

## Task 11: Backend hygiene batch — input validation and config bounds

**Files:**
- Modify: `apps/api/src/routes/auth.ts` (email normalization, public key validation)
- Modify: `apps/api/src/routes/links.ts` (public key validation on claim/custom-link creation)
- Modify: `apps/api/src/routes/uploads.ts` (public key validation on upload)
- Modify: `apps/api/src/env.ts` (retention env var bounds)
- Modify: `apps/api/src/lib/links.ts` or `apps/api/src/lib/inbox.ts` (unify `hasMessage` derivation — pick whichever file already owns the concept most naturally after reading both)
- Test: corresponding `.test.ts` files

Five more independent, small fixes, batched the same way:

- [ ] **Email case-sensitivity:** register/login/password-reset treat `Bob@x.com` and `bob@x.com` as different accounts (no normalization anywhere). Lowercase (and trim) the email on every write path that stores or looks one up — register, password-reset request, and anywhere else `email` is used as a lookup key. Check for an existing unique constraint or index on `User.email` that this change interacts with, and add a migration only if actually needed (it likely isn't, since Postgres string equality is already case-sensitive today and normalizing at write-time doesn't require a schema change) — check before assuming.
- [ ] **Public keys never validated:** `links.ts` (claim, custom-link creation), `uploads.ts` (upload's stated public key), and `auth.ts` (register) all accept a `publicKey`/`recipientPublicKey` string with no check that it decodes to exactly 32 bytes of base64. A malformed key (e.g. a griefer claiming a request link with `"AAAA"`) currently fails later with an opaque crypto error and, for a claimed request link, has no unclaim path — permanently bricking it. Add a validation helper (base64-decode, check byte length === 32) and call it wherever one of these fields is accepted, returning a clear 400 on failure instead of letting a downstream crypto call fail obscurely.
- [ ] **Retention env vars have no lower bound:** `env.ts`'s `DROP_RETENTION_DAYS_DEFAULT`, `DROP_RETENTION_DAYS_MAX`, `AUDIT_RETENTION_DAYS` parse with no minimum — an operator setting `0` (or a typo) makes every drop retention-expire on the very next cleanup sweep. Add a `{ min: 1 }`-equivalent bound (match however this file's existing numeric env vars express bounds, if any do) and fail startup with a clear error otherwise, rather than silently accepting a destructive value.
- [ ] **`hasMessage` derived two different ways:** `lib/links.ts` derives it from `messageEnvelopeStatus !== "sealed"`; `lib/inbox.ts` derives it from `messageRevealedAt !== null` — these disagree for a shredded-but-never-revealed message (reports `hasMessage: false` in the inbox despite a message having existed). Extract one shared helper and use it in both places; `lib/links.ts`'s derivation is the one that already correctly distinguishes "never had a message" from "had one, now gone" (per this codebase's own established reasoning elsewhere for the identical distinction) — reuse that one rather than inventing a third version.

---

## Final Task: Refresh `docs/STATUS.md`

**Files:**
- Modify: `docs/STATUS.md`

Not a code task — no implementer/reviewer dispatch needed, the controller can do this directly. `docs/STATUS.md`'s "Remaining plans (not started)" section still lists `delivery-lifecycle-retention` and `dashboard-inbox-implementation`, both now merged; update that section to reflect that all four plans it was tracking are done. Leave the "Infrastructure gap" section's `verify-e2e.mjs`/email-verification note as-is if it's still accurate after this plan's Task 4-11 land (it's about `docker-compose.yml`, which this plan does not touch), and leave the backend-gaps section alone (those were already fixed by the separate `status-gaps-fixes` work, per `git log`).
