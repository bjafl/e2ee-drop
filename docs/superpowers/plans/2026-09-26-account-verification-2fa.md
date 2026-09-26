# Account Verification and 2FA UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the dead `User.emailVerified` field with a full send/confirm/resend email-verification flow, and build a UI on top of the already-complete 2FA backend, adding TOTP backup codes as a new account-recovery mechanism.

**Architecture:** Two independent vertical slices sharing no schema or runtime state. Email verification mirrors the existing password-reset token pattern exactly (`PasswordResetToken` → `EmailVerificationToken`, same hash-and-compare-and-delete discipline). 2FA UI is pure frontend work against three already-shipped, already-tested endpoints (`/2fa/setup|enable|disable`), plus one new small backend feature (backup codes) that extends the existing TOTP verification code path in `routes/auth.ts`'s login handler.

**Tech Stack:** Fastify + Prisma (API), React 19 + react-i18next + shadcn/Radix components (web), Vitest for both. New dependency: `react-qr-code` (frontend only).

**Spec:** `docs/superpowers/specs/2026-09-26-account-verification-2fa-design.md`

## Global Constraints

- `EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000` (24h).
- Verification-resend rate limit: 3 attempts per 15 minutes, keyed by authenticated user id (not IP).
- Backup codes: exactly 10 generated per batch, each 10 characters from the alphabet `23456789abcdefghjkmnpqrstuvwxyz` (digits 2-9 + lowercase a-z minus `i`, `l`, `o` — avoids visual confusion with `1`, `1`/`I`, `0`/`O`), displayed as two 5-character groups joined by a hyphen (e.g. `a3f9k-7h2mq`).
- Every new backend route follows this codebase's existing conventions: `HttpError`-free routes return `{ error: string }` bodies directly via `reply.status(N).send(...)`; rate-limit rejections use `rateLimitExceededBody()` from `lib/rateLimit.ts`; token hashing is `createHash("sha256").update(x).digest("hex")` (see `passwordReset.ts`'s `hashToken`).
- Never log or persist a plaintext token, code, or backup code anywhere other than the single response body that returns it once.
- No `--no-verify` on any commit.

## Review Focus

- **A user who registers with `ALLOW_REGISTRATION=false` bypassed** — not reachable, registration itself 403s first; no test needed, but don't add verification-email logic before that existing check.
- **SMTP not configured (self-hosted instance with no mailer)** — registration and resend must still return success-shaped responses (matching `PasswordResetRequestResponse`'s `emailDeliveryAvailable` pattern) rather than erroring, so a self-hosted operator without SMTP isn't blocked from using accounts at all.
- **Backup code reused after being marked used** — must be rejected on a second login attempt with the same code, not just "unlikely to happen."
- **Regenerating backup codes while old ones are still unused** — all old unused codes must become invalid immediately, not just uncounted; a stale saved copy of the old batch must stop working.
- **Concurrent double-submit of the same verification token** (two tabs, or a retried request) — must set `emailVerified` exactly once and not throw on the loser, mirroring `claimResetTokenAndRevokeSessions`'s compare-and-delete discipline.

---

## Task 1: Prisma schema — `EmailVerificationToken` and `TotpBackupCode`

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: migration via `pnpm --filter @e2ee-drop/db exec prisma migrate dev`

**Interfaces:**
- Produces: `prisma.emailVerificationToken` and `prisma.totpBackupCode` Prisma Client models, used by Tasks 4 and 7.

- [ ] **Step 1: Add the two models to `schema.prisma`**

Add after the existing `PasswordResetToken` model (`packages/db/prisma/schema.prisma`):

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

Add the two back-relations to `model User`, next to the existing `passwordResetTokens`:

```prisma
  emailVerificationTokens EmailVerificationToken[]
  totpBackupCodes         TotpBackupCode[]
```

- [ ] **Step 2: Generate and apply the migration**

Run: `cd packages/db && pnpm exec prisma migrate dev --name email_verification_and_backup_codes`
Expected: a new directory under `packages/db/prisma/migrations/` containing the `CREATE TABLE` statements for both models; command exits 0.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `pnpm --filter @e2ee-drop/db generate`
Expected: exits 0, no errors.

- [ ] **Step 4: Verify the API package still type-checks**

Run: `pnpm --filter @e2ee-drop/api exec tsc --noEmit`
Expected: exits 0 (no code references the new models yet, so this just confirms the schema change itself doesn't break existing types).

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): add EmailVerificationToken and TotpBackupCode models

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 2: Shared types

**Files:**
- Modify: `packages/shared/src/auth.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EmailVerificationResendResponse`, `TotpBackupCodesRegenerateResponse`, and an extended `TotpEnableRequest`/enable-response shape, all imported by Tasks 4-8 (API) and 9-11 (web).

- [ ] **Step 1: Add the email-verification response type**

Add to `packages/shared/src/auth.ts`, near the existing `PasswordResetRequestResponse`:

```ts
// Returned by both the registration side-effect (implicitly, via RegisterResponse
// being unchanged) and by /api/auth/verify-email/resend. Mirrors
// PasswordResetRequestResponse's emailDeliveryAvailable pattern: whether an email
// could actually be sent depends only on server SMTP configuration, never on
// anything about the specific account, so it's safe to expose unconditionally.
export interface EmailVerificationResendResponse {
  sent: true;
  emailDeliveryAvailable: boolean;
}
```

- [ ] **Step 2: Add the backup-codes regenerate response type, and extend the 2FA enable response**

Add:

```ts
// POST /api/auth/2fa/backup-codes/regenerate response, and also returned inline
// (as the `backupCodes` field) by /api/auth/2fa/enable's own success response,
// so enabling 2FA doesn't need a second round-trip to see the initial batch.
// Plaintext codes exist only in this one response body, never again.
export interface TotpBackupCodesResponse {
  backupCodes: string[]; // e.g. ["a3f9k-7h2mq", ...] — exactly 10 entries
}
```

Modify the existing `TotpEnableRequest`'s neighboring code — no changes to the request shape
itself, but note in a comment that the *response* to `/2fa/enable` (currently just
`{ enabled: true }` per `twoFactor.ts`) will gain the fields from `TotpBackupCodesResponse`
merged in (Task 7 handles this route-side; this task only adds the type most routes can share):

```ts
export interface TotpEnableResponse extends TotpBackupCodesResponse {
  enabled: true;
}
```

- [ ] **Step 3: Type-check the shared package**

Run: `pnpm --filter @e2ee-drop/shared exec tsc --noEmit`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/auth.ts
git commit -m "feat(shared): add types for email verification and 2FA backup codes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 3: `mailer.ts` — `sendVerificationEmail`

**Files:**
- Modify: `apps/api/src/lib/mailer.ts`
- Test: `apps/api/src/lib/mailer.test.ts` (create if it doesn't already exist; check first)

**Interfaces:**
- Consumes: `env.SMTP_FROM`, `isMailerConfigured()` (both already exist in this file).
- Produces: `sendVerificationEmail(to: string, verifyUrl: string): Promise<void>`, consumed by Task 5.

- [ ] **Step 1: Check for an existing mailer test file and its conventions**

Run: `cat apps/api/src/lib/mailer.test.ts 2>/dev/null || echo "no existing test file"`

If a file exists, follow its existing mocking pattern for `nodemailer.createTransport` exactly
(likely a `vi.mock("nodemailer", ...)` at the top). If none exists, use the pattern in Step 2 below.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/lib/mailer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMailMock = vi.fn().mockResolvedValue(undefined);
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock }) },
}));

