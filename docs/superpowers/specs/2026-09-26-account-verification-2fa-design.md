# Account verification and 2FA UI — design spec

Date: 2026-09-26
Status: draft, pending review

This is spec 3 of the 5-spec roadmap. Independent of specs 1 and 2 (send/receive flow, delivery
lifecycle) — no shared schema surface, can be implemented in parallel with either.

## 1. Purpose and scope

Two independent but adjacent pieces of account security, both largely backend-complete already:

- **Email verification**: `User.emailVerified` exists and is read in several places
  (`recipientEmailVerified` on link responses, session responses) but is **never set to `true`
  anywhere** — a dead field today. This spec wires up sending, confirming, and resending a
  verification email, plus a persistent reminder banner.
- **2FA UI**: `POST /api/auth/2fa/setup|enable|disable` are fully implemented and tested
  (`apps/api/src/routes/twoFactor.ts`) but `AccountPage.tsx` has zero references to 2FA — no UI
  entry point exists at all. This spec adds that UI, plus a genuinely new feature the backend
  doesn't have yet: TOTP backup codes.

Out of scope: this spec does not touch `showEmailOnPublicProfile` (spec 1) or the "unverified
users get anonymous-only functionality" gating rule (spec 4) — it only makes `emailVerified`
actually become `true`, which those other specs depend on.

## 2. Data model changes

### New: `EmailVerificationToken`

Mirrors `PasswordResetToken` (`packages/db/prisma/schema.prisma`) exactly, same
hash-and-compare-and-delete pattern already used throughout this codebase:

```prisma
model EmailVerificationToken {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([userId])
}
```

TTL constant `EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000` (24h — longer-lived than the
1h password-reset token, since a wrong/stale click here is lower-stakes than an account takeover
window).

### New: `TotpBackupCode`

