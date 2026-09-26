# Verified profile, link visibility, and contacts — design spec

Date: 2026-09-26
Status: draft, pending review
Depends on: spec 3 (account verification) — this spec's central gating rule requires
`User.emailVerified` to be a real, settable value, which spec 3 provides. Tightens one assumption
made in spec 1 (§4.1's `POST /api/links/request` auth requirement — see §4 below).

This is spec 4 of the 5-spec roadmap.

## 1. Purpose and scope

Two adjacent pieces, both largely a matter of wiring up columns that already exist in the schema
but are never enforced anywhere today:

- **Verified-only functionality**: every registered user already gets a permanent, public,
  username-slugged default link at registration (`createDefaultLinkForUser`,
  `apps/api/src/lib/links.ts`) — regardless of email verification. `Link.visibility`
  (`"public"`/`"contacts-only"`) is accepted at creation but **never checked when a link is read**.
  `Link.revokedAt` exists but **is never read anywhere** — `isLinkExpired` only checks `expiresAt`.
  This spec enforces all three, and adds the rule that an unverified account behaves exactly like
  an anonymous visitor everywhere in the app.
- **Contacts**: the existing accept/reject friend-request system (`lib/contacts.ts`) gains
  blocking, with real "you don't exist to me" semantics rather than a visible blocked-state.

## 2. Data model changes

### `User`

```prisma
model User {
  // ...unchanged...

  // NEW (friend-request button on the public profile page, §5)
  allowContactRequests Boolean @default(true)
}
```

### `Contact`

```prisma
model Contact {
  id              String   @id @default(cuid())
  userId          String
  contactUserId   String
  status          String   @default("pending") // "pending" | "accepted" | "blocked" (NEW)
  blockedByUserId String?  // NEW — which of the two parties blocked; independent of who
                            // originally sent the request
  createdAt       DateTime @default(now())

  @@unique([userId, contactUserId])
  @@index([userId])
}
```

No `Link` schema changes — `visibility` and `revokedAt` already exist; this spec is pure
enforcement logic, not new columns.

## 3. Enforcing `revokedAt` and `visibility`

### 3.1 Revoke ("close the box")

New owner-only endpoints:

- `POST /api/links/:slug/revoke` — sets `revokedAt`. Per spec 2 §7's flagged assumption, this
  also immediately shreds any of the link's drops still `sealed`/`delivery_failed` (spec 2 §6's
  owner-cancel mechanism, reused here).
- `POST /api/links/:slug/unrevoke` — clears `revokedAt`. Does not restore anything already
  shredded.
- `PATCH /api/links/:slug` — body `{ visibility }`, owner-only, no side effects (unlike revoke).

`isLinkExpired` (or a new sibling `isLinkInactive` covering both expiry and revocation) must be
checked everywhere a link is currently read for serving purposes (`GET /api/links/:slug`, upload,
claim) — a revoked link 404s exactly like an expired one.

### 3.2 Visibility (`contacts-only`)

`GET /api/links/:slug` currently returns the full response unconditionally. New rule: for a
`contacts-only` link, only return the full response if the requester is authenticated **and**
`hasAcceptedContact(link.ownerId, requester.id)` is true (existing helper, `lib/contacts.ts`) —
otherwise **404**, identical to "link not found," never a 403. This matches this codebase's
existing anti-enumeration convention (e.g. password-reset-request's IP-keyed limiter is explicitly
designed so a response never reveals which emails are registered) — a `contacts-only` link's mere
existence shouldn't be distinguishable from a non-existent slug to a non-contact.

`public` links are unaffected by this check; the default profile link's own `recipientName`/
`recipientEmailVerified`/`recipientUsername` fields (spec 1 §6.4) already work for `public`
visibility as-is.

## 4. Unverified accounts behave like anonymous visitors

No `emailVerified` check exists anywhere in `apps/api/src/routes/links.ts` today — a logged-in but
unverified user can currently do everything a fully verified one can. This spec adds an explicit
gate to every owner-link-creation path:

- `POST /api/links/custom` — requires `request.user.emailVerified`; an unverified caller is
  rejected (400) with a message pointing at email verification, not silently treated as anonymous
  (they're authenticated, just not entitled yet — a clear error is more honest than a confusing
  silent fallback).
- **Tightens spec 1 §4.1**: `POST /api/links/request` was speced there as "requires an
  authenticated session" — this spec tightens that to "requires an authenticated **and verified**
  session," consistent with this rule. (Flagging this explicitly since it changes a detail from an
  already-written spec rather than introducing something new.)