describe("sendVerificationEmail", () => {
  beforeEach(() => {
    sendMailMock.mockClear();
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_FROM = "noreply@example.com";
  });

  it("sends an email containing the verify URL", async () => {
    const { sendVerificationEmail } = await import("./mailer");
    await sendVerificationEmail("alice@example.com", "https://app.example.com/verify-email/confirm?token=abc");

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe("alice@example.com");
    expect(call.text).toContain("https://app.example.com/verify-email/confirm?token=abc");
    expect(call.html).toContain("https://app.example.com/verify-email/confirm?token=abc");
  });

  it("throws if SMTP is not configured", async () => {
    delete process.env.SMTP_HOST;
    const { sendVerificationEmail } = await import("./mailer");
    await expect(sendVerificationEmail("alice@example.com", "https://x/y")).rejects.toThrow(
      "SMTP is not configured"
    );
  });
});
```

- [ ] **Step 2b: Run it to verify it fails**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/lib/mailer.test.ts`
Expected: FAIL — `sendVerificationEmail` is not exported.

- [ ] **Step 3: Implement `sendVerificationEmail`**

Add to `apps/api/src/lib/mailer.ts`, right after the existing `sendPasswordResetEmail`:

```ts
export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  if (!isMailerConfigured()) throw new Error("SMTP is not configured");
  const transport = getTransport();
  await transport.sendMail({
    to,
    from: env.SMTP_FROM,
    subject: "Verify your e2ee-drop email address",
    text: `Verify your email: ${verifyUrl}\n\nIf you did not create this account, ignore this email.`,
    html: `<p>Verify your email: <a href="${verifyUrl}">${verifyUrl}</a></p><p>If you did not create this account, ignore this email.</p>`,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/lib/mailer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/mailer.ts apps/api/src/lib/mailer.test.ts
git commit -m "feat(api): add sendVerificationEmail to mailer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 4: Rate limiter for verification resend

**Files:**
- Modify: `apps/api/src/lib/rateLimit.ts`

**Interfaces:**
- Consumes: `createRateLimiter` (already defined in this file).
- Produces: `emailVerificationResendRateLimiter: RateLimiter`, consumed by Task 6.

- [ ] **Step 1: Add the limiter**

Add to `apps/api/src/lib/rateLimit.ts`, after the existing `passwordResetTotpRateLimiter`:

```ts
// POST /api/auth/verify-email/resend, keyed by the authenticated caller's user id
// (not IP — unlike passwordResetRequestRateLimiter, this is an authenticated
// action and the caller already knows their own email, so there's no
// enumeration concern to key around). Each accepted call sends a real email
// when a mailer is configured; 3 per 15 minutes is enough for a legitimate
// "I didn't get it, resend" click or two without letting a bored user (or a
// stolen session) email-bomb an address.
export const emailVerificationResendRateLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 3 });
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @e2ee-drop/api exec tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/rateLimit.ts
git commit -m "feat(api): add rate limiter for verify-email resend

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 5: Register sends a verification email

**Files:**
- Modify: `apps/api/src/routes/auth.ts:212-228` (inside the registration transaction/handler)
- Test: `apps/api/src/routes/auth.test.ts` (check if it exists first; if not, create it)

**Interfaces:**
- Consumes: `sendVerificationEmail` (Task 3), `isMailerConfigured` (existing, `lib/mailer.ts`), `randomBytes`/`createHash` (`node:crypto`, already imported patterns elsewhere), `prisma.emailVerificationToken` (Task 1).
- Produces: nothing new consumed elsewhere — this is a leaf side effect.

- [ ] **Step 1: Check for an existing auth route test file**

Run: `ls apps/api/src/routes/auth.test.ts 2>/dev/null || echo "none"`

If one exists, add the test from Step 2 into it following its existing `describe` block and
`buildServer()`/`server.inject` conventions (see `twoFactor.test.ts` for the general shape). If
none exists, create a new minimal file as shown in Step 2.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/routes/auth.test.ts (add if creating fresh, or add this `it` block if the file exists)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

const sendVerificationEmailMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer")>();
  return { ...actual, sendVerificationEmail: sendVerificationEmailMock, isMailerConfigured: () => true };
});

describe("POST /api/auth/register — email verification", () => {
  beforeEach(async () => {
    sendVerificationEmailMock.mockClear();
    await prisma.emailVerificationToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("sends a verification email and stores a hashed token on successful registration", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "verify-me@example.com",
        username: "verifyme",
        name: "Verify Me",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
    const [to, url] = sendVerificationEmailMock.mock.calls[0];
    expect(to).toBe("verify-me@example.com");
    expect(url).toContain("/verify-email/confirm?token=");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "verify-me@example.com" } });
    expect(user.emailVerified).toBe(false);
    const tokenRow = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id } });
    expect(tokenRow).not.toBeNull();
  });

  it("still succeeds when the mailer send throws (best-effort)", async () => {
    sendVerificationEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "resilient@example.com",
        username: "resilient",
        name: "Resilient",
        authKey: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
      },
    });
    expect(response.statusCode).toBe(200);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/auth.test.ts`
Expected: FAIL — no verification email is sent yet (`sendVerificationEmailMock` called 0 times).

- [ ] **Step 4: Implement**

In `apps/api/src/routes/auth.ts`, add to the imports:

```ts
import { randomBytes, createHash } from "node:crypto";
import { isMailerConfigured, sendVerificationEmail } from "../lib/mailer";
```

Add a TTL constant near the top (next to `RESERVED_USERNAMES` etc.):

```ts
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

Modify the register handler: right after the `createSession` call (line ~255, before building
`RegisterResponse`), insert:

