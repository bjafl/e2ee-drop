# Status notes — e2ee-flow plans 1-3 (backend + frontend rewrite)

Written at the close of plan 3 (frontend). These are known, confirmed items that were
deliberately **not** fixed as part of plans 1-3, either because they're out of scope
(cross-plan / backend, while plan 3 is frontend-only) or because they're low-severity
polish. Nothing here blocked merging plan 3 to `main`.

## Backend gaps carried over from plan 2, exposed by plan 3's frontend work

These required touching `apps/api`, which was out of scope for plan 3. **All three are now
fixed** (see the `worktree-status-gaps-fixes` branch / receive-flow-fix-report.md for the
implementation and test details); the write-ups below are kept as a record of what was wrong.

1. ~~**`GET /api/links/:slug/events` (SSE) is still owner-only-gated, never updated to plan
   2's `canReceive` model.**~~ **FIXED.** A claimant of a sender-initiated request link got
   403'd on this route. The frontend (`ReceivePage.tsx`) degraded gracefully — it fell back to
   polling `GET /api/links/:slug` every 12s when the SSE connection closed (fixed as part
   of plan 3's final-review fix wave, finding I2) — so the feature worked, just without
   live push updates for this one case. `routes/events.ts` now allows the connection when the
   caller is the true owner (unchanged) OR `canReceive` says they may receive, which also
   covers a claimed request link's non-owner claimant.

2. ~~**A sender-initiated request link's "recipient" badge on `/send/:slug` shows the
   *sender's own* identity, not the real recipient's.**~~ **FIXED.** `toLinkStatusResponse`
   (`apps/api/src/lib/links.ts`) derived `recipientName`/`recipientUsername`/
   `recipientEmailVerified`/`recipientTotpEnabled` from `link.ownerId`, which for a
   request link is the initiator (sender), not whoever claims it — a real trust-signal bug
   (spec §6.4 exists specifically to get this right). `toLinkStatusResponse` now returns the
   base response (no `recipient*` fields at all) whenever `isClaimedSenderInitiatedLink`
   is true, exactly like the existing unverified-owner case.

3. ~~**A sender-initiated request link accepts multiple files/drops (it's `mode:
   "permanent"`), but the claimant only ever sees the first one (`link.drops[0]`).**~~
   **FIXED.** `toLinkStatusResponse`'s single-drop field and the claimant's single-drop
   frontend view both only ever surfaced one drop; a second send from the same initiator to
   the same claimed link was silently invisible. `LinkStatusResponse` now also carries an
   optional plural `drops` field (every outstanding drop, oldest first) populated only for a
   claimed sender-initiated link's claimant; `ReceivePage.tsx`'s claimant view renders it via
   the same `DropDetail`/list-style component the owned queue view already used, reusing the
   same SSE merge logic. The singular `drop` field is unchanged for every other link shape.

## Infrastructure gap — real E2E verification against `docker compose up` was never possible

**Correction:** an earlier version of this note wrongly called `web`'s missing host-port
publish a bug and "fixed" it by adding `ports: ["${WEB_PORT:-8080}:80"]`. That was wrong — it
directly undid a deliberate, already-documented decision (commit `52a2450`, before this note
was even written): this app deploys via Coolify, whose Traefik proxy permanently binds
`0.0.0.0:8080` on the host for its own dashboard/API, so publishing `web` on that same port
collides with it. Coolify routes to `web` over the internal Docker network via the
`SERVICE_FQDN_WEB` label instead — a host-published port was never needed for real deployment.
**Reverted** back to `expose: "80"`, with a comment on the service pointing at this history so
it doesn't get "fixed" a third time. For local dev / `pnpm verify:e2e`, use
`docker-compose.override.yml.example` (copy to `docker-compose.override.yml`, gitignored,
merged automatically by `docker compose up`) — it adds the port publish without touching the
tracked, production-safe compose file.

The OTHER half of that earlier fix remains correct and is kept: `migrate`/`api`/`cleanup`
previously inherited `DATABASE_URL`/`MINIO_ENDPOINT` straight from `.env`'s host-facing values,
which don't resolve from inside the compose network (container-to-container traffic needs
service names like `postgres`/`minio`, not `localhost`). These three services now build/
hardcode compose-internal values instead
(`postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}` and
`http://minio:9000`) — `.env`'s `DATABASE_URL`/`MINIO_ENDPOINT` are host-side-tooling-only now,
documented as such in `.env.example`/`README.md`. This part was validated via `docker compose
config` and a partial `docker compose up -d postgres minio` (which hit only the pre-existing,
documented `127.0.0.1:5432` host-port conflict from an unrelated container on this shared dev
machine — a sandbox limitation, not a bug in this fix).

**Also noticed, pre-existing, not fixed:** README's "Fronting with TLS" section (the
`TRUST_PROXY_HOPS` security guidance) still describes `web`'s port as published by default
across all interfaces — that text predates commit `52a2450` and was never updated when that
commit changed `web` to `expose`-only, so it's been stale since before this session started.
Worth a follow-up pass whenever someone next touches that section, to describe the actual
current threat model (Coolify-routed by default; the port is only reachable at all via the
opt-in local override).

