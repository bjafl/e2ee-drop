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

- **User**: id, email, passwordHash (Argon2id), passwordSalt,
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
  fileSize, mimeType, contentMD5, status, createdAt, expiresAt.
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
