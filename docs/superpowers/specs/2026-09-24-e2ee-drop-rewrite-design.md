# e2ee-drop: full rewrite design spec

Date: 2026-09-24
Status: approved (brainstorming), pending implementation plan

## 1. Purpose and origin

`e2ee-drop` is a full rewrite of `e2ee-file-drop` (originally a Netlify
Functions + Backblaze B2 serverless app). The rewrite keeps the core
concept — recipient-initiated, end-to-end encrypted file transfer where
the server never sees plaintext or ciphertext bytes — but moves to a
self-hosted Docker Compose deployment and adds optional user accounts on
top of the existing fully-anonymous, no-login flow. The app is designed
to be generically self-hostable: anyone should be able to clone the repo,
run `docker compose up`, and operate their own instance.

Both flows (anonymous and account-based) must remain first-class. Nothing
in the account system may weaken or complicate the anonymous path.

## 2. Core cryptography (unchanged from original)

- Recipient generates a NaCl box keypair (`nacl.box.keyPair()`,
  Curve25519) client-side.
- Sender generates their own ephemeral (or account) keypair, encrypts the
  file client-side with `nacl.box` (Curve25519 + XSalsa20-Poly1305) using
  their secret key and the recipient's public key. This gives
  confidentiality *and* sender authentication (the recipient can verify
  the file was encrypted by whoever holds the secret key matching the
  claimed `senderPublicKey`) — a TOFU trust model, not an identity
  verification system.
- Encryption/decryption run in a Web Worker with a synchronous fallback,
  as in the original.
- The server never receives plaintext file bytes or private keys.

### 2.1 Link verification codewords

Because the trust model above is TOFU (§2), a sender or recipient has no
built-in way to notice they've been handed a wrong or tampered link. To
give both parties a cheap, human-usable way to catch that (read a short
phrase aloud over a call, in chat, or in person, and confirm it matches),
every `Link` gets a short, deterministic sequence of codewords derived
from its `recipientPublicKey` — which is already public data, so
generating and displaying this server-side does not weaken the
zero-knowledge property anywhere else in the system.

- **Derivation:** a SHA-256 hash of the raw `recipientPublicKey` bytes is
  split into consecutive 8-bit groups, each indexing a word in a
  256-word list — the same size the classic PGP Word List uses for this
  exact purpose (a short, spoken/compared fingerprint, not a secret). A
  256-word list is small enough to curate for real — genuinely short,
  unambiguous, hard-to-mishear nouns — which matters more here than
  squeezing out extra bits per word the way a 2048-word BIP39-style list
  would. The same public key and the same locale always produce the same
  words — this is what makes the codewords usable for comparison at all.
- **Word count:** the UI shows 3 words by default, with a "show more"
  control that reveals further words (derived from later bytes of the
  same hash) up to a configurable maximum — default 5, allowing an
  operator to raise it for a higher-assurance deployment. More words
  trade convenience for a lower chance that two different keys collide
  on the same displayed phrase.
- **Language:** fixed per-link at creation time, based on the UI
  language of whoever creates the link (for an anonymous link or a
  registered user's default/custom link, that's the person sharing it
  out — the "avsender" of the link itself, not of a file), and stored on
  the `Link` row so every later viewer — sender and recipient alike —
  sees the identical phrase regardless of their own browser's language.
  Launches with Norwegian and English word lists; adding a language is
  just adding a new 2048-entry word list file and locale code.
- **Word list requirements:** common, short (capped length), unambiguous
  nouns — no homophones, no words likely to be mistyped, spoken, or
  misheard across regional accents, no offensive terms.
- **Explicit caveat:** this is a usability aid against accidental
  wrong-link sharing and gross tampering, not a cryptographic replacement
  for comparing full key material — at 8 bits of entropy per word, the
  default 3-word phrase (24 bits) is meant to be quick to compare, not
  collision-proof; a deployment wanting stronger assurance should use the
  "show more" option. This is the same honest trade-off Signal documents
  for its own short safety-number comparison.

## 3. Key management for accounts

### 3.1 Registration and password-derived key wrapping

At registration, the client:

1. Generates a NaCl box keypair locally.
2. Derives a symmetric wrapping key from the account password using
   Argon2id, with a random salt generated at registration and stored
   server-side (salt is not secret).
3. Encrypts the private key locally with the derived key
   (`passwordWrappedPrivateKey`), and sends only the encrypted blob, the
   salt, and the public key to the server. The server never sees the
   plaintext password (only a separate Argon2id password hash for login)
   or the plaintext private key.

