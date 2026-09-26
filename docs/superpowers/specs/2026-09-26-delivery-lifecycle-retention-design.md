# Delivery lifecycle, burn semantics and retention — design spec

Date: 2026-09-26
Status: draft, pending review
Extends: `docs/superpowers/specs/2026-09-26-e2ee-send-receive-flow-design.md` ("spec 1") — that
spec introduced the `deliveryStatus`/`messageEnvelopeStatus`/`fileEnvelopeStatus`/`contentDeletedAt`
fields on `Drop` as placeholders and explicitly deferred their full lifecycle to this spec (spec
1 §5's scope note, §10's assumptions log).

This is spec 2 of the 5-spec roadmap. Spec 5 (dashboard/inbox) is the read side of the data this
spec produces; it isn't designed here.

## 1. Purpose and scope

Turn the placeholder status fields spec 1 wrote into a fully wired lifecycle:

- The derivation logic that actually moves `Drop.deliveryStatus` through its states, called from
  spec 1's existing endpoints.
- A lightweight, non-blocking "link was opened by a would-be sender" signal that doesn't interact
  with the one-time-link single-drop invariant (resolving the conflict identified during review —
  see §2).
- Rewriting the existing cleanup job (`apps/api/src/jobs/cleanup.ts`) from hard-deleting expired
  content to **scrubbing** it (content gone, row kept) — unifying anonymous and owned one-time
  links under the same treatment, and distinguishing "shredded" (expired/cancelled without ever
  being retrieved) from "delivered" (successfully retrieved) as the reason content is gone.
- A new final-purge sweep that hard-deletes a scrubbed row once its own audit-retention window has
  passed.
- An owner-triggered manual override: delete/abort a drop's content immediately, at any status,
  without waiting for any timer.

## 2. `Link.lastSenderOpenedAt` — resolving the eager-tracking conflict

Design review surfaced a real conflict: creating a `Drop` row as soon as a sender merely opens
`/send/:slug` (before picking a file) would let the *first* visitor to an anonymous one-time link
permanently occupy its one available slot — even if they never send anything — locking out every
other visitor until an abandon-timeout fires. It would also require `Drop`'s content columns
(NOT NULL as of spec 1) to become nullable again.

Resolved by splitting the concern instead of forcing it into `Drop`:

```prisma
model Link {
  // ...unchanged from spec 1...

  // NEW — lightweight, non-blocking. Updated (not CAS'd — every visit overwrites it) on every
  // GET /api/links/:slug from the send side. Gives the owner "someone looked at your link N
  // ago" without creating any delivery record or touching the one-time invariant.
  lastSenderOpenedAt DateTime?
}
```

`Drop` itself is unchanged from spec 1: still created lazily, only once `upload-url` is actually
called, `deliveryStatus` still starting at `"sender_opened"` (the label still fits — by that point
the sender has real intent to send). The trade-off is losing detailed per-visit "opened but never
sent" history in favor of a single coarse timestamp — accepted per review.

## 3. `deliveryStatus` derivation

`deliveryStatus` moves forward through `sender_opened → sent → receiver_opened →
partial_delivery/delivered`, written by the endpoints spec 1 already defined, plus one shared
derivation step added by this spec:

- `sent` — set by `POST .../drops/:dropId/complete` (spec 1 §5, unchanged).
- `receiver_opened` — set by `GET /api/links/:slug` from the receive side (spec 1 §6.1,
  unchanged), CAS'd so only the first such request advances it.
- After `POST .../drops/:dropId/reveal-message` (spec 1 §6.2) **or**
  `POST .../drops/:dropId/complete-download` (spec 1 §6.3) successfully sets its own envelope
  status to `delivered`, both endpoints now additionally call a shared `recomputeDeliveryStatus`
  step:
  - No message on this drop → `fileEnvelopeStatus` alone decides: `delivered` once it's
    `"delivered"`.
  - Message present → `delivered` only once **both** envelope statuses are `"delivered"`;
    exactly one delivered and the other still `sealed`/`delivery_failed` → `partial_delivery`;
    neither yet → status stays at whatever it already was (never regresses).
  - Written via a CAS `updateMany` keyed on the row's current `deliveryStatus` (same
    compare-and-swap discipline already used elsewhere in this codebase, e.g.
    `transitionDropStatus` in `lib/links.ts`), so the two endpoints racing each other (message
    revealed and file downloaded at nearly the same moment) can't stomp one valid transition with
    a stale one.

## 4. Envelope status: `shredded` vs `delivered`