- The default profile link created at registration (`createDefaultLinkForUser`) keeps being
  created unconditionally at registration (unchanged — avoids coupling registration to the
  verification flow), but is **read-gated**: `isLinkInactive` (§3.1) treats an owned link whose
  owner is unverified as inactive, the same way a revoked one is. Once verified, no migration step
  is needed — the same read-time check just starts passing.
- Frontend: any link-management UI (the future dashboard in spec 5, `NewLinkPage`, `RequestLinkPage`
  from spec 1) is hidden/disabled when `user && !user.emailVerified`, mirroring spec 3's banner
  condition exactly.

## 5. Extended profile: friend-request button

On a `public` link that is the owner's default profile link, the sender-facing page (`UploadPage`,
spec 1) already shows the recipient's identity badge (spec 1 §6.4). This spec adds a "connect"
button there:

- Always rendered (so its mere presence/absence doesn't leak `allowContactRequests`'s value to a
  stranger — no information asymmetry between "off" and "not looked at yet").
- `disabled` when `owner.allowContactRequests === false`.
- When enabled and clicked (requires the *viewer* to be authenticated — an anonymous sender simply
  doesn't see a functional button, same disabled treatment), calls the existing `POST
  /api/contacts` (`lib/contacts.ts`'s `sendContactRequest`, unchanged).

`allowContactRequests` is a plain user-level toggle in `AccountPage.tsx` (spec 3's new 2FA/email
sections live in the same page — this is a third small settings section alongside them).

## 6. Contact blocking — "disappears" semantics

Standard blocking model, not a mutual "you're blocked" notice: the blocker sees the block; the
blocked party sees nothing distinguishing it from "this person doesn't exist."

- `POST /api/contacts/:id/block` — callable from an incoming pending request or an existing
  accepted contact. Sets `status: "blocked"`, `blockedByUserId: <caller>`.
- `POST /api/contacts/:id/unblock` — only the party recorded in `blockedByUserId` may call this;
  deletes the row outright (no restoration to `pending`/`accepted` — the other party would need to
  send a fresh request).
- `sendContactRequest` (`lib/contacts.ts`): if an existing row has `status: "blocked"` **and**
  `blockedByUserId === target.id`, respond with the exact same "User not found" error used for a
  genuinely nonexistent username — never a distinguishable "blocked" error.
- `listContacts`: a row with `status: "blocked"` is only ever returned to the party named in
  `blockedByUserId`. The blocked party's own listing omits it entirely — it simply isn't there.
- **Extends to profile visibility** (§3.2's mechanism): a blocked visitor gets the same 404 on the
  blocker's public profile link as anyone the owner has never interacted with — "disappears" is
  applied consistently, not just in the contacts list.
- `hasAcceptedContact` needs no change — a blocked relationship is never `"accepted"`, so it's
  already excluded from every check that relies on that helper (§3.2, spec 1's inbox-identity
  rule).

## 7. API surface (new/changed)

| Endpoint | Change |
|---|---|
| `POST /api/links/:slug/revoke` | **New** |
| `POST /api/links/:slug/unrevoke` | **New** |
| `PATCH /api/links/:slug` | **New** (visibility only) |
| `GET /api/links/:slug` | Now enforces `contacts-only` (404 for non-contacts) and revoke/unverified-owner inactivity |
| `POST /api/links/custom` | Now requires `emailVerified` |
| `POST /api/links/request` (spec 1) | Requirement tightened: authenticated **and** verified |
| `POST /api/contacts/:id/block` | **New** |
| `POST /api/contacts/:id/unblock` | **New** |
| `POST /api/contacts` (`sendContactRequest`) | Blocked-target case returns generic not-found |
| `GET /api/contacts` (`listContacts`) | Blocked rows filtered per-viewer as described in §6 |

## 8. Testing strategy

- `isLinkInactive`: revoked, unverified-owner, and expired links all 404 identically on read;
  `public` links from a verified owner are unaffected.
- Visibility: `contacts-only` link 404s for an anonymous or non-contact requester, succeeds for an
  accepted contact and for the owner themselves.
- Creation gate: `POST /api/links/custom` and `POST /api/links/request` both reject an
  authenticated-but-unverified caller; anonymous `POST /api/links` is unaffected.
- Revoke side effect: revoking a link with a `sealed` drop shreds it (spec 2's mechanism); a
  `delivered` drop is untouched.
- Blocking: blocked party's `sendContactRequest` gets the identical error shape/message as a
  nonexistent username (byte-for-byte, not just similar wording); blocked party's `listContacts`
  never contains the row; only the blocker can unblock; a blocked visitor 404s on the owner's
  profile link.
- Friend button: renders (enabled or disabled) identically whether `allowContactRequests` is true
  or false — never absent — so its presence carries no information.