On login from any device, the client fetches
`(passwordWrappedPrivateKey, salt, publicKey)`, re-derives the wrapping
key from the password the user enters, and decrypts the private key
locally. This is what makes cross-device history and a persistent
account identity possible without breaking the zero-knowledge property.

### 3.2 Recovery code

At registration, the client also generates a second random high-entropy
key (the "recovery code"), shown to the user once (they must save it
themselves — never stored in retrievable form), and uses it to produce a
second wrapped copy of the same private key
(`recoveryWrappedPrivateKey`), stored server-side alongside the
password-wrapped copy.

### 3.3 Password reset — two paths

- **With a valid recovery code:** the client uses the recovery code to
  decrypt the private key locally (via `recoveryWrappedPrivateKey`),
  lets the user set a new password, re-wraps the *same* private key with
  a newly derived key, and uploads the updated
  `passwordWrappedPrivateKey`. No data loss — existing links and queued
  drops remain decryptable.
- **Without a valid recovery code (lost or never saved):** the old
  private key is unrecoverable. The reset flow says this explicitly,
  then performs a **cascade delete** of the account's data: all `Link`
  rows owned by the user, all their `Drop` rows, and the corresponding
  MinIO objects, followed by generating a fresh keypair wrapped with the
  new password. Contacts (the relationship rows) are preserved — only
  key-dependent data is destroyed.

Account deletion always cascade-deletes all owned `Link`/`Drop` rows and
MinIO objects, plus the `User` row and their `Contact` rows.

### 3.4 Two-factor authentication is independent of key wrapping

2FA (TOTP, RFC 6238) is a pure login gate: password check, then (if
enabled) a TOTP code check, then a session is issued. The TOTP secret is
*not* mixed into the private-key KDF. Rationale, established during
design: the server must already be able to read the TOTP secret to
verify codes at login (unlike the password, which the server never sees
in plaintext), so folding it into key-wrapping would not add the same
protection a compromised-database scenario gets from the password.
Worse, it would tie private-key recoverability to 2FA-reset flows (e.g.
losing a phone), turning a recovery mechanism into another way to
permanently lose data. TOTP secrets are stored encrypted at rest using a
server-side application secret (`APP_SECRET_KEY` env var).

### 3.5 Anonymous flow key storage (unchanged, plus optional local password)

The anonymous, no-login flow is preserved exactly: a keypair is
generated client-side, and the private key lives only in `localStorage`,
scoped by session, with the existing expiry mechanism. The server has no
role in anonymous key storage at all — it never sees the anonymous
user's public key wrapping choice.

New addition: when creating an anonymous link, the user is offered a
choice — "Protect this key with a local password?" If yes, the private
key is encrypted client-side (WebCrypto, PBKDF2/Argon2 in-browser) with a
password the user supplies, before being written to `localStorage`; the
salt travels inside the same stored blob. If no (default, matching
original behavior), the key is stored unencrypted in `localStorage`, and
a short warning is shown explaining the exposure (e.g. to malicious
browser extensions or local device access).

## 4. Sessions and authentication

- Auth is email + password (Argon2id password hash, separate from the
  key-wrapping KDF material).
- Sessions are server-side, referenced by a signed, httpOnly, `SameSite`
  cookie (a `Session` table in Postgres: id, userId, expiresAt,
  createdAt). DB-backed sessions (not stateless JWT) were chosen because
  the app needs to be able to revoke sessions outright — e.g. forcing
  re-login on all devices after a password reset.
- Registration availability is controlled by an `ALLOW_REGISTRATION` env
  var (default: open), per the "generic self-hostable app" requirement —
  operators can lock it down without a code change.
- Optional TOTP-based 2FA per account, as in §3.4.
- Optional SMTP configuration (`SMTP_HOST/PORT/USER/PASS/FROM`) for email
  verification and password-reset request emails. If unset, those flows
  are unavailable and the UI says so (not a hard app-wide requirement,
  but the account system assumes it will be configured in most real
  deployments).

## 5. Data model (high-level; exact schema is a plan-stage decision)

- **User**: id, email, emailVerified (bool, default false), name
  (user-entered display name — never verified, shown to senders labeled
  as self-entered), passwordHash (Argon2id), passwordSalt,
  passwordWrappedPrivateKey, recoveryWrappedPrivateKey, publicKey,
  totpSecretEncrypted (nullable), totpEnabled (bool), storageQuotaBytes,
  storageUsedBytes, createdAt.