Both `messageEnvelopeStatus` and `fileEnvelopeStatus` reach a terminal "content is gone" state two
different ways, and the distinction matters for the owner's history (spec 5 reads this):

- **`delivered`** — the recipient successfully retrieved it (spec 1 §6.2/§6.3's existing atomic
  reveal/complete-download operations).
- **`shredded`** — content removed *without* ever being retrieved: either the retention/expiry
  timer ran out (§5), or the owner manually cancelled it (§6). Never set for an envelope that's
  already `delivered`.

## 5. Cleanup job: scrub, not delete

Rewrites `apps/api/src/jobs/cleanup.ts`. All three sweeps below operate on **anonymous and owned
links identically** — the earlier owner/quota-only distinction goes away: quota is released
immediately in both cases, only the row's fate (kept vs. eventually purged) matters, and that's now
the same for both.

- **`runCleanup()`** (expired one-time links): for each expired one-time link with a drop whose
  envelope(s) aren't already `delivered`, delete the S3 object, null the ciphertext/nonce columns,
  set `contentDeletedAt`, and set each not-yet-delivered envelope to `shredded`. Release any
  charged quota immediately (same timing for owned and anonymous now). The `Link` and `Drop` rows
  are kept — this row *is* the audit trail from now on, not a separate table.
- **`sweepExpiredDrops()`** (permanent-link drops past `retentionDays`): identical scrub treatment,
  per-drop, on its own schedule (unchanged: `drop.link.retentionDays`, now always a real value
  per spec 1 §4.4, no more `?? env.DROP_RETENTION_DAYS` fallback needed).
- **`purgeAuditExpiredRows()` (new)**: hard-deletes any `Drop` whose `contentDeletedAt` is older
  than `AUDIT_RETENTION_DAYS` (new env var, default **30**). If that was a one-time link's only
  drop, the `Link` row is hard-deleted in the same pass too (nothing left to keep it for); a
  permanent link's own row is never purged this way — only its individual expired drops are.

New env var:

```
AUDIT_RETENTION_DAYS  (default: 30)
```

## 6. Owner manual override

The owner can force content gone at any time, regardless of current status, ahead of any timer —
this is new capability, not present in today's codebase or in spec 1:

- `POST /api/links/:slug/drops/:dropId/owner-cancel` (new, owner-authenticated) — runs the exact
  same scrub-to-`shredded` operation as §5's cleanup sweeps, immediately. A no-op (200, not an
  error) if the envelope(s) are already `delivered` or already `shredded` — nothing left to cancel.
- `DELETE /api/links/:slug` — today this endpoint explicitly rejects owned links ("Owned links
  cannot be deleted through this endpoint", `apps/api/src/routes/links.ts`). This spec extends it
  to also accept the authenticated owner, running the same scrub across all of that link's drops.
  Anonymous-link deletion (today's only supported case) is unchanged.

## 7. Open question: revoked links

`Link.revokedAt` (existing column, being wired up for enforcement in spec 4's visibility work) marks
a link closed to new activity. This spec assumes revoking a link also immediately shreds any of its
drops still `sealed`/`delivery_failed` (there's no more legitimate way to reach them once the link
itself is closed) — using the same §6 mechanism. Flagging this explicitly since it wasn't asked
about directly: say if revoke should instead leave in-flight content alone and only block *new*
uploads.

## 8. Testing strategy

- `recomputeDeliveryStatus`: a both-present drop with each of the four orderings (message-first,
  file-first, simultaneous, neither yet) resolves to the correct `partial_delivery`/`delivered`/
  unchanged outcome; a drop with no message never enters `partial_delivery` on the file alone.
- Race test: concurrent `reveal-message` and `complete-download` against the same drop both
  succeed at the envelope level and the derived `deliveryStatus` ends at `delivered`, not stuck at
  `partial_delivery` from a lost CAS.
- Cleanup sweeps: expired one-time link scrubs (not deletes) the row; a drop already `delivered`
  before expiry is left alone by the sweep (nothing to shred); `purgeAuditExpiredRows` hard-deletes
  only rows past `AUDIT_RETENTION_DAYS`, and cascades to the `Link` only for a one-time link's sole
  drop.
- `owner-cancel` / owner-authenticated `DELETE`: rejected for a non-owner; no-op (not an error) on
  an already-`delivered`/`shredded` envelope; actually scrubs a `sealed`/`delivery_failed` one.
- `lastSenderOpenedAt`: updates on every send-side `GET`, never creates a `Drop`, never affects the
  one-time single-drop invariant.
