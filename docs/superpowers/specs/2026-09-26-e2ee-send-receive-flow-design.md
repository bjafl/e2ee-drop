# E2EE send/receive flow redesign — design spec

Date: 2026-09-26
Status: draft, pending review
Extends: `docs/superpowers/specs/2026-09-24-e2ee-drop-rewrite-design.md` (§2 Core cryptography, §2.1 codewords — unchanged, referenced below)

This is spec 1 of a 5-spec roadmap covering a large backlog of feature requests. The other four —
delivery lifecycle/audit/retention state machine (spec 2), account verification & 2FA UI (spec 3),
verified-profile/contacts/blocking (spec 4), dashboard & unified inbox (spec 5) — are written up
separately and depend on the schema this spec introduces. The dark-mode native-`<select>` styling
bug is unrelated, bounded work, tracked outside this spec.

## 1. Purpose and scope

Rebuild the sender (`/send/:slug`) and receiver (`/receive/:slug`, replacing `/download/:slug`)
flows end to end. In scope:

- End-to-end encrypted message, alongside the existing encrypted file transfer (today the message
  is sent as plaintext — see §3.1).
- Multi-file support: files are zipped client-side before encryption.
- The three payloads (message, file metadata, file archive) become three independently encrypted,
  independently-lifecycled envelopes.
- A new sender-initiated "request a drop" flow, symmetric to the existing recipient-initiated flow,
  where the recipient claims the link after creation instead of being fixed at creation time.
- Sender-side UX: multi-file dropzone, explicit send button, anonymous-sender consent, live
  progress for encryption and upload.
- Receiver-side UX: automatic metadata display, one-time message reveal, one-time file download,
  live progress for download and decryption, optional auto-save.
- An open (deliberately unencrypted), optional note from whoever creates the link to whoever
  completes the other half of the exchange.
- An extended, conditionally-detailed identity badge shown to the sender about the recipient.
- Optional PIN-based protection for a locally-stored (non-account) private key.
- Per-link configurable content retention, bounded by an operator-configured maximum and by the
  link's own expiry.

**Explicitly out of scope** (tracked in the other specs or as future work):
- The full delivery/audit status state machine's cross-link aggregation, dashboard/inbox UI, and
  long-term audit retention sweep — spec 2 introduces the *status fields* this spec's endpoints
  write to, but the read-side (dashboard, inbox, history views) is spec 5.