- **Link**: id, ownerId (nullable — null for anonymous links), slug,
  mode (`permanent` | `one-time`), visibility (`public` |
  `contacts-only`, only meaningful when `mode = permanent` and owned),
  recipientPublicKey (denormalized copy — the owner's `publicKey` at
  creation time for owned links, or a fresh one-off key for anonymous
  links), retentionDays (nullable override of the global default),
  isDefault (bool — true for the one auto-created personal link per
  user), createdAt, revokedAt (nullable).
- **Drop**: id, linkId, senderPublicKey, senderUserId (nullable —
  populated when the sender was authenticated), s3Key, nonce, fileName,
  fileSize, mimeType, contentMD5, message (nullable, short plaintext
  string, max ~500 chars — see §6.1), status, createdAt, expiresAt.
- **Contact**: id, userId, contactUserId, status (`pending` |
  `accepted`), createdAt — a mutual request/accept relationship, checked
  when a sender uploads to a `contacts-only` link.

Every registered user gets one non-deletable default `Link`
(`isDefault = true`, `slug = username`, `mode = permanent`) created at
registration; its `visibility` can be toggled between public and
contacts-only, but the link itself cannot be removed (this is what makes
`Link.slug` addressable at `/d/<username>` and gives every account a
stable personal inbox). Users may also create additional named links
with a custom slug, `mode`, and `visibility`.

The anonymous flow uses the same `Link`/`Drop` tables with `ownerId =
null` and `mode` always `one-time` — no separate anonymous-session
schema, avoiding two parallel systems for the same underlying concept.

### 5.1 Anonymous link authorization: the slug is a bearer capability

(Added after security review SEC10, which asked why a bystander who only
*saw* an anonymous link can delete it or complete its drop early.)

An anonymous link has no account behind it, so the only thing the server
can check is possession of its random slug (16 chars from a 34-symbol
alphabet, about 81 bits). Every route on an ownerless link accepts any
slug holder: `GET /api/links/:slug` (including the drop's id and its
plaintext metadata: file name, size, MIME type, message), `upload-url`,
`.../complete`, `download-url`, `.../downloaded`, `/events` and
`DELETE /api/links/:slug`. Owned links do not work this way: their
slugs are public, so their recipient-side routes are owner-gated.

This is an **accepted design**, not an oversight. What it does and does
not expose:

- **Confidentiality and integrity are unaffected.** File bytes are
  `nacl.box` ciphertext that only the creator's local private key opens.
  Only the party that called `upload-url` receives the presigned PUT,
  and a one-time link refuses a second drop, so a bystander cannot
  change a drop's bytes. The codewords (§2.1) let the sender check they
  have the right recipient key.
- **What a bystander can do is disrupt that one exchange:** delete the
  link, mark a drop complete or downloaded early, or, before the real
  sender uploads, take the link's single slot with a file of their own.
  The last one is the strongest, and it cannot be prevented, because
  "sender" means "anyone the slug was given to". There is no sender
  credential to check. The recipient's fix is the same in every case:
  create a new link and share it over a better channel.
- **Why the routes were not gated one by one.** A per-drop secret
  returned by `upload-url` and required by `/complete` would stop a
  bystander from completing someone else's upload early. But that same
  bystander can still `DELETE` the link, which does more damage, or
  take the slot before the upload starts. No attack is actually
  prevented, and every in-flight sender would have to change protocol.
- **What would actually help, if this threat ever matters.** Only the
  link's creator has something a bystander lacks: their `localStorage`
  entry (`useLocalLinks`). `POST /api/links` could return a random
  *manage token*, which the creator stores next to the private key and
  the server stores hashed on `Link`. Recipient-side routes
  (`DELETE`, `download-url`, `.../downloaded`, `/events`) would then
  require it. Add a per-drop *upload token* for `/complete`, and after
  the upload starts, a bystander could only read metadata. Taking the
  slot before the upload would still be possible. This needs a schema
  change, a new field in the creation response and in local storage,
  and a way to handle links created before the change. That is a
  redesign of the anonymous flow, which §1 says must not become more
  complicated. It is deferred until there is a concrete need for it,
  such as a "revoke link" button in the UI. Today no frontend code calls
  `DELETE /api/links/:slug`.

  Note the manage-token design has a practical gap of its own: `/events`
  is an `EventSource` connection, which cannot send a custom header, so
  a manage token protecting it would have to travel in the query string
  or a cookie instead — a detail to settle if this is ever built, not a
  reason it's unworkable.