```prisma
model TotpBackupCode {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  codeHash  String    @unique
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

One row per generated code. Ten rows are created together per generation batch (no `batchId`
column needed — generating a fresh batch simply deletes all of a user's existing unused rows and
inserts ten new ones in the same transaction).

## 3. Email verification

### 3.1 Sending

`sendVerificationEmail(to, verifyUrl)` added to `apps/api/src/lib/mailer.ts`, same shape as the
existing `sendPasswordResetEmail`. Called from `POST /api/auth/register` (`routes/auth.ts`) right
after the user row is created: generate a token, store its hash, send the email. Best-effort — an
SMTP failure is logged, not surfaced as a registration failure (matches this codebase's existing
tolerance for `isMailerConfigured()` being false in dev/self-hosted setups without SMTP).

### 3.2 Confirming

`POST /api/auth/verify-email/confirm` — body `{ token }`. Same claim discipline as
`claimResetTokenAndRevokeSessions` in `passwordReset.ts`: compare-and-delete the token row (a
concurrent double-submit can't double-consume it), then set `emailVerified: true`. No session
revocation needed here (unlike password reset) — verifying an email doesn't rotate any credential.

### 3.3 Resending

`POST /api/auth/verify-email/resend` — authenticated. New rate limiter,
`createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 3 })`, **keyed by the caller's user id**
(not IP — this is an authenticated action, unlike `passwordResetRequestRateLimiter`'s anti-
enumeration IP-keying, which doesn't apply here since the caller already knows their own email).
Invalidates any outstanding token for that user first (same "only the newest link works" pattern
password reset uses), then repeats §3.1's send.

### 3.4 Banner

Shown in `NavBar.tsx` (already global, already imports `useAuth`) whenever `user &&
!user.emailVerified` — **always visible**, no dismiss action, until the account is verified. A
"resend" button calls §3.3, disabled for the server's rate-limit window: the client tracks its own
last-sent timestamp (component state, not persisted — a reload resetting the client-side cooldown
display is harmless since the server still enforces the real limit) and shows a countdown before
re-enabling the button, so the common case doesn't waste an attempt on a request the server would
just 429.

## 4. 2FA UI

### 4.1 Setup flow (`AccountPage.tsx`, currently has no 2FA section at all)

1. "Enable 2FA" button → `POST /2fa/setup` → response has `secretBase32` + `otpauthUrl`.
2. Render `otpauthUrl` as a QR code (**`react-qr-code`** — chosen during spec 1's library review:
   MIT-licensed, released 3 months prior to that check vs. the more-adopted-but-2-years-stale
   `qrcode.react`) alongside the raw `secretBase32` as selectable text for manual entry.
3. 6-digit code input → `POST /2fa/enable` → on success, immediately proceed to §4.3 (backup code
   generation and one-time display) — enabling 2FA without ever seeing backup codes would leave
   the user with no recovery path the first time they lose their authenticator.

### 4.2 Replacing an authenticator

No new backend endpoint — `twoFactor.ts`'s existing `/disable` already requires a valid current
TOTP code before turning 2FA off, which is exactly the proof-of-possession replacement should
require. UI: a single "Replace authenticator" flow that chains disable (asks for current code) then
immediately re-runs §4.1's setup, so it reads as one action, not two unrelated buttons.

### 4.3 Backup codes

Ten codes generated per batch (confirmed), each 10 characters from a safe alphabet (excludes
`0/O/1/I/l` to avoid misreads), formatted as two groups of five for readability (e.g. `a3f9k-7h2mq`).
Server stores only `sha256(code)` per row (§2) — the plaintext exists only in the response body of
the generation call and is never retrievable again.

- **Generated**: automatically right after `/2fa/enable` succeeds (§4.1), and on-demand afterward
  via `POST /2fa/backup-codes/regenerate` (new endpoint) — requires a valid current TOTP code first
  (same rule as `/disable`), and atomically deletes all existing unused codes before inserting the
  new ten, so an old leaked batch can't be used alongside a fresh one.
- **Displayed once**: shown in a dedicated screen with a "these will not be shown again — save them
  now" warning (same reveal-once treatment as spec 1's message-reveal UI) and a "copy all" action;
  no way to view a previously generated batch again, only regenerate a new one.
- **Consumed at login**: `auth.ts`'s existing TOTP verification step
  (`routes/auth.ts:330-334`, the `verifyTotpCode` check inside the `requiresTotp` branch) is
  extended: if `verifyTotpCode` fails, check whether the submitted code matches an unused
  `TotpBackupCode.codeHash` for that user; if so, mark it used (`usedAt`) and allow login exactly as
  a valid TOTP code would. A backup code is single-use regardless of outcome elsewhere in the flow.
  Reuses the existing `twoFactorRateLimiter`/login rate limiting already guarding this path — no
  new limiter needed since backup-code guesses are exactly as sensitive as TOTP guesses and share
  the same attack surface.

## 5. API surface (new/changed)

| Endpoint | Change |
|---|---|
| `POST /api/auth/register` | Now sends a verification email (best-effort) |
| `POST /api/auth/verify-email/confirm` | **New** |
| `POST /api/auth/verify-email/resend` | **New**, rate-limited per user id |
| `POST /api/auth/2fa/backup-codes/regenerate` | **New**, requires current TOTP code |
| `POST /api/auth/login` | TOTP step also accepts an unused backup code |

`/2fa/setup` and `/2fa/enable` response/behavior unchanged; `/2fa/enable`'s success response
gains a `backupCodes: string[]` field (plaintext, one-time) so the client can go straight to the
reveal screen without a second round-trip.

## 6. Testing strategy

- Registration sends exactly one verification email when SMTP is configured; registration still
  succeeds when it isn't (`isMailerConfigured() === false`).
- Confirm: valid token sets `emailVerified: true` once; a replayed/already-consumed token fails;
  an expired token fails.
- Resend: rate limiter rejects a 4th call inside 15 minutes for the same user; a fresh resend
  invalidates the previously issued token (only the newest link works).
- Backup codes: exactly 10 generated per batch; regenerating invalidates all previously unused
  codes; a used code cannot be reused; login accepts a valid unused backup code and rejects an
  already-used one; regenerate is rejected without a valid current TOTP code.
- Banner: renders for `emailVerified === false`, absent otherwise, no dismiss control exists.
