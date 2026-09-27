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

`docker-compose.yml`'s `web` service has no `ports:` mapping at all (only `expose: "80"`),
so nothing is reachable at `verify-e2e.mjs`'s default `BASE_URL=http://localhost:8080` even
with a fully healthy stack. Separately, `.env`'s `DATABASE_URL`/`MINIO_ENDPOINT` use
`localhost`, which doesn't resolve from inside the compose network (container-to-container
traffic needs service names like `postgres`/`minio`). This is independent of any sandbox
port conflicts — the compose file itself needs a fix before `pnpm verify:e2e` can ever run
against a real containerized stack. All correctness verification for plans 1-3 has instead
relied on the unit/integration test suites (`pnpm -r test`, currently 522/522 passing)
against a standalone Postgres + MinIO, which do exercise the real route handlers and real
crypto, just not through the actual `web`/`api` Docker images.

**Fix:** add a `ports:` entry to the `web` service (e.g. `"${WEB_PORT:-8080}:80"`), and give
`.env`'s compose-facing vars their own values (or a `docker-compose.override.yml` for local
dev) distinct from the host-facing ones `verify-e2e.mjs` and local `pnpm --filter api dev`
use.

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

## Remaining plans (not started)

Per the project's plan sequence, four more plans remain, with `dashboard-inbox-implementation`
depending on the other three:
- `account-verification-2fa` — independent, no dependencies.
- `delivery-lifecycle-retention` — depends only on the (already-merged) e2ee-flow schema.
- `verified-profile-contacts` — independent to build/test, but its `emailVerified` gate is only
  meaningful once `account-verification-2fa` ships the actual verification flow.
- `dashboard-inbox-implementation` — explicitly requires the other three merged first.