- **A cheaper, token-free option for the early-complete sub-case
  specifically** (identified in the SEC10 re-review): make `/complete`
  verify rather than merely authorize. Before the CAS, HEAD the object
  at `drop.s3Key` and only proceed if its actual `Content-Length`
  matches `fileSize + NACL_BOX_OVERHEAD_BYTES` — a bystander (or, on an
  owned link, a sender who never actually PUT anything) can then only
  report a completion that's already true. Making the route idempotent
  on an already-`uploaded`/`downloading`/`downloaded` drop (return 200
  instead of 404) closes the real sender's "upload failed, and 409 on
  retry" failure mode too, without any protocol or schema change. This
  doesn't touch `DELETE` or slot-taking (still accepted, per above), but
  it's a real, low-cost fix for early-complete specifically — including
  for OWNED links, where the same unauthenticated-by-anything-but-drop-id
  `/complete` currently lets a legitimate sender charge the owner's
  quota for bytes that were never uploaded, without ever calling S3 at
  all. Worth doing as its own follow-up regardless of whether the
  manage-token redesign ever happens.

## 6. Links, contacts, and the "send to contact" flow

- **Contacts** are established via mutual request/accept between two
  registered accounts (like a friend request) — not a one-directional
  allowlist, so both sides are aware of and consent to the relationship.
- A `contacts-only` `Link` only accepts an upload from a sender who is
  authenticated *and* has `accepted` `Contact` status with the link
  owner. Anonymous (unauthenticated) senders are rejected on such links
  as a natural consequence of the check — no special-case logic needed.
- "Send to contact" in the UI requires no separate resolution mechanism:
  selecting a contact simply navigates to their default personal link
  (`/d/<contact-username>`), and the existing visibility check handles
  access control transparently.

### 6.1 Sender-facing recipient identity and optional message

Before uploading, the sender is shown who they are sending to, so they
can confirm they have the right recipient:

- **Owned links** (link has an `ownerId`): show the owner's `name` and
  `email`, each labeled with its trust level — `name` is always shown as
  "entered by the user, not verified" (it is free text the account
  holder chose, never checked against anything); `email` shows a
  verified/unverified badge driven by `User.emailVerified`. Neither
  claim is cryptographically tied to the recipient's public key — this
  is ordinary account metadata, not part of the E2EE trust model — but
  showing it helps a sender catch an obviously wrong link before they
  upload.
- **Anonymous links** (`ownerId` is null): there is no verified identity
  to show at all, so the UI displays a plain "Anonymous recipient"
  indicator instead of a name/email block. Inventing a placeholder name
  or email for an anonymous link would misrepresent a flow where nothing
  about the recipient has been checked.

Independent of recipient identity, the sender may attach a short,
**optional** plaintext comment to a `Drop` (`Drop.message`, capped at
~500 characters) — e.g. "here's the invoice we discussed." The upload UI
must display an explicit, unavoidable notice next to this field stating
that, unlike the file itself, **this message is not end-to-end
encrypted** and is readable by whoever operates the server/database. The
message is plain data in the `Drop` row, not part of the NaCl box
payload.

## 7. Live status updates

Recipients watching for an incoming upload get live status via
Server-Sent Events, not polling. Because the deployment target is a
single-instance Docker Compose stack (see §9), an in-process
`EventEmitter` in the `api` service is sufficient for broadcasting drop
status changes to open SSE connections — no Redis or other pub/sub layer
is needed unless a future multi-instance deployment is introduced (out
of scope here).

## 8. Storage

- MinIO (S3-compatible) replaces Backblaze B2. Files are uploaded and
  downloaded directly between the browser and MinIO via presigned
  PUT/GET URLs (10-minute expiry, matching the original), issued by the
  `api` service. The server never proxies file bytes.
- Bucket existence and CORS policy are ensured **idempotently at `api`
  startup** (check-then-create via the S3 SDK) rather than via a
  separate init container — one less moving part for operators to
  understand.
- `MAX_FILE_SIZE` is an env-configurable per-upload limit (a sane
  default, e.g. 2 GiB, to be finalized at plan/implementation time).
- Per-user storage quotas: `User.storageQuotaBytes` /
  `storageUsedBytes`, enforced when issuing an upload URL (reject if the
  new file would exceed the quota). Quota is env-configurable as a
  default for new accounts.

## 9. Deployment architecture

### 9.1 Monorepo layout (pnpm workspaces)

```
packages/
  db/       — Prisma schema + generated client, shared by api and the
              migrate/cleanup jobs
  shared/   — Shared TS types (API request/response contracts, crypto
              payload shapes) used by both web and api
apps/
  web/      — Vite + React + TS + shadcn/ui frontend
  api/      — Fastify backend
```

### 9.2 Docker Compose services