```ts
      // Best-effort: an SMTP failure must not fail registration itself — the
      // account already exists and is usable (just unverified), and the user
      // can always request a resend later (routes/verifyEmail.ts).
      const verificationToken = randomBytes(32).toString("base64url");
      await prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: hashVerificationToken(verificationToken),
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
        },
      });
      if (isMailerConfigured()) {
        try {
          await sendVerificationEmail(
            user.email,
            `${env.APP_URL}/verify-email/confirm?token=${verificationToken}`
          );
        } catch {
          // Logged by the caller's own error handling if it matters; never
          // block registration on a mail-send failure.
        }
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/auth.test.ts`
Expected: PASS (both new tests).

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `pnpm --filter @e2ee-drop/api test`
Expected: PASS. (If any pre-existing register test asserts an exact call count/shape unrelated to
this change and fails only because of the new side effect, that test's mock setup needs
`vi.mock("../lib/mailer", ...)` added the same way as Step 2 above — do not weaken the assertion.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(api): send verification email on registration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 6: `verifyEmail.ts` routes — confirm and resend

**Files:**
- Create: `apps/api/src/routes/verifyEmail.ts`
- Modify: `apps/api/src/server.ts` (register the new routes — check this file first for the exact
  pattern other route modules use, e.g. `registerPasswordResetRoutes(server)`)
- Test: `apps/api/src/routes/verifyEmail.test.ts`

**Interfaces:**
- Consumes: `emailVerificationResendRateLimiter` (Task 4), `sendVerificationEmail`/`isMailerConfigured` (Task 3), `hashVerificationToken`/`EMAIL_VERIFICATION_TOKEN_TTL_MS` — **move these two from `auth.ts` into this new file and export them**, importing back into `auth.ts`, so both routes share one definition instead of duplicating the hash function (see Step 1).
- Produces: `POST /api/auth/verify-email/confirm`, `POST /api/auth/verify-email/resend`.

- [ ] **Step 1: Move the token-hash helper and TTL constant out of `auth.ts`**

In `apps/api/src/routes/verifyEmail.ts` (new file), define and export:

```ts
// apps/api/src/routes/verifyEmail.ts
import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { EmailVerificationResendResponse } from "@e2ee-drop/shared";
import { isMailerConfigured, sendVerificationEmail } from "../lib/mailer";
import { emailVerificationResendRateLimiter, rateLimitExceededBody } from "../lib/rateLimit";
import { env } from "../env";

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function sendVerificationEmailFor(userId: string, email: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS) },
  });
  if (isMailerConfigured()) {
    await sendVerificationEmail(email, `${env.APP_URL}/verify-email/confirm?token=${token}`);
  }
}
```

In `apps/api/src/routes/auth.ts`: remove the `EMAIL_VERIFICATION_TOKEN_TTL_MS` constant and
`hashVerificationToken` function added in Task 5, remove the now-unused `randomBytes`/`createHash`
import (keep them only if `createHmac` from the same import line is still needed — check the
existing `createHmac` import at the top of the file, they're separate imports), remove the
`isMailerConfigured`/`sendVerificationEmail` import, and replace the inline block from Task 5
Step 4 with:

```ts
      // Best-effort: an SMTP failure must not fail registration itself.
      try {
        await sendVerificationEmailFor(user.id, user.email);
      } catch {
        // Never block registration on a mail-send failure.
      }
```

Add the import: `import { sendVerificationEmailFor } from "./verifyEmail";`

- [ ] **Step 2: Write the failing tests**

```ts
// apps/api/src/routes/verifyEmail.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { clearAllRateLimiters } from "../lib/rateLimit";

vi.mock("../lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer")>();
  return { ...actual, sendVerificationEmail: vi.fn().mockResolvedValue(undefined), isMailerConfigured: () => true };
});

async function registerAndGetCookie(server: ReturnType<typeof buildServer>, email: string, username: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email,
      username,
      name: "Test User",
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k",
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return { userId: response.json().userId, cookieValue: cookie.value };
}

describe("verify-email routes", () => {
  beforeEach(async () => {
    clearAllRateLimiters();
    await prisma.emailVerificationToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("confirms a valid token and sets emailVerified", async () => {
    const server = buildServer();
    await registerAndGetCookie(server, "confirm@example.com", "confirmuser");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "confirm@example.com" } });
    // Read the token back out via its hash isn't possible (one-way) — instead,
    // exercise the flow by minting our own token+row the same way the route does,
    // to keep this test independent of register's internal token generation.
    const { hashVerificationToken } = await import("./verifyEmail");
    const token = "test-token-value";
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() + 60_000) },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/verify-email/confirm",
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.emailVerified).toBe(true);
  });

  it("rejects an already-consumed token", async () => {
    const server = buildServer();
    await registerAndGetCookie(server, "reuse@example.com", "reuseuser");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "reuse@example.com" } });
    const { hashVerificationToken } = await import("./verifyEmail");
    const token = "reuse-token";
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() + 60_000) },
    });

    const first = await server.inject({ method: "POST", url: "/api/auth/verify-email/confirm", payload: { token } });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({ method: "POST", url: "/api/auth/verify-email/confirm", payload: { token } });
    expect(second.statusCode).toBe(400);
  });

  it("rejects an expired token", async () => {
    const server = buildServer();
    await registerAndGetCookie(server, "expired@example.com", "expireduser");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "expired@example.com" } });
    const { hashVerificationToken } = await import("./verifyEmail");
    const token = "expired-token";
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await server.inject({ method: "POST", url: "/api/auth/verify-email/confirm", payload: { token } });
    expect(response.statusCode).toBe(400);
  });

  it("resend requires authentication", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "POST", url: "/api/auth/verify-email/resend" });
    expect(response.statusCode).toBe(403);
  });

  it("resend invalidates the previous token and rate-limits after 3 calls in the window", async () => {
    const server = buildServer();
    const { cookieValue } = await registerAndGetCookie(server, "resend@example.com", "resenduser");
    const cookies = { e2ee_drop_session: cookieValue };

    const first = await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { emailDeliveryAvailable: boolean }).emailDeliveryAvailable).toBe(true);

    await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    const fourth = await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    expect(fourth.statusCode).toBe(429);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "resend@example.com" } });
    const tokenCount = await prisma.emailVerificationToken.count({ where: { userId: user.id } });
    expect(tokenCount).toBe(1); // registration's token + each resend's invalidate-then-create nets to 1
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/verifyEmail.test.ts`
Expected: FAIL — routes don't exist (connection refused / 404s).

- [ ] **Step 4: Implement the routes**

Append to `apps/api/src/routes/verifyEmail.ts`:

```ts
async function verifyEmailResendRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!emailVerificationResendRateLimiter.attempt(request.user!.id)) {
    reply.status(429).send(rateLimitExceededBody());
  }
}

export function registerVerifyEmailRoutes(server: FastifyInstance): void {
  server.post<{ Body: { token?: string } }>(
    "/api/auth/verify-email/confirm",
    { schema: { body: { type: "object", properties: { token: { type: "string" } } } } },
    async (request, reply) => {
      const token = request.body?.token;
      if (!token) return reply.status(400).send({ error: "Missing token" });

      const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashVerificationToken(token) } });
      if (!record || record.expiresAt.getTime() < Date.now()) {
        return reply.status(400).send({ error: "Invalid or expired token" });
      }

      // Compare-and-delete: only the request that actually removes the row may
      // proceed, so a concurrent double-submit can't both "succeed".
      const { count } = await prisma.emailVerificationToken.deleteMany({ where: { id: record.id } });
      if (count !== 1) return reply.status(400).send({ error: "Invalid or expired token" });

      await prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } });
      return reply.send({ verified: true });
    }
  );

  server.post(
    "/api/auth/verify-email/resend",
    { preHandler: [server.requireAuth, verifyEmailResendRateLimit] },
    async (request, reply) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
      // Invalidate any outstanding token first — only the newest emailed link works.
      await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
      await sendVerificationEmailFor(user.id, user.email);
      const body: EmailVerificationResendResponse = { sent: true, emailDeliveryAvailable: isMailerConfigured() };
      return reply.send(body);
    }
  );
}
```

- [ ] **Step 5: Register the routes in `server.ts`**

Read `apps/api/src/server.ts` first to find where `registerPasswordResetRoutes(server)` (or
equivalent) is called, and add `registerVerifyEmailRoutes(server)` alongside it, with the matching
import line.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/verifyEmail.test.ts src/routes/auth.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 7: Run the full API suite**

Run: `pnpm --filter @e2ee-drop/api test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/verifyEmail.ts apps/api/src/routes/verifyEmail.test.ts apps/api/src/routes/auth.ts apps/api/src/server.ts
git commit -m "feat(api): add verify-email confirm and resend routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 7: TOTP backup codes — generation, regeneration, and `/2fa/enable` response

**Files:**
- Create: `apps/api/src/lib/totpBackupCodes.ts`
- Modify: `apps/api/src/routes/twoFactor.ts`
- Test: `apps/api/src/lib/totpBackupCodes.test.ts`, additions to `apps/api/src/routes/twoFactor.test.ts`

**Interfaces:**
- Consumes: `prisma.totpBackupCode` (Task 1).
- Produces: `generateAndStoreBackupCodes(userId: string): Promise<string[]>`, consumed by Task 7's
  route changes and by Task 8 (login's backup-code check needs `consumeBackupCodeIfValid`, also
  defined here).

- [ ] **Step 1: Write the failing test for the generation helper**

```ts
// apps/api/src/lib/totpBackupCodes.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { generateAndStoreBackupCodes, consumeBackupCodeIfValid } from "./totpBackupCodes";

describe("totpBackupCodes", () => {
  let userId: string;

  beforeEach(async () => {
    await prisma.totpBackupCode.deleteMany();
    await prisma.session.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    const user = await prisma.user.create({
      data: {
        email: "backup@example.com",
        username: "backupuser",
        name: "Backup",
        passwordHash: "h",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
        storageQuotaBytes: 1000n,
      },
    });
    userId = user.id;
  });

  it("generates exactly 10 codes matching the expected format", async () => {
    const codes = await generateAndStoreBackupCodes(userId);
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[23456789a-hj-km-np-z]{5}-[23456789a-hj-km-np-z]{5}$/);
    }
    // No duplicates within a batch.
    expect(new Set(codes).size).toBe(10);
  });

  it("regenerating invalidates all previously unused codes", async () => {
    const firstBatch = await generateAndStoreBackupCodes(userId);
    const secondBatch = await generateAndStoreBackupCodes(userId);

    const firstStillValid = await consumeBackupCodeIfValid(userId, firstBatch[0]);
    expect(firstStillValid).toBe(false);

    const secondValid = await consumeBackupCodeIfValid(userId, secondBatch[0]);
    expect(secondValid).toBe(true);
  });

  it("a used code cannot be reused", async () => {
    const codes = await generateAndStoreBackupCodes(userId);
    const firstUse = await consumeBackupCodeIfValid(userId, codes[0]);
    expect(firstUse).toBe(true);
    const secondUse = await consumeBackupCodeIfValid(userId, codes[0]);
    expect(secondUse).toBe(false);
  });

  it("rejects a code that was never issued", async () => {
    await generateAndStoreBackupCodes(userId);
    const result = await consumeBackupCodeIfValid(userId, "zzzzz-zzzzz");
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/lib/totpBackupCodes.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/lib/totpBackupCodes.ts
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@e2ee-drop/db";

// Excludes 0, 1, i, l, o — all visually confusable with a digit or with each
// other in a hand-copied code. 31 characters.
const BACKUP_CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 10; // split into two groups of 5 for display
const CODES_PER_BATCH = 10;

function randomBackupCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Deletes every existing unused code for the user and inserts a fresh batch of
// CODES_PER_BATCH, in one transaction, so a caller never observes a state with
// both an old and a new batch simultaneously valid. Returns the plaintext
// codes — the only place they ever exist outside the caller's own memory.
export async function generateAndStoreBackupCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: CODES_PER_BATCH }, randomBackupCode);
  await prisma.$transaction([
    prisma.totpBackupCode.deleteMany({ where: { userId, usedAt: null } }),
    prisma.totpBackupCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashBackupCode(code) })),
    }),
  ]);
  return codes;
}