## New integration bug found (and fixed) while merging plans together

Discovered while merging this branch with `main`'s two newly-landed plans
(`account-verification-2fa`, `verified-profile-contacts`): `verified-profile-contacts` added an
`emailVerified` gate to `POST /api/links/custom` (403 for an unverified owner) and a broader
`isLinkInactive()` check (expired OR revoked OR owner-unverified) to `GET /api/links/:slug` and
`POST /api/links/:slug/claim` — but did **not** add the same `emailVerified` gate to
`POST /api/links/request` (the other owner-creating route, from plan 2). Net effect: an
unverified user could create a request link that was then immediately unclaimable and invisible
via `isLinkInactive`'s owner-verification check — dead on arrival. **FIXED** by adding the same
gate (`403` if `!owner.emailVerified`) to `POST /api/links/request`, matching `/custom` exactly.
Several pre-existing tests that created request links with unverified test accounts needed the
same one-line `emailVerified: true` fixture update already used elsewhere in the suite.

**New consequence, not yet fixed:** `scripts/verify-e2e.mjs`'s sender-initiated scenario
registers a fresh account and immediately calls `/api/links/request` — this will now 403 until
the script also completes real email verification for that account first. The script isn't
runnable in this sandbox regardless (see above), so this wasn't fixed now; whoever next gets a
working `docker compose up` stack to test against will need to add an email-verification step
(check how the account-verification-2fa plan's own tests capture/read the verification
token/link — likely via a test-only SMTP capture or a dev-mode endpoint) to that scenario first.

## Deferred minor findings (polish, not correctness issues)

From plan 2's final review:
- `apps/api`: `!metadata?.fileSize` treats `fileSize: 0` as "missing" not "invalid" (pre-existing pattern).
- `apps/api`: narrow race — an authenticated user's row deleted between session issuance and an upload-url request skips the identity check (harmless, `senderUserId` has `onDelete: SetNull`).
- `apps/api`: `complete-download`'s `deliveryStatus` derivation uses a pre-CAS snapshot — a concurrent `reveal-message` could leave it stale at `partial_delivery`. Informational field only, not the security property.
- `apps/api`: `POST /api/links/request` has no P2002 slug-collision handling (astronomically unlikely, inherited pattern).
- `apps/api`: no test for claiming an already-expired link (low risk, straight reuse of tested expiry logic).

From plan 3's final review:
- `crypto.worker.ts`: `zipAndEncryptError` message has no `data` field (cosmetic, no `requestId` needed for that message type).
- `crypto.worker.ts`: carries a `toLocalUint8Array` normalization added only to work around a `@vitest/web-worker` test-polyfill realm mismatch — dead code in production, harmless.
- `useXhrUpload.ts`: `xhr.onabort`'s rejection path is untested — currently unreachable, no caller calls `.abort()`.
- `useLocalLinks.ts`: `StoredLink`'s "exactly one of privateKey or wrapped+salt" invariant is enforced via non-null assertions, not a discriminated union.
- `CreateLinkPage.tsx`: lost an unmount guard when moving from `useEffect` to a click handler (narrow window, dev-console-warning only).
- `ReceivePage.tsx`: `FakeEventSource.fail({permanently: true})` test harness exists but wasn't exercised by a test at the time of the final review (this has since been fixed as part of finding I2's fix — a test now uses it).
- Two stale-naming cosmetic nits: `apps/api/src/lib/codewords.ts`'s comment still says "DownloadPage" (should say "ReceivePage"); `createLink.json`'s `goToDownloadPage` locale key name is stale (still says "download" though the link points to `/receive/`).
- `apps/web`: retention-days default pre-fill (`CreateLinkPage.tsx`, `NewLinkPage.tsx`, `RequestLinkPage.tsx`) is a hardcoded `1` matching `DROP_RETENTION_DAYS_DEFAULT`'s current value, disclosed in a comment as a stand-in since no API response exposes the real default before link creation. If that env var's default ever changes, these three hardcoded values need updating too, or a small backend endpoint should expose it.
- `ReceivePage.tsx` (I8's fix): a sender's in-progress file selection is not preserved across the `/login` round-trip (would need e.g. IndexedDB caching of `File` objects — a materially larger change than the `returnTo` navigation fix that was in scope).

## Remaining plans

All four plans this section was tracking (`account-verification-2fa`,
`verified-profile-contacts`, `delivery-lifecycle-retention`, and
`dashboard-inbox-implementation`) have since been implemented and merged to
`main`. None remain outstanding.

A follow-up punch-list plan (`2026-09-27-review-fixes`, generated from a
full-codebase review after all four merged) has since closed out the
majority of "important"/"moderate" findings from that review, but not all:
two are recorded as parked/deferred with explicit rulings rather than fixed
— see its own plan file (`docs/superpowers/plans/2026-09-27-review-fixes.md`)
and its SDD workspace under `.superpowers/sdd/2026-09-27-review-fixes/` for
the task-by-task record, including those rulings, kept as this branch's own
internal working notes for the coordinating session to inspect before merge.