- **`web`** — nginx serving the static build output of `apps/web`, and
  reverse-proxying `/api/*` and the SSE endpoint to the `api` service.
  This keeps the browser talking to a single origin (no CORS needed
  between frontend and backend) while still letting `apps/web` and
  `apps/api` be built, deployed, and restarted independently — chosen
  over a single combined container because it maps cleanly onto the
  pnpm workspace split and keeps static-file-serving out of the API
  process, at the cost of one extra container and an nginx config to
  maintain.
- **`api`** — Fastify, handles all API routes, auth, presigned URL
  issuance, and SSE.
- **`postgres`** — official Postgres image, named volume for
  persistence.
- **`minio`** — official MinIO image, named volume for persistence.
- **`migrate`** — one-shot service, same image as `api`, runs
  `prisma migrate deploy` via a different `command`. `postgres` must be
  healthy first; `api` waits for `migrate` to complete successfully
  before starting, so the app never starts against an unmigrated
  schema.
- **`cleanup`** — long-running service, same image as `api`, different
  `command` (a small scheduler loop, e.g. `node-cron`) running the
  retention sweep (see §10) on an interval (e.g. every 15 minutes). Kept
  as its own service rather than an in-process interval inside `api` to
  separate request-handling from background-job concerns and keep it
  trivially safe if `api` is ever scaled to multiple replicas; kept as
  its own service rather than relying on host-level cron so that
  `docker compose up` alone is sufficient — no external scheduling setup
  required of operators.

No bundled reverse proxy/TLS termination is included — operators are
expected to place their own (Caddy, Traefik, nginx-proxy, etc.) in front
of the `web` service for TLS and domain routing, consistent with how
comparable self-hosted apps (Immich, Vaultwarden) are typically deployed.

### 9.3 Configuration

All operational configuration is via environment variables, documented
in `.env.example`: `DATABASE_URL`, `MINIO_ENDPOINT/KEY/SECRET/BUCKET`,
`SESSION_SECRET`, `APP_SECRET_KEY` (for encrypting TOTP secrets at
rest), `MAX_FILE_SIZE`, `DROP_RETENTION_DAYS` (default `7`),
`DEFAULT_STORAGE_QUOTA_BYTES`, `ALLOW_REGISTRATION` (default `true`),
`SMTP_HOST/PORT/USER/PASS/FROM`, `APP_URL`.

## 10. Retention and cleanup

- `DROP_RETENTION_DAYS` (default `7`) is the instance-wide default
  maximum age for a queued, undownloaded `Drop` before it is purged.
- `Link.retentionDays`, if set by the link's owner, overrides the global
  default for drops arriving on that specific link.
- One-time links (including anonymous ones) expire on the existing
  session-length basis, same as the original.
- The `cleanup` service sweeps on an interval and deletes: expired
  one-time links and their drop (if any), drops past their effective
  retention cutoff, and the corresponding MinIO objects — always
  deleting the MinIO object and the Postgres row together.
- Account deletion and password-reset-without-recovery-code (§3.3) both
  trigger an immediate cascade delete of the account's `Link`/`Drop`
  rows and MinIO objects, independent of the scheduled sweep.

## 11. Internationalization

`react-i18next` is retained, with Norwegian and English locales carried
over from the original (`src/locales/{en,nb}.json` equivalent), since
the app is intended to be shared/run by others beyond the original
author.

## 12. Testing approach

- **Crypto and key-wrapping logic** (Argon2id derivation, NaCl box
  encrypt/decrypt, local password wrapping): unit tests, since
  correctness here is security-critical and easy to verify in isolation.
- **API routes** (`apps/api`): integration tests against a real
  Postgres + MinIO (e.g. via `testcontainers` or the same Docker Compose
  stack in a test profile), covering the link/drop lifecycle, contact
  approval flow, quota enforcement, and retention/cascade-delete
  behavior.
- **Frontend**: component tests for the encryption/decryption hooks and
  key flows; a small number of end-to-end tests (e.g. Playwright)
  covering the full anonymous send/receive path and the account-based
  permanent-link path, since these cross client/server/storage
  boundaries where unit tests alone would miss integration bugs.
- Exact tooling choices (vitest vs. jest, testcontainers vs. compose
  test profile, whether Playwright is included in v1) are left to the
  implementation plan stage.

## 13. Explicit non-goals for this rewrite

- No multi-instance/horizontal scaling support (SSE broadcast and the
  cleanup job are both single-instance designs, §7 and §9.2).
- No bundled reverse proxy or TLS termination (§9.2).
- No OAuth/third-party login (email+password only, per design
  discussion).
- No true "lost recovery code and password" recovery — cascade delete is
  the explicit, intentional behavior in that case (§3.3).