// Atomically consumes a backup code if it exists, belongs to this user, and is
// unused — compare-and-swap via updateMany's where clause (same discipline as
// transitionDropStatus in lib/links.ts), so two concurrent login attempts with
// the same code can't both succeed.
export async function consumeBackupCodeIfValid(userId: string, code: string): Promise<boolean> {
  const { count } = await prisma.totpBackupCode.updateMany({
    where: { userId, codeHash: hashBackupCode(code), usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/lib/totpBackupCodes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit the helper**

```bash
git add apps/api/src/lib/totpBackupCodes.ts apps/api/src/lib/totpBackupCodes.test.ts
git commit -m "feat(api): add TOTP backup code generation and consumption

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

- [ ] **Step 6: Write the failing test for `/2fa/enable`'s extended response and the new regenerate route**

Add to `apps/api/src/routes/twoFactor.test.ts` (following its existing `registerAndGetCookie`
helper and TOTP-code-generation pattern for a valid current code — read the existing "sets up,
enables..." test in that file for the exact `TOTP`/`Secret` usage to produce a valid 6-digit code):

```ts
it("returns 10 backup codes in the /2fa/enable response", async () => {
  const server = buildServer();
  const { userId, cookieValue } = await registerAndGetCookie(server);
  const cookies = { e2ee_drop_session: cookieValue };

  const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
  const { secretBase32 } = setupRes.json();
  const validCode = new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate();

  const enableRes = await server.inject({
    method: "POST",
    url: "/api/auth/2fa/enable",
    cookies,
    payload: { code: validCode },
  });

  expect(enableRes.statusCode).toBe(200);
  const body = enableRes.json();
  expect(body.backupCodes).toHaveLength(10);

  const count = await prisma.totpBackupCode.count({ where: { userId } });
  expect(count).toBe(10);
});

it("regenerate requires a valid current TOTP code and invalidates the old batch", async () => {
  const server = buildServer();
  const { userId, cookieValue } = await registerAndGetCookie(server);
  const cookies = { e2ee_drop_session: cookieValue };

  const setupRes = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
  const { secretBase32 } = setupRes.json();
  const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
  const enableRes = await server.inject({
    method: "POST",
    url: "/api/auth/2fa/enable",
    cookies,
    payload: { code: totp.generate() },
  });
  const firstBatch: string[] = enableRes.json().backupCodes;

  const rejected = await server.inject({
    method: "POST",
    url: "/api/auth/2fa/backup-codes/regenerate",
    cookies,
    payload: { code: "000000" },
  });
  expect(rejected.statusCode).toBe(401);

  const accepted = await server.inject({
    method: "POST",
    url: "/api/auth/2fa/backup-codes/regenerate",
    cookies,
    payload: { code: totp.generate() },
  });
  expect(accepted.statusCode).toBe(200);
  const secondBatch: string[] = accepted.json().backupCodes;
  expect(secondBatch).toHaveLength(10);
  expect(new Set([...firstBatch, ...secondBatch]).size).toBe(20);

  const count = await prisma.totpBackupCode.count({ where: { userId } });
  expect(count).toBe(10);
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/twoFactor.test.ts`
Expected: FAIL — no `backupCodes` field, no regenerate route.

- [ ] **Step 8: Implement in `twoFactor.ts`**

Add the import: `import { generateAndStoreBackupCodes } from "../lib/totpBackupCodes";`

In the `/2fa/enable` handler, replace the final `return reply.send({ enabled: true });` with:

```ts
      const backupCodes = await generateAndStoreBackupCodes(user.id);
      return reply.send({ enabled: true, backupCodes });
```

Add a new route, after `/2fa/disable`:

```ts
  server.post<{ Body: TotpEnableRequest }>(
    "/api/auth/2fa/backup-codes/regenerate",
    {
      preHandler: [server.requireAuth, twoFactorRateLimit],
      schema: { body: { type: ["object", "null"], properties: { code: { type: "string" } } } },
    },
    async (request, reply) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
      if (!user.totpEnabled || !user.totpSecretEncrypted) {
        return reply.status(400).send({ error: "2FA is not enabled" });
      }
      const code = request.body?.code;
      if (!code) return reply.status(401).send({ error: "TOTP code required" });
      const secret = decryptTotpSecret(user.totpSecretEncrypted);
      if (!verifyTotpCode(secret, code, getUsedCodesForUser(user.id))) {
        return reply.status(401).send({ error: "Invalid TOTP code" });
      }
      const backupCodes = await generateAndStoreBackupCodes(user.id);
      return reply.send({ backupCodes });
    }
  );
```

- [ ] **Step 9: Run to verify tests pass**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/twoFactor.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 10: Run the full API suite**

Run: `pnpm --filter @e2ee-drop/api test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/routes/twoFactor.ts apps/api/src/routes/twoFactor.test.ts
git commit -m "feat(api): return backup codes from 2fa/enable, add regenerate route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 8: Login accepts a backup code in place of a TOTP code

**Files:**
- Modify: `apps/api/src/routes/auth.ts:329-337` (the `requiresTotp` branch inside `/api/auth/login`)
- Test: `apps/api/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `consumeBackupCodeIfValid` (Task 7).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/auth.test.ts`:

```ts
it("accepts a valid unused backup code at login in place of a TOTP code", async () => {
  const server = buildServer();
  const { cookieValue } = await registerAndGetCookie(server);
  const setupRes = await server.inject({
    method: "POST",
    url: "/api/auth/2fa/setup",
    cookies: { e2ee_drop_session: cookieValue },
  });
  const { secretBase32 } = setupRes.json();
  const { TOTP, Secret } = await import("otpauth");
  const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
  const enableRes = await server.inject({
    method: "POST",
    url: "/api/auth/2fa/enable",
    cookies: { e2ee_drop_session: cookieValue },
    payload: { code: totp.generate() },
  });
  const [backupCode] = enableRes.json().backupCodes as string[];

  const loginRes = await server.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "erin@example.com", authKey: "p", totpCode: backupCode },
  });
  expect(loginRes.statusCode).toBe(200);

  // Reused — must now fail.
  const secondLoginRes = await server.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "erin@example.com", authKey: "p", totpCode: backupCode },
  });
  expect(secondLoginRes.statusCode).toBe(401);
});
```

Note: this test relies on `registerAndGetCookie`'s hardcoded `erin@example.com`/`authKey: "p"` from
`twoFactor.test.ts` — if `auth.test.ts` has its own differently-shaped helper, adapt the email/
authKey to match that file's own helper instead of introducing a second one.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/auth.test.ts`
Expected: FAIL — backup code rejected as an invalid TOTP code (401 on the *first* login attempt).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/auth.ts`, add the import:
`import { consumeBackupCodeIfValid } from "../lib/totpBackupCodes";`

Replace the existing block (lines ~329-337):

```ts
      if (user.totpEnabled) {
        if (!totpCode) {
          return reply.status(401).send({ error: "TOTP code required", requiresTotp: true });
        }
        const secret = decryptTotpSecret(user.totpSecretEncrypted!);
        if (!verifyTotpCode(secret, totpCode, getUsedCodesForUser(user.id))) {
          return reply.status(401).send({ error: "Invalid TOTP code" });
        }
      }
```

with:

```ts
      if (user.totpEnabled) {
        if (!totpCode) {
          return reply.status(401).send({ error: "TOTP code required", requiresTotp: true });
        }
        const secret = decryptTotpSecret(user.totpSecretEncrypted!);
        const totpValid = verifyTotpCode(secret, totpCode, getUsedCodesForUser(user.id));
        // A backup code is checked only when the TOTP check itself fails — a
        // real TOTP code must never accidentally match a backup code's format
        // and get treated as one, and this ordering guarantees that (backup
        // codes are hyphenated 10-char strings, TOTP codes are 6 digits, but
        // checking TOTP first costs nothing and removes any ambiguity).
        if (!totpValid && !(await consumeBackupCodeIfValid(user.id, totpCode))) {
          return reply.status(401).send({ error: "Invalid TOTP code" });
        }
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @e2ee-drop/api exec vitest run src/routes/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @e2ee-drop/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(api): accept a TOTP backup code at login

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 9: Verification banner in `NavBar.tsx`

**Files:**
- Modify: `apps/web/src/components/NavBar.tsx`
- Modify: `apps/web/src/locales/en/nav.json`, `apps/web/src/locales/nb/nav.json`
- Test: `apps/web/src/components/NavBar.test.tsx` (check if it exists; create if not)

**Interfaces:**
- Consumes: `useAuth()`'s `user.emailVerified` (already exposed on `AuthUser`, no change needed).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/NavBar.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NavBar } from "./NavBar";
import * as useAuthModule from "@/hooks/useAuth";

vi.mock("@/hooks/useAuth");

function mockUser(overrides: Partial<{ emailVerified: boolean }> = {}) {
  vi.mocked(useAuthModule.useAuth).mockReturnValue({
    user: {
      id: "u1",
      username: "erin",
      name: "Erin",
      email: "erin@example.com",
      emailVerified: true,
      publicKey: "k",
      totpEnabled: false,
      keyPair: null,
      ...overrides,
    },
    loading: false,
    logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuthModule.useAuth>);
}

describe("NavBar email verification banner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sent: true, emailDeliveryAvailable: true }) });
  });

  it("shows no banner when the user is verified", () => {
    mockUser({ emailVerified: true });
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    expect(screen.queryByTestId("verify-email-banner")).toBeNull();
  });

  it("shows a persistent banner with a resend button when unverified", () => {
    mockUser({ emailVerified: false });
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    expect(screen.getByTestId("verify-email-banner")).toBeInTheDocument();
  });

  it("resend calls the API and starts a cooldown", async () => {
    mockUser({ emailVerified: false });
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    const button = screen.getByTestId("resend-verification-button");
    fireEvent.click(button);
    expect(global.fetch).toHaveBeenCalledWith("/api/auth/verify-email/resend", { method: "POST" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @e2ee-drop/web exec vitest run src/components/NavBar.test.tsx`
Expected: FAIL — `data-testid="verify-email-banner"` doesn't exist.

- [ ] **Step 3: Add locale strings**

`apps/web/src/locales/en/nav.json` — add:
```json
{
  "verifyEmailBanner": "Please verify your email address to unlock full account features.",
  "resendVerification": "Resend verification email",
  "resendVerificationCooldown": "Resend available in {{seconds}}s"
}
```

`apps/web/src/locales/nb/nav.json` — add:
```json
{
  "verifyEmailBanner": "Vennligst bekreft e-postadressen din for å låse opp full kontofunksjonalitet.",
  "resendVerification": "Send bekreftelses-e-post på nytt",
  "resendVerificationCooldown": "Send på nytt om {{seconds}}s"
}
```

- [ ] **Step 4: Implement**

Modify `apps/web/src/components/NavBar.tsx` — add state and a banner, keeping the existing `<nav>`
markup unchanged and wrapping the return value in a fragment:

```tsx
import { useState } from "react";
// ...existing imports...

const RESEND_COOLDOWN_SECONDS = 60; // client-side display only; server enforces the real 15min/3 limit

export function NavBar() {
  const { t } = useTranslation("nav");
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!cooldownUntil) return;
    const interval = setInterval(() => {
      const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        setCooldownUntil(null);
        setSecondsLeft(0);
        clearInterval(interval);
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownUntil]);

  const handleResend = async () => {
    setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
    setSecondsLeft(RESEND_COOLDOWN_SECONDS);
    await fetch("/api/auth/verify-email/resend", { method: "POST" });
  };

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  return (
    <>
      <nav className="flex items-center justify-between border-b px-4 py-2">
        {/* ...existing unchanged nav content... */}
      </nav>
      {user && !user.emailVerified && (
        <div data-testid="verify-email-banner" className="flex items-center justify-between gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span>{t("verifyEmailBanner")}</span>
          <Button
            data-testid="resend-verification-button"
            size="sm"
            variant="outline"
            disabled={cooldownUntil !== null}
            onClick={handleResend}
          >
            {cooldownUntil !== null ? t("resendVerificationCooldown", { seconds: secondsLeft }) : t("resendVerification")}
          </Button>
        </div>
      )}
    </>
  );
}
```

Add `import { useEffect } from "react";` to the existing React import line.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @e2ee-drop/web exec vitest run src/components/NavBar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/NavBar.tsx apps/web/src/components/NavBar.test.tsx apps/web/src/locales/en/nav.json apps/web/src/locales/nb/nav.json
git commit -m "feat(web): add persistent email-verification reminder banner

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 10: `VerifyEmailPage.tsx` (confirm-link landing page)

**Files:**
- Create: `apps/web/src/components/VerifyEmailPage.tsx`
- Create: `apps/web/src/locales/en/verifyEmail.json`, `apps/web/src/locales/nb/verifyEmail.json`
- Modify: `apps/web/src/App.tsx` (add the route)
- Test: `apps/web/src/components/VerifyEmailPage.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier frontend tasks.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/VerifyEmailPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { VerifyEmailPage } from "./VerifyEmailPage";

describe("VerifyEmailPage", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/verify-email/confirm" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("shows success on a valid token", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
    renderAt("/verify-email/confirm?token=abc123");
    await waitFor(() => expect(screen.getByText(/verified/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith("/api/auth/verify-email/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "abc123" }),
    });
  });

  it("shows an error on an invalid token", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false } as Response);
    renderAt("/verify-email/confirm?token=bad");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @e2ee-drop/web exec vitest run src/components/VerifyEmailPage.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Add locale files**

`apps/web/src/locales/en/verifyEmail.json`:
```json
{ "verifying": "Verifying your email…", "success": "Your email has been verified.", "errors": { "invalidToken": "This verification link is invalid or has expired." } }
```

`apps/web/src/locales/nb/verifyEmail.json`:
```json
{ "verifying": "Bekrefter e-posten din…", "success": "E-posten din er bekreftet.", "errors": { "invalidToken": "Denne bekreftelseslenken er ugyldig eller utløpt." } }
```

- [ ] **Step 4: Implement**

```tsx
// apps/web/src/components/VerifyEmailPage.tsx
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import verifyEmailEn from "@/locales/en/verifyEmail.json";
import verifyEmailNb from "@/locales/nb/verifyEmail.json";

i18n.addResourceBundle("en", "verifyEmail", verifyEmailEn, true, false);
i18n.addResourceBundle("nb", "verifyEmail", verifyEmailNb, true, false);

export function VerifyEmailPage() {
  const { t } = useTranslation("verifyEmail");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/verify-email/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (!cancelled) setStatus(res.ok ? "success" : "error");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "pending") return <p>{t("verifying")}</p>;
  if (status === "error") return <p role="alert">{t("errors.invalidToken")}</p>;
  return <p>{t("success")}</p>;
}
```

Add to `apps/web/src/App.tsx`: import `VerifyEmailPage`, and add
`<Route path="/verify-email/confirm" element={<VerifyEmailPage />} />` alongside the existing
`/reset-password/confirm` route.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @e2ee-drop/web exec vitest run src/components/VerifyEmailPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/VerifyEmailPage.tsx apps/web/src/components/VerifyEmailPage.test.tsx apps/web/src/locales/en/verifyEmail.json apps/web/src/locales/nb/verifyEmail.json apps/web/src/App.tsx
git commit -m "feat(web): add email verification confirm-link landing page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 11: Add `react-qr-code` dependency

**Files:**
- Modify: `apps/web/package.json`

**Interfaces:**
- Produces: the `react-qr-code` default export, consumed by Task 12.

- [ ] **Step 1: Install**

Run: `pnpm --filter @e2ee-drop/web add react-qr-code`
Expected: exits 0, `apps/web/package.json` gains the dependency, lockfile updates.

- [ ] **Step 2: Verify it imports cleanly**

Run: `pnpm --filter @e2ee-drop/web exec tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add react-qr-code dependency for 2FA setup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 12: 2FA UI in `AccountPage.tsx`

**Files:**
- Modify: `apps/web/src/components/AccountPage.tsx`
- Modify: `apps/web/src/locales/en/account.json`, `apps/web/src/locales/nb/account.json`
- Test: `apps/web/src/components/AccountPage.test.tsx` (check if it exists; add to it or create)

**Interfaces:**
- Consumes: `react-qr-code` (Task 11), `POST /2fa/setup|enable|disable|backup-codes/regenerate`
  (existing + Task 7), `user.totpEnabled` (existing on `AuthUser`).
- Produces: nothing consumed elsewhere — this is the final UI leaf.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/AccountPage.test.tsx additions (or new file — check for an existing one first)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AccountPage } from "./AccountPage";
import * as useAuthModule from "@/hooks/useAuth";

vi.mock("@/hooks/useAuth");

function mockUser(totpEnabled: boolean) {
  vi.mocked(useAuthModule.useAuth).mockReturnValue({
    user: { id: "u1", username: "erin", name: "Erin", email: "erin@example.com", emailVerified: true, publicKey: "k", totpEnabled, keyPair: null },
    loading: false,
    logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuthModule.useAuth>);
}

describe("AccountPage 2FA section", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an Enable 2FA button when 2FA is off", () => {
    mockUser(false);
    render(<MemoryRouter><AccountPage /></MemoryRouter>);
    expect(screen.getByTestId("enable-2fa-button")).toBeInTheDocument();
  });

  it("setup shows a QR code and the raw secret, then reveals backup codes once enabled", async () => {
    mockUser(false);
    global.fetch = vi.fn((url: string) => {
      if (url === "/api/auth/2fa/setup") {
        return Promise.resolve({ ok: true, json: async () => ({ secretBase32: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x" }) } as Response);
      }
      if (url === "/api/auth/2fa/enable") {
        return Promise.resolve({ ok: true, json: async () => ({ enabled: true, backupCodes: ["aaaaa-bbbbb"] }) } as Response);
      }
      return Promise.reject(new Error("unexpected url " + url));
    }) as unknown as typeof fetch;

    render(<MemoryRouter><AccountPage /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("enable-2fa-button"));
    await waitFor(() => expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("totp-code-input"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("confirm-2fa-code-button"));

    await waitFor(() => expect(screen.getByText("aaaaa-bbbbb")).toBeInTheDocument());
    expect(screen.getByTestId("backup-codes-warning")).toBeInTheDocument();
  });

  it("shows Replace and Disable actions when 2FA is on", () => {
    mockUser(true);
    render(<MemoryRouter><AccountPage /></MemoryRouter>);
    expect(screen.getByTestId("replace-2fa-button")).toBeInTheDocument();
    expect(screen.getByTestId("disable-2fa-button")).toBeInTheDocument();
    expect(screen.getByTestId("regenerate-backup-codes-button")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @e2ee-drop/web exec vitest run src/components/AccountPage.test.tsx`
Expected: FAIL — none of the new `data-testid`s exist.

- [ ] **Step 3: Add locale strings**

`apps/web/src/locales/en/account.json` — add:
```json
{
  "twoFactor": {
    "heading": "Two-factor authentication",
    "enable": "Enable 2FA",
    "replace": "Replace authenticator",
    "disable": "Disable 2FA",
    "regenerateBackupCodes": "Generate new backup codes",
    "scanQr": "Scan this QR code with your authenticator app, or enter the code manually:",
    "codeLabel": "Enter the 6-digit code from your app",
    "confirm": "Confirm",
    "currentCodeLabel": "Enter your current 6-digit code to continue",
    "backupCodesWarning": "Save these codes now — they will not be shown again. Each can be used once to log in if you lose access to your authenticator.",
    "backupCodesCopy": "Copy all",
    "backupCodesDone": "I've saved these codes"
  }
}
```

`apps/web/src/locales/nb/account.json` — add:
```json
{
  "twoFactor": {
    "heading": "Tofaktorautentisering",
    "enable": "Aktiver 2FA",
    "replace": "Erstatt autentisering",
    "disable": "Deaktiver 2FA",
    "regenerateBackupCodes": "Generer nye backup-koder",
    "scanQr": "Skann denne QR-koden med autentiseringsappen din, eller skriv inn koden manuelt:",
    "codeLabel": "Skriv inn 6-sifret kode fra appen",
    "confirm": "Bekreft",
    "currentCodeLabel": "Skriv inn din nåværende 6-sifrede kode for å fortsette",
    "backupCodesWarning": "Lagre disse kodene nå — de vises ikke igjen. Hver kan brukes én gang for å logge inn hvis du mister tilgang til autentiseringsappen.",
    "backupCodesCopy": "Kopier alle",
    "backupCodesDone": "Jeg har lagret disse kodene"
  }
}
```

- [ ] **Step 4: Implement**

Rewrite `apps/web/src/components/AccountPage.tsx`, adding a 2FA section as a sibling to the
existing "danger zone" `<div>`, inside the same `<CardContent>`:

```tsx
// apps/web/src/components/AccountPage.tsx
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import QRCode from "react-qr-code";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DeleteAccountDialog } from "@/components/DeleteAccountDialog";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import accountEn from "@/locales/en/account.json";
import accountNb from "@/locales/nb/account.json";

i18n.addResourceBundle("en", "account", accountEn, true, false);
i18n.addResourceBundle("nb", "account", accountNb, true, false);

// One flow handles both "enable from scratch" and "replace" (disable-then-
// setup chained as one user-facing action, per the design spec) — "replace"
// just starts at the disable step instead of directly at setup.
type TwoFactorFlow =
  | { step: "idle" }
  | { step: "disabling-for-replace" }
  | { step: "setup"; secretBase32: string; otpauthUrl: string }
  | { step: "confirming"; secretBase32: string; otpauthUrl: string }
  | { step: "backup-codes"; codes: string[] }
  | { step: "disabling" }
  | { step: "regenerating" };

export function AccountPage() {
  const { t } = useTranslation("account");
  const { user, loading, logout } = useAuth();
  const [deleted, setDeleted] = useState(false);
  const [flow, setFlow] = useState<TwoFactorFlow>({ step: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (deleted) return <Navigate to="/" replace />;
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  const handleDeleted = () => {
    setDeleted(true);
    void logout().catch(() => undefined);
  };

  const startSetup = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/setup", { method: "POST" });
    if (!res.ok) return setError(t("twoFactor.currentCodeLabel"));
    const { secretBase32, otpauthUrl } = await res.json();
    setFlow({ step: "setup", secretBase32, otpauthUrl });
  };

  const confirmEnable = async () => {
    setError(null);
    if (flow.step !== "setup" && flow.step !== "confirming") return;
    const res = await fetch("/api/auth/2fa/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      setFlow({ step: "confirming", secretBase32: flow.secretBase32, otpauthUrl: flow.otpauthUrl });
      return setError("invalid code");
    }
    const { backupCodes } = await res.json();
    setCode("");
    setFlow({ step: "backup-codes", codes: backupCodes });
  };

  const startReplace = () => setFlow({ step: "disabling-for-replace" });

  const confirmDisableForReplace = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setCode("");
    if (!res.ok) return setError("invalid code");
    await startSetup();
  };

  const startDisable = () => setFlow({ step: "disabling" });

  const confirmDisable = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setCode("");
    if (!res.ok) return setError("invalid code");
    setFlow({ step: "idle" });
  };

  const startRegenerate = () => setFlow({ step: "regenerating" });

  const confirmRegenerate = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/backup-codes/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setCode("");
    if (!res.ok) return setError("invalid code");
    const { backupCodes } = await res.json();
    setFlow({ step: "backup-codes", codes: backupCodes });
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <p>{t("signedInAs", { username: user.username })}</p>
          <p className="text-sm text-muted-foreground">{t("email", { email: user.email })}</p>
        </div>

        <div className="space-y-3 border-t pt-4">
          <h2 className="font-semibold">{t("twoFactor.heading")}</h2>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {flow.step === "idle" && !user.totpEnabled && (
            <Button data-testid="enable-2fa-button" onClick={startSetup}>
              {t("twoFactor.enable")}
            </Button>
          )}

          {flow.step === "idle" && user.totpEnabled && (
            <div className="flex flex-wrap gap-2">
              <Button data-testid="replace-2fa-button" variant="outline" onClick={startReplace}>
                {t("twoFactor.replace")}
              </Button>
              <Button data-testid="disable-2fa-button" variant="destructive" onClick={startDisable}>
                {t("twoFactor.disable")}
              </Button>
              <Button data-testid="regenerate-backup-codes-button" variant="outline" onClick={startRegenerate}>
                {t("twoFactor.regenerateBackupCodes")}
              </Button>
            </div>
          )}

          {(flow.step === "setup" || flow.step === "confirming") && (
            <div className="space-y-3">
              <p>{t("twoFactor.scanQr")}</p>
              <div className="w-40 bg-white p-2">
                <QRCode value={flow.otpauthUrl} size={144} />
              </div>
              <p className="break-all font-mono text-sm">{flow.secretBase32}</p>
              <label htmlFor="totp-confirm-code">{t("twoFactor.codeLabel")}</label>
              <input
                id="totp-confirm-code"
                data-testid="totp-code-input"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded border p-2"
              />
              <Button data-testid="confirm-2fa-code-button" onClick={confirmEnable}>
                {t("twoFactor.confirm")}
              </Button>
            </div>
          )}

          {(flow.step === "disabling" || flow.step === "disabling-for-replace" || flow.step === "regenerating") && (
            <div className="space-y-3">
              <label htmlFor="totp-action-code">{t("twoFactor.currentCodeLabel")}</label>
              <input
                id="totp-action-code"
                data-testid="totp-action-code-input"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded border p-2"
              />
              <Button
                data-testid="confirm-totp-action-button"
                onClick={
                  flow.step === "disabling-for-replace"
                    ? confirmDisableForReplace
                    : flow.step === "disabling"
                      ? confirmDisable
                      : confirmRegenerate
                }
              >
                {t("twoFactor.confirm")}
              </Button>
            </div>
          )}

          {flow.step === "backup-codes" && (
            <div className="space-y-3">
              <Alert variant="destructive" data-testid="backup-codes-warning">
                <AlertDescription>{t("twoFactor.backupCodesWarning")}</AlertDescription>
              </Alert>
              <pre className="rounded bg-muted p-2 font-mono text-sm">{flow.codes.join("\n")}</pre>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => navigator.clipboard.writeText(flow.codes.join("\n"))}>
                  {t("twoFactor.backupCodesCopy")}
                </Button>
                <Button onClick={() => setFlow({ step: "idle" })}>{t("twoFactor.backupCodesDone")}</Button>
              </div>
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 font-semibold">{t("dangerZone")}</h2>
          <DeleteAccountDialog onDeleted={handleDeleted} />
        </div>
      </CardContent>
    </Card>
  );
}
```

Note: `user.totpEnabled` is read once at render time from `useAuth()`'s cached user object, which
is not refetched after enable/disable in this task — if `useAuth` doesn't already expose a
`refresh()`/re-fetch of `/api/auth/me`, `flow.step === "idle"` after a successful disable will
still show the "enabled" buttons until the next full reload. Check `useAuth.tsx` for an existing
refresh mechanism first; if none exists, this is an acceptable known gap for this plan (flagged
here rather than silently shipped) — the 2FA state is still correct server-side and on next login/
reload, just not reflected instantly in this one page without a manual refresh call.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @e2ee-drop/web exec vitest run src/components/AccountPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full web suite**

Run: `pnpm --filter @e2ee-drop/web test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/AccountPage.tsx apps/web/src/components/AccountPage.test.tsx apps/web/src/locales/en/account.json apps/web/src/locales/nb/account.json
git commit -m "feat(web): add 2FA setup, replace, disable, and backup codes UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013TrBA4LWezGFNZSfuU6ufW"
```

---

## Task 13: Full-suite check

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: PASS, all packages.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Type-check everything**

Run: `pnpm -r exec tsc --noEmit`
Expected: PASS.

No commit for this task — it's a verification checkpoint, not a code change.

---

## Self-review notes (from the agent that wrote this plan)

**Judgment calls made in place of asking the human partner:**

1. **2FA state not live-refreshed in `AccountPage.tsx` after enable/disable** (Task 12, Step 4's
   closing note) — `user.totpEnabled` comes from `useAuth()`'s cached state. If `useAuth.tsx` has
   no refresh mechanism, the UI will show stale enabled/disabled buttons until a reload. Flagged
   explicitly rather than silently building a new refresh mechanism the spec never asked for —
   worth a look before implementation starts.
2. **`hashVerificationToken`/`sendVerificationEmailFor` were placed in the new `verifyEmail.ts`
   file rather than a separate `lib/` module** (Task 6) — mirrors this codebase's existing pattern
   where each auth-adjacent route file defines its own local hash helper (`passwordReset.ts`'s
   `hashToken`) rather than sharing one crypto-utility module across routes. Consistent, but
   Task 5 temporarily adds the same logic inline in `auth.ts` before Task 6 moves it out — this is
   intentional (keeps Task 5 independently testable and committable before Task 6 exists) but
   means a reviewer reading Task 5's diff in isolation will see code that gets deleted two tasks
   later. Called out here so it doesn't read as a mistake.
3. **Backup code alphabet excludes `i`, `l`, `o` (lowercase) in addition to the spec's literal
   `0/O/1/I/l`** — the spec's exclusion list was written assuming mixed case, but codes are
   generated lowercase-only (per the spec's own example `a3f9k-7h2mq`), so I also excluded
   lowercase `o` for the same misread-prevention reason the spec gives for `O`. A minor extension
   of the stated rule, not a contradiction of it.
4. **`AccountPage.test.tsx` and `NavBar.test.tsx` are written as "create if it doesn't exist, add
   to it if it does"** (Tasks 9, 12) — I couldn't determine from the spec alone whether these test
   files already exist with content this plan's tests would need to coexist with; the plan tells
   the implementer to check first rather than assuming either way.

**Spec coverage check:** every numbered section of the design spec (§3.1-3.4 email verification,
§4.1-4.3 2FA UI, §5 API surface, §6 testing strategy) maps to at least one task above. No spec
requirement was left without an owning task.