- 2FA setup UI and QR rendering (needs its own library choice) — spec 3.
- Contacts, blocking, profile visibility enforcement — spec 4.
- Claim notifications (push/email) — noted as a future add-on; for now, a claimed link is only
  visible via the sender re-checking the link (spec 5's dashboard will surface this properly).

## 2. Data model changes

Full field-level diff. Renamed/removed columns are called out explicitly since they change API
response shapes other code may depend on.

### `User`

```prisma
model User {
  // ...unchanged existing fields...

  // NEW — controls whether the recipient's email is shown on the user's default
  // public profile link specifically (see §6.4). Other owned links are unaffected.
  showEmailOnPublicProfile Boolean @default(false)
}
```

### `Link`

```prisma
model Link {
  id                 String    @id @default(cuid())
  ownerId            String?
  owner              User?     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  slug               String    @unique
  mode               String
  visibility         String    @default("public")

  // CHANGED: was non-null. Null means "not yet claimed" — see §4.2.
  recipientPublicKey String?

  codewordLocale     String    @default("en")

  // CHANGED: was Int? defaulting silently at read-time to env.DROP_RETENTION_DAYS.
  // Now NOT NULL — always set explicitly at creation (pre-filled from
  // DROP_RETENTION_DAYS_DEFAULT, validated against DROP_RETENTION_DAYS_MAX and
  // the link's own expiry — see §4.4).
  retentionDays      Int
  isDefault          Boolean   @default(false)
  createdAt          DateTime  @default(now())
  expiresAt          DateTime?
  revokedAt          DateTime?
  drops              Drop[]

  // NEW — deliberately unencrypted (see §4.3 for why encryption isn't possible here).
  // Written by whichever party creates the link; read by whichever party completes it.
  ownerNote          String?

  @@index([ownerId])
}
```

### `Drop`

```prisma
model Drop {
  id              String   @id @default(cuid())
  linkId          String
  link            Link     @relation(fields: [linkId], references: [id], onDelete: Cascade)
  senderPublicKey String
  senderUserId    String?
  senderUser      User?    @relation(fields: [senderUserId], references: [id], onDelete: SetNull)

  // File-archive envelope (one zip blob, as before) — "nonce" renamed since there
  // are now three distinct nonces on this row.
  s3Key        String
  archiveNonce String
  contentMD5   String   // nacl.hash over the ciphertext bytes — see §6.3 for why this
                         // was previously computed and stored but never verified.

  // Message envelope — REPLACES the old plaintext `message` column.
  encryptedMessage  String?
  messageNonce      String?
  messageRevealedAt DateTime? // set atomically with the scrub in §6.2

  // Metadata envelope — REPLACES the old plaintext fileName/fileSize/mimeType
  // columns. JSON shape: { files: [{ name, size }], mimeType }.
  // fileSize is duplicated in cleartext below because quota checks need it
  // before any decryption is possible — see §5.1.
  encryptedMetadata String
  metadataNonce     String
  fileSize          Int      // cleartext, quota/reservation accounting only

  // Internal upload bookkeeping — same purpose as today's Drop.status, narrowed to
  // just the file transfer's own in-flight state, since the CAS logic in
  // uploads.ts (reservation, one-time single-drop invariant) needs a precise
  // in-progress marker distinct from the display-level status below.
  fileUploadStatus     String  @default("reserved") // "reserved" | "uploading" | "complete"
  reservationSenderKey String?

  // Display/business status (spec 2 owns the full state machine and the read
  // side; this spec's endpoints are what write these two fields).
  deliveryStatus        String @default("sender_opened")
  // "sender_opened" | "sent" | "receiver_opened" | "partial_delivery" | "delivered"
  messageEnvelopeStatus String @default("sealed")
  fileEnvelopeStatus    String @default("sealed")
  // both: "sealed" | "delivery_failed" | "delivered" | "shredded"

  // Scrub marker (content deleted, row kept for audit — spec 2 owns the final
  // purge sweep). This spec's complete-download/reveal-message endpoints set it.
  contentDeletedAt DateTime?

  createdAt DateTime @default(now())

  @@index([linkId])
}
```

Removed from `Drop`: `nonce`, `fileName`, `mimeType`, `message`, `status`.

### New environment variables (`apps/api/src/env.ts`)

`DROP_RETENTION_DAYS` is replaced by two variables:

```
DROP_RETENTION_DAYS_DEFAULT  (default: 1)  — pre-fills retentionDays in creation forms
DROP_RETENTION_DAYS_MAX      (default: 7)  — hard server-side ceiling
```

These match the current live defaults exactly (`LINK_EXPIRY_HOURS` defaults to 24h = 1 day;
`DROP_RETENTION_DAYS` currently defaults to 7) — this is a split of one existing variable into a
default/max pair, not a behavior change for existing deployments that haven't overridden it.

## 3. Cryptography

### 3.1 Three-envelope split

Today, only the file is encrypted (`nacl.box`, Curve25519-XSalsa20-Poly1305, per the original
design's §2). The message is sent and stored as plaintext, and file metadata (name/size/mimetype)
is likewise plaintext in the DB and API responses — both are real confidentiality gaps this spec
closes, not just refactors.

All three payloads below are encrypted independently with `nacl.box`, using the same
sender/recipient keypair, each with **its own randomly generated nonce** — nonces must never be
reused across different plaintexts under the same keypair:

1. **Message** (optional) → `encryptedMessage` + `messageNonce`
2. **File metadata** (`{ files: [{name, size}], mimeType }`) → `encryptedMetadata` + `metadataNonce`
3. **File archive** (zip of all selected files, via `fflate` — see §8) → archive ciphertext (stored
   at `s3Key`) + `archiveNonce`

Zipping and all three encrypt/decrypt operations happen in the existing `crypto.worker.ts`
(extended, not replaced), off the main thread.

### 3.2 Sender authenticity

`nacl.box` is *authenticated* encryption: `box.open(ciphertext, nonce, senderPublicKey,
recipientSecretKey)` fails its Poly1305 MAC check unless the ciphertext was genuinely produced by
whoever holds the secret key matching the claimed `senderPublicKey`. This is already documented as
the system's TOFU trust model in the original design spec (§2). Concretely: an attacker without a
specific victim sender's secret key cannot forge content that decrypts successfully *as if* from
that sender — the worst they can do is substitute their own genuine keypair, which changes who the
content appears to be from, not falsely impersonate a specific targeted identity.

**Gap found and closed by this spec:** `Drop.senderUserId` (used by spec 5's inbox to show a
human-readable sender name) is a plain server-set label with no cryptographic binding to
`senderPublicKey` today. If those two fields could diverge, the inbox could display a different
account's name than the one that actually produced the ciphertext. Fix: `POST
/api/links/:slug/upload-url` must validate, when a session is present, that
`request.senderPublicKey === session.user.publicKey`, rejecting (400) on mismatch, before setting
`senderUserId`. Anonymous drops (`senderUserId: null`) make no identity claim, so no such check
applies there.

### 3.3 Integrity verification before deletion

`contentMD5` (a `nacl.hash` digest over the ciphertext, computed today in `useFileEncryption.ts` at
upload time) is already stored and already returned in `DownloadUrlResponse` — but is **never
verified anywhere**, another dead field like several others found during this project's review.
This spec wires it up: after fetching the archive ciphertext, the receiver's client recomputes the
hash and compares it to the stored value *before* reporting completion (§6.3). A mismatch means a
corrupted/incomplete transfer — reported as `delivery_failed`, content kept, retry offered. A match
is sufficient to report `delivered` (which triggers server-side deletion) — decryption is attempted
afterward and is not gated on it: a decrypt failure despite a verified-matching hash means wrong
key/wrong recipient, not corruption, and a retry wouldn't fix it.

### 3.4 Optional PIN protection for locally-stored anonymous keys

Applies wherever an anonymous private key is generated and kept only in `localStorage`
(`useLocalLinks.ts`): the existing anonymous link-creation flow, and the new claim flow's
"continue anonymously" option (§4.2).

Reuses `apps/web/src/lib/keyWrapping.ts` as-is — `generateWrappingSalt`, `deriveWrappingKey`
(argon2id via `hash-wasm`), `wrapPrivateKey`/`unwrapPrivateKey` (`nacl.secretbox`) — the same
primitives already used for the account password flow, applied to a new context. When a PIN is
set, the private key is wrapped before being written to `localStorage`; unwrapping requires the PIN
on next use. Without a PIN, storage is unchanged (raw key, as today).

**Caveat carried into the UI copy, not just this doc:** argon2id's parameters here are tuned for a
real password; a short PIN (typically 4–6 digits) has far less entropy, so this is meaningfully
weaker against a determined offline attacker than the account password flow it borrows from. Copy:
*"Denne PIN-en gjør det vanskeligere for andre som bruker samme nettleser å dekryptere innholdet
ditt. Den er ikke en erstatning for ordentlig sikkerhet — unngå å stole på denne løsningen på en
delt eller offentlig maskin."*

## 4. Link creation and claim flows

Three creation entry points now exist:

1. **Anonymous** (`/create`, existing `CreateLinkPage.tsx`) — recipient-initiated, unauthenticated.
   Changed from today's auto-create-on-mount to an explicit form (see §4.3, §4.4) with an
   explicit "Create" button.
2. **Owned, recipient-initiated** (`/links/new`, existing `NewLinkPage.tsx`) — unchanged shape,
   gains `ownerNote` and `retentionDays` fields.
3. **Owned, sender-initiated** (new `/links/request`, new `RequestLinkPage.tsx`) — see §4.2.
   Requires an authenticated session, since quota accounting requires an `ownerId` (anonymous links
   carry no quota tracking today, and that doesn't change here).

### 4.1 `POST /api/links/request` (new)

Auth required. Body: `{ ownerNote?, retentionDays? }`. Creates a `Link` with `recipientPublicKey:
null`, `ownerId: <caller>`. No keypair is generated by the initiator — the eventual recipient
supplies one at claim time. Returns the slug immediately.

### 4.2 Claiming a link

`/receive/:slug` branches into a claim view whenever `Link.recipientPublicKey === null`: the
visitor chooses "log in and use my account key" or "continue anonymously" (generating a fresh local
keypair, same mechanism as today's `CreateLinkPage`, subject to §3.4's optional PIN). `POST
/api/links/:slug/claim` — `{ recipientPublicKey }`, no auth required (anonymous claim is allowed).
Once set, the link behaves exactly like a recipient-initiated link from that point on.
`/send/:slug` shows a "waiting for the recipient to activate this link" state until claimed,
detected via the existing per-link SSE channel (`dropEvents.ts`) the page is already subscribed to.

No claim-completion notification beyond this is built in this spec (see §1's out-of-scope note).

### 4.3 Owner note

`Link.ownerNote` is deliberately plaintext: at link-creation time there is no counterparty public
key to encrypt against yet (the "recipient" of *this* note is whoever completes the other half of
the exchange, which doesn't exist yet at creation time in either flow). Shown to whichever party
isn't the creator — the sender in the recipient-initiated flow, the recipient in the
sender-initiated flow — with an explicit "this note is not encrypted" label in the UI, styled with
the same warning treatment the current (removed) `messageNotEncryptedWarning` alert uses.

### 4.4 Retention

`retentionDays` is now always set explicitly at creation (§2, `Link.retentionDays` is NOT NULL),
pre-filled from `DROP_RETENTION_DAYS_DEFAULT` and adjustable by the owner up to
`min(DROP_RETENTION_DAYS_MAX, link's own expiry duration in days)` when the link has an
`expiresAt`; permanent links are only bounded by `DROP_RETENTION_DAYS_MAX`. Server-side validation
enforces this on both `POST /api/links` and `POST /api/links/custom` (the anonymous flow gains this
field for the first time — previously only `CreateCustomLinkRequest` had it).

`LinkStatusResponse` gains `retentionDays`, shown to the sender alongside days-until-link-expiry and
fixed copy noting that content is deleted on download regardless of the retention timer.
`ReceivePage` shows both the link's own expiry and a server-computed `contentExpiresAt` per drop
(computed server-side, not client-side, to avoid clock skew).

## 5. Sender (upload) flow

**Scope note on `deliveryStatus` timing:** the earlier design discussion agreed that a
"sender_opened" event should ideally be tracked from the moment the sender's page is opened,
*before* any file is picked — so a visit that never leads to a send still shows up in the owner's
history as "opened, never sent." Implementing that fully requires a tracking row to exist earlier
than today's upload flow creates one (`Drop` is created lazily, at step 4 below, same timing as
today). This spec keeps that lazy creation timing and only sets `deliveryStatus`'s default value to
`"sender_opened"` as a placeholder; actually creating a record at page-open time (and the API shape
that requires) is left to spec 2, which owns the full delivery-status lifecycle and its read side.

1. Dropzone (`react-dropzone`, §8) accepts one or more files; a message textarea accepts optional
   text. The send button is enabled once either has content.
2. If the sender is not authenticated, clicking send shows a consent dialog (`ui/alert-dialog.tsx`,
   §8): "you're sending as an anonymous user" with options to log in or continue anonymously.
3. Worker zips selected files, encrypts the three envelopes (§3.1).
4. `POST /api/links/:slug/upload-url` — body: `{ senderPublicKey, encryptedMessage?, messageNonce?,
   encryptedMetadata, metadataNonce, metadata: { fileSize, contentMD5 } }`. Server validates the
   sender-identity binding (§3.2) and the existing quota/reservation checks (unchanged, keyed off
   the now-cleartext `fileSize`). Creates the `Drop` (`fileUploadStatus: reserved`).
5. `XHR PUT` of the archive ciphertext to the returned signed URL, `xhr.upload.onprogress` driving
   the upload progress bar (`ui/progress.tsx`, §8).
6. `POST .../drops/:dropId/complete` on success → `fileUploadStatus: complete`, `deliveryStatus:
   sent`.

### 5.1 Interrupted upload after the message was already accepted

If the PUT fails or is abandoned, the whole in-progress attempt is discarded rather than resumed:
`POST .../drops/:dropId/abandon` (new; CAS-guarded on `fileUploadStatus` still being
`reserved`/`uploading`) clears the message fields, releases any quota reservation immediately, and
deletes the `Drop` row outright. A retry is simply a fresh `POST /upload-url` call with newly
encrypted payloads. This matters concretely for one-time links: without an active abandon step, a
stale `reserved` row would block a retry via the existing "at most one drop" invariant until the
passive reservation-timeout sweep eventually expires it. That passive sweep remains as the
safety net for cases the client can't detect (crashed tab, closed browser) and is extended to also
scrub the message fields, not just release quota, when it fires.

## 6. Receiver flow (`/receive/:slug`)

### 6.1 Metadata (automatic, no gate)

`GET /api/links/:slug` sets `deliveryStatus: receiver_opened` (CAS, first time only) and returns
`encryptedMetadata`/`metadataNonce` directly — decrypted and shown immediately on page load. This
does **not** count as a secure envelope "leaving the server": it's small, not burn-on-read, and
always included in this response, unlike the message and archive (§6.2, §6.3), which are only
transmitted on an explicit, separate request. This is also where the claim-needed state (§4.2) and
the extended sender/recipient badge (§6.4) are served from.

### 6.2 Message (one-time reveal)

Shown only if the drop has a message (`hasMessage` flag on the response — the boolean itself isn't
sensitive). A "decrypt message" button carries an explicit warning that this can only be done once.
`POST .../drops/:dropId/reveal-message` — atomic: returns `{ ciphertext, nonce }` once, and in the
same operation nulls `encryptedMessage`/`messageNonce` and sets `messageEnvelopeStatus: delivered`.
A repeat call 404s/409s. No UI path exists to retry after a successful reveal — the button is
removed after use.

### 6.3 File archive (one-time download)

"Download all" fetches the archive ciphertext via `fetch()` with a `ReadableStream` reader against
the `content-length` header, driving the download progress bar. On completion, the client
recomputes the ciphertext hash and compares it to the server-recorded `contentMD5` (§3.3):

- **Match** → decrypt (worker, own progress bar), then `POST .../drops/:dropId/complete-download`
  (atomic: `fileEnvelopeStatus: delivered`, deletes the S3 object, sets `contentDeletedAt`).
- **Mismatch, or the fetch itself was aborted/failed** → `POST .../drops/:dropId/download-failed`
  (`fileEnvelopeStatus: delivery_failed`); the blob is untouched server-side and the download can be
  retried.

A persisted "auto-save zip" toggle (`localStorage`) decides whether a completed decryption
immediately triggers a save (`a.click()`, today's behavior) or instead shows an explicit "save"
button holding the blob URL.

### 6.4 Extended identity badge

Shown on the sender's page (`/send/:slug`) about the link's recipient, and gated on the
**recipient's own verification status** (unverified/anonymous owner → shown as fully anonymous,
regardless of viewer — this mirrors the existing rule elsewhere in the broader roadmap that an
unverified account behaves like an anonymous one):

- Verified owner: name, username, 2FA badge (always shown, on or off), and email — subject to:
- **Email visibility**: shown in full when the owner has `showEmailOnPublicProfile` enabled *or*
  the link being viewed isn't the owner's default username-slug profile link (only that one
  specific link type is realistically guessable/enumerable by username; other links use
  random or owner-chosen-but-not-broadly-guessed slugs). Otherwise omitted entirely. (No
  sender-side redaction-by-viewer-status — that earlier design was simplified away per discussion;
  the gate is purely the recipient's own settings/link type.)

## 7. API surface (new/changed only)

| Endpoint | Change |
|---|---|
| `POST /api/links` | `+ ownerNote?`, `+ retentionDays?` |
| `POST /api/links/custom` | `+ ownerNote?`, `+ retentionDays?` (now validated, not silently defaulted) |
| `POST /api/links/request` | **New** — sender-initiated flow, auth required |
| `POST /api/links/:slug/claim` | **New** — sets `recipientPublicKey` |
| `POST /api/links/:slug/upload-url` | Body reshaped (§5); adds sender-identity check (§3.2) |
| `PUT <uploadUrl>` | Unchanged transport; client now uses XHR for progress |
| `POST .../drops/:dropId/complete` | Unchanged behavior; now also sets `deliveryStatus: sent` |
| `POST .../drops/:dropId/abandon` | **New** (§5.1) |
| `GET /api/links/:slug` | Sets `receiver_opened`; returns encrypted metadata, `hasMessage`, `ownerNote?`, conditional email (§6.4) |
| `POST .../drops/:dropId/reveal-message` | **New** (§6.2) |
| `GET .../download-url` | Unchanged |
| `POST .../drops/:dropId/complete-download` | **New**, replaces the old best-effort `/downloaded` (§6.3) |
| `POST .../drops/:dropId/download-failed` | **New** (§6.3) |

## 8. Frontend components and libraries

| Component/module | Change |
|---|---|
| `UploadPage.tsx` | Dropzone, send button, consent dialog, dual progress bars, `ownerNote`, extended badge, claim-wait state |
| `DownloadPage.tsx` → `ReceivePage.tsx` | Claim UI, auto metadata display, message reveal, gated download, auto-save toggle |
| `useFileEncryption.ts` | Adds zip step, splits into three encrypt calls / three decrypt calls, per-phase progress |
| `crypto.worker.ts` | Extended for zip + three-way encrypt/decrypt |
| `CreateLinkPage.tsx` | Explicit form (was auto-create-on-mount): `ownerNote`, `retentionDays`, explicit "Create" button |
| `NewLinkPage.tsx` | `+ ownerNote`, `+ retentionDays` |
| `RequestLinkPage.tsx` | **New** |
| `useLocalLinks.ts` | Optional PIN wrapping via `lib/keyWrapping.ts` (§3.4) |
| New small hooks | XHR upload-progress wrapper; fetch+stream-reader download-progress + hash-verification wrapper |

**New dependencies**, checked for current maintenance health (not just from memory) before
recommending, per your "open, safe, well-maintained only" bar:

| Need | Package | Health signal (checked 2026-09-26) |
|---|---|---|
| Zip | `fflate` | 70M weekly downloads, MIT, pure JS (worker-safe), last active May 2026 |
| Dropzone | `react-dropzone` | 7.1M weekly downloads, MIT, v20.1.2 released 10 days before this check |

No new dependency needed for: progress bars (`ui/progress.tsx` — already installed, unused
shadcn component), confirmation/warning dialogs (`ui/alert-dialog.tsx` — already installed and
already used in `DeleteAccountDialog.tsx`), or PIN-based key wrapping (reuses `lib/keyWrapping.ts`,
already a dependency via `hash-wasm`).

## 9. Testing strategy

- **Crypto worker**: unit tests for zip→encrypt→decrypt→unzip round-trip across 0/1/many files;
  nonce uniqueness across the three envelopes; tamper tests (flipped bit in each envelope
  independently must fail `box.open`, never silently succeed).
- **Sender-identity check** (§3.2): authenticated upload with mismatched `senderPublicKey` is
  rejected; anonymous upload is unaffected.
- **Integrity gate** (§3.3): matching hash marks delivered and deletes; mismatched hash marks
  `delivery_failed` and preserves the object; a decrypt failure after a *matching* hash does not
  re-trigger `delivery_failed`.
- **Abandon flow** (§5.1): interrupted upload frees the one-time-link slot immediately, without
  waiting for the passive reservation timeout; message fields are cleared.
- **Reveal-message** (§6.2): second call after a successful reveal fails; concurrent calls resolve
  to exactly one winner.
- **Claim flow** (§4.2): unclaimed link blocks upload; claim is idempotent-safe against a
  concurrent double-claim (CAS on `recipientPublicKey IS NULL`).
- **Retention validation** (§4.4): `retentionDays` above the max, or above the link's own expiry,
  is rejected; permanent links are bounded only by the max.
- E2E: existing Playwright-style flows (`verify:e2e`) extended to cover multi-file send, message
  reveal, and the sender-initiated claim path.

## 10. Assumptions log (flag if any of these should change)

- The sender-initiated request flow (§4.1) requires authentication; anonymous users cannot initiate
  it, matching the existing rule that only owned links carry quota accounting.
- Claim-completion has no push/email notification in this spec — surfaced only via spec 5's
  dashboard/sent-list.
- Email badge visibility (§6.4) is gated purely on the recipient's own settings and link type, not
  on the viewing sender's own account/verification status (simplified from an earlier
  viewer-status-based redaction design during review).
