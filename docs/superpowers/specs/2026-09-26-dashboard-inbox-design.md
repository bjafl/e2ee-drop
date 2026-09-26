# Dashboard and unified inbox — design spec

Date: 2026-09-26
Status: draft, pending review
Depends on: spec 1 (three-envelope `Drop` model, `senderUserId` actually wired up), spec 2
(`deliveryStatus`/envelope-status fields this spec reads), spec 4 (verified gating, contacts,
blocking). This is the last of the 5-spec roadmap and is purely a **read side** — it introduces no
new write paths beyond one small live-notification extension (§4).

## 1. Purpose and scope

- A dashboard (replacing the generic landing content in `HomePage.tsx` for verified users): active
  links, content awaiting the owner's own download, and — kept as its own clearly separated
  section — the existing anonymous/local-links experience, unchanged.
- A unified inbox/outbox: every delivery the logged-in user is a party to, grouped by counterparty
  (a known account, or a per-visit anonymous bucket), both incoming and outgoing.

## 2. Key finding this spec relies on

`Drop.senderUserId` (schema column existed before this project, `senderUser` relation too) was
**never set anywhere** until spec 1 wired it up (§3.2's sender-identity binding). Without spec 1,
this entire spec has no way to know which drops belong to a given authenticated sender at all —
the inbox's "outgoing" side and the "known contact" bucketing both depend directly on that field
actually being populated.

**Anonymous bucketing**: `UploadPage.tsx` generates a fresh `nacl.box.keyPair()` on every mount
(spec 1 keeps this) — so `senderPublicKey` is stable across every drop sent in one visit/session
but differs between visits. This makes it a natural, already-existing grouping key for "Anonym1",
"Anonym2", ... — no new identifier needs to be invented.

## 3. Data model changes

None. This spec is entirely new read endpoints plus one write-side extension to an existing
pub/sub mechanism (§4). `Link.lastSenderOpenedAt` and `Drop.deliveryStatus`/envelope statuses
(spec 2) are read, not modified, here.

## 4. Live updates

`apps/api/src/lib/dropEvents.ts`'s existing `EventEmitter` is keyed only by `linkId` today. This
spec adds a second emit alongside every existing `emitDropEvent(linkId, ...)` call: also emit on
the drop's owning `Link.ownerId` (when non-null), so a new `GET /api/inbox/events` SSE route (same
`EventSource` pattern already used per-link in `DownloadPage`/`ReceivePage`) lets the dashboard/
inbox remove a fully-resolved sender from the list the moment their last pending drop clears,
without polling.

## 5. Dashboard (`HomePage.tsx`)

Branches on `user && user.emailVerified` (spec 4's gating rule) instead of always showing the
current generic landing content:

- **Active links** — new `GET /api/links` (list-mine; doesn't exist today, only per-slug lookups
  do), returning every link owned by the caller with its `revokedAt`/`visibility`/`expiresAt`
  state (spec 4) so the dashboard can show each link's status inline.
- **Pending receipts** — every drop across the caller's own links not yet fully `delivered`,
  aggregated from the same query, using spec 2's `deliveryStatus` for the per-item state shown.
- **Anonymous/local links** — the existing `localLinks` block already in `HomePage.tsx` (backed by
  `useLocalLinks`, entirely unchanged mechanically: `CreateLinkPage`'s anonymous flow never checks
  auth and never will) is kept, just repositioned into its own visually distinct section rather
  than being the page's only content. A logged-in verified user still sees and can use it — nothing
  here ties an anonymous link to an account.

An unverified logged-in user continues to see today's generic landing page unchanged (per spec 4
§4's rule — no dashboard functionality is exposed to them).

## 6. Unified inbox

New page, new endpoint `GET /api/inbox` — returns every drop where the caller is a party, from
either side:

- **Incoming**: drops on links the caller owns.
- **Outgoing**: drops where `senderUserId === caller.id`, regardless of who owns the link (spec
  1's identity-binding check, §2, is what makes this trustworthy).

Grouped by counterparty:

- `senderUserId` present → resolve to `username`/`name` (no contacts-only restriction — confirmed
  during design review: any authenticated sender's real identity is shown, not just accepted
  contacts, since the sender-facing badge already exposes the recipient's identity symmetrically
  (spec 1 §6.4); spec 4's blocking (§6 there) still applies — a blocked user's drops are excluded
  entirely from the recipient's inbox, consistent with "disappears," not just hidden from contacts).
- `senderUserId` null → group by `senderPublicKey`, labeled "Anonym1", "Anonym2", ... in
  first-seen order within that link's history.

Clicking a counterparty shows their queue of deliveries with per-item status/history drawn from
spec 2's fields (`deliveryStatus`, both envelope statuses, `Link.lastSenderOpenedAt` where
relevant). **A counterparty with no drop left in a non-`delivered`/non-`shredded` state is removed
from the list** — computed the same way on every fetch and kept live via §4's SSE extension, not a
separate "dismiss" action.

## 7. API surface (new)

| Endpoint | Purpose |
|---|---|
| `GET /api/links` | List the caller's own links (dashboard) |
| `GET /api/inbox` | Unified incoming+outgoing, grouped by counterparty |
| `GET /api/inbox/events` | SSE, owner-keyed (§4) |

## 8. Testing strategy

- `GET /api/links` / `GET /api/inbox` both reject unauthenticated callers and return only the
  caller's own data — no cross-account leakage via either endpoint.
- Outgoing-drop attribution: a drop only appears in a sender's outbox when `senderUserId` matches;
  an anonymous drop the same user happened to make in a different (unauthenticated) visit does not
  retroactively attach to their account.
- Anonymous bucketing: two drops sharing one `senderPublicKey` group into one bucket; two separate
  visits (two keypairs) never merge into the same bucket even from the same real person.
- Removal: a counterparty's last pending drop reaching `delivered` or `shredded` removes them from
  a subsequent fetch, and from a live-open inbox via the SSE extension, without a page reload.
- Blocking interaction: a drop from a blocked sender is excluded from the recipient's inbox
  entirely (not shown with any "blocked" marker — consistent with spec 4's disappear semantics).
- Dashboard gating: unverified logged-in user sees the unchanged generic landing page, not the
  dashboard; the anonymous-links section renders identically whether or not the viewer is logged
  in.
