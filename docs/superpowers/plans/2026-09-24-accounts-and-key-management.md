# Accounts and Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are grouped into **Waves**; all tasks within a wave are mutually independent given the outputs of earlier waves and MAY be dispatched to parallel subagents. Do not start a task before every task in an earlier wave it depends on (see each task's **Interfaces: Consumes**) has been completed and reviewed.

**Goal:** Add registration, login, password-derived private-key wrapping with recovery-code reset, TOTP 2FA, DB-backed sessions, SMTP-based password-reset email, and each account's auto-created default personal link, on top of the infra + anonymous flow built in Plan 1. The anonymous no-login flow is untouched.

**Architecture:** Client-side Argon2id (via `hash-wasm`, WASM — no native build step, keeps the `node:20-slim` Docker image simple) derives a symmetric key from the account password; that key wraps/unwraps the NaCl private key with `nacl.secretbox` entirely in the browser. The server only ever stores wrapped blobs, a separate login password hash, and a salt — it never sees a plaintext password, a plaintext private key, or the wrapping key. Sessions are Postgres-backed, referenced by a signed httpOnly cookie, so they can be revoked server-side (e.g. after a password reset).

**Tech Stack:** `hash-wasm` (Argon2id, client and server — WASM, no native compile step in either the browser or the `node:20-slim` API image), `tweetnacl` (`nacl.secretbox` for key wrapping, already a dependency from Plan 1), `@fastify/cookie` + `@fastify/session`-style hand-rolled DB session lookup (kept manual — see Task 7 — rather than an external session-store plugin, so the revoke-on-password-reset requirement in Task 11 is a plain Prisma delete), `otpauth` (TOTP generation/verification, RFC 6238), `nodemailer` (SMTP).

**Spec:** `docs/superpowers/specs/2026-09-24-e2ee-drop-rewrite-design.md`

## Global Constraints

- Backend is Node.js + Fastify + Prisma; frontend is Vite + React + TypeScript + shadcn/ui (spec §9.1) — unchanged from Plan 1.
- The private key is wrapped client-side with a password-derived Argon2id key; the server never receives a plaintext password or plaintext private key (spec §3.1).
- A second, independent wrapped copy of the private key is produced with a high-entropy recovery code at registration, shown to the user once (spec §3.2).
- Password reset has exactly two paths: with a working recovery code (unwrap → re-wrap, no data loss) or without one (cascade delete via `cascadeDeleteUserLinks`, then a fresh keypair) — spec §3.3.
- 2FA (TOTP) is a pure login gate and is never mixed into the key-wrapping KDF (spec §3.4). TOTP secrets are stored encrypted at rest using a server-side `APP_SECRET_KEY`.
- Sessions are DB-backed (a `Session` table), referenced by a signed httpOnly `SameSite` cookie, specifically so they can be revoked server-side — e.g. forcing re-login everywhere after a password reset (spec §4).
- `ALLOW_REGISTRATION` env var (default `true`) gates the registration route (spec §4, §9.3).
- SMTP is configured via `SMTP_HOST/PORT/USER/PASS/FROM`; when unset, password-reset-by-email is unavailable and the UI must say so, not silently fail (spec §4).
- Every registered user gets one non-deletable default `Link` (`isDefault = true`, `slug = <username>`, `mode = "permanent"`) created at registration; only its `visibility` can change (spec §5).
- Account deletion and password-reset-without-recovery-code both cascade-delete all of the user's `Link`/`Drop` rows and MinIO objects (spec §3.3, §10) — this plan builds `cascadeDeleteUserLinks`, used by its own reset-without-recovery path; full account *deletion* itself is Plan 4's job, reusing this same function.
- `Drop.message` handling and the anonymous "Anonymous recipient" UI indicator (spec §6.1) are already built in Plan 1 and are not touched here — Plan 3 later extends the recipient-identity block to show `name`/`emailVerified` for owned links.

## Review Focus

- A session cookie issued before a password reset must stop working immediately after that reset completes (all of that user's sessions revoked), not just for the browser that performed the reset — covered in Task 11.
- Unwrapping the private key with the wrong password (wrong Argon2id-derived key against `nacl.secretbox.open`) must fail cleanly and detectably (return `null`/throw), never silently return corrupted bytes — covered in Task 4.
- Registering with an email or username that's already taken must return 409, not a generic 500 from a unique-constraint violation reaching the client — covered in Task 9.
- A TOTP code that is correct but already used in the current 30-second window (replay) must be rejected on a second submission — covered end-to-end at the login route in Task 10; a code from outside the ±1-step tolerance window must be rejected at the library level — covered in Task 3.
- The recovery-code reset path must leave existing `Link`/`Drop` rows and their MinIO objects completely untouched (only `User` credentials change), while the no-recovery-code path must actually delete them — both branches need explicit assertions, not just "the request returned 200" — covered in Task 11.

---

## Wave 0 — Schema (sequential, must land before any other task starts)

### Task 1: Extend Prisma schema with User, Session, Contact, PasswordResetToken

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Test: `packages/db/src/index.test.ts`

**Interfaces:**
- Consumes: the existing `Link`/`Drop` models from Plan 1 (`packages/db/prisma/schema.prisma`).
- Produces: Prisma-generated types `User`, `Session`, `Contact`, `PasswordResetToken` importable from `@e2ee-drop/db`, plus a proper `@relation` from `Link.ownerId` → `User.id` and `Drop.senderUserId` → `User.id` (both stay nullable — anonymous links/drops still have no owner/sender user). Consumed by every other task in this plan.

- [ ] **Step 1: Modify `packages/db/prisma/schema.prisma`** — replace the existing `Link` and `Drop` models' plain `ownerId`/`senderUserId` fields with relations, and add the four new models (keep everything else in the file unchanged):

```prisma
model User {
  id                        String    @id @default(cuid())
  email                     String    @unique
  emailVerified             Boolean   @default(false)
  username                  String    @unique
  name                      String
  passwordHash              String
  passwordSalt              String
  passwordWrappedPrivateKey String
  recoveryWrappedPrivateKey String
  publicKey                 String
  totpSecretEncrypted       String?
  totpEnabled               Boolean   @default(false)
  storageQuotaBytes         Int
  storageUsedBytes          Int       @default(0)
  createdAt                 DateTime  @default(now())

  links               Link[]
  sentDrops           Drop[]
  sessions            Session[]
  passwordResetTokens PasswordResetToken[]
}

model Session {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([userId])
}

model Contact {
  id            String   @id @default(cuid())
  userId        String
  contactUserId String
  status        String   @default("pending")
  createdAt     DateTime @default(now())

  @@unique([userId, contactUserId])
  @@index([userId])
}

model PasswordResetToken {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([userId])
}
```

Then, in the existing `Link` model, replace `ownerId String?` with:

```prisma
  ownerId            String?
  owner              User?     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
```

and in the existing `Drop` model, replace `senderUserId String?` with:

```prisma
  senderUserId    String?
  senderUser      User?    @relation(fields: [senderUserId], references: [id], onDelete: SetNull)
```

(`Link.ownerId` cascades — deleting a `User` row removes their links, matching `cascadeDeleteUserLinks`' own cleanup so the two mechanisms agree; `Drop.senderUserId` is `SetNull` — a sender's account being deleted must not delete a recipient's already-received file.)

- [ ] **Step 2: Generate and apply the migration**

Run: `docker compose up -d postgres && pnpm --filter @e2ee-drop/db migrate:dev -- --name add-accounts`
Expected: a new folder under `packages/db/prisma/migrations/` is created and applied; command exits 0.

- [ ] **Step 3: Update the smoke test**

```typescript
// packages/db/src/index.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "./index";

describe("prisma client", () => {
  it("exposes link, drop, user, session, contact, and password-reset-token delegates", () => {
    expect(prisma.link).toBeDefined();
    expect(prisma.drop).toBeDefined();
    expect(prisma.user).toBeDefined();
    expect(prisma.session).toBeDefined();
    expect(prisma.contact).toBeDefined();
    expect(prisma.passwordResetToken).toBeDefined();
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @e2ee-drop/db generate && pnpm --filter @e2ee-drop/db test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): add User/Session/Contact/PasswordResetToken models and relations"
```

---

## Wave 1 — Independent libraries (parallel; each depends only on Task 1 and Plan 1's existing code)

### Task 2: Shared auth types

**Files:**
- Create: `packages/shared/src/auth.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing beyond Plan 1's `@e2ee-drop/shared` package.
- Produces (imported as `@e2ee-drop/shared` by both `apps/api` and `apps/web`): `RegisterRequest`, `RegisterResponse`, `LoginRequest`, `LoginResponse`, `MeResponse`, `PasswordResetRequestRequest`, `PasswordResetVerifyTokenResponse`, `PasswordResetCompleteRequest`, `PasswordResetCompleteFreshRequest`, `TotpSetupResponse`, `TotpEnableRequest`.

- [ ] **Step 1: Write `packages/shared/src/auth.ts`**

```typescript
// packages/shared/src/auth.ts
export interface RegisterRequest {
  email: string;
  username: string;
  name: string;
  password: string; // sent once over TLS at registration only, never stored
  passwordSalt: string; // base64, client-generated wrapping-KDF salt
  passwordWrappedPrivateKey: string; // base64
  recoveryWrappedPrivateKey: string; // base64
  publicKey: string; // base64
}

export interface RegisterResponse {
  userId: string;
  username: string;
  defaultLinkSlug: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  totpCode?: string;
}

export interface LoginResponse {
  userId: string;
  username: string;
  name: string;
  email: string;
  emailVerified: boolean;
  publicKey: string;
  passwordSalt: string;
  passwordWrappedPrivateKey: string;
  totpEnabled: boolean;
  requiresTotp?: boolean;
}

export interface MeResponse {
  userId: string;
  username: string;
  name: string;
  email: string;
  emailVerified: boolean;
  publicKey: string;
  passwordSalt: string;
  passwordWrappedPrivateKey: string;
  totpEnabled: boolean;
}

export interface PasswordResetRequestRequest {
  email: string;
}

export interface PasswordResetVerifyTokenResponse {
  email: string;
  passwordSalt: string;
  recoveryWrappedPrivateKey: string;
}

export interface PasswordResetCompleteRequest {
  token: string;
  newPassword: string; // plaintext, sent once over TLS — hashed server-side, same as registration
  newPasswordSalt: string;
  newPasswordWrappedPrivateKey: string;
}

export interface PasswordResetCompleteFreshRequest {
  token: string;
  newPassword: string; // plaintext, sent once over TLS — hashed server-side, same as registration
  newPasswordSalt: string;
  newPasswordWrappedPrivateKey: string;
  newRecoveryWrappedPrivateKey: string;
  newPublicKey: string;
}

export interface TotpSetupResponse {
  secretBase32: string;
  otpauthUrl: string;
}

export interface TotpEnableRequest {
  code: string;
}
```

- [ ] **Step 2: Add the re-export to `packages/shared/src/index.ts`**

```typescript
// packages/shared/src/index.ts
export * from "./api";
export * from "./crypto";
export * from "./auth";
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @e2ee-drop/shared exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add auth request/response contracts"
```

### Task 3: Server-side password hashing and TOTP libraries

**Files:**
- Create: `apps/api/src/lib/passwordAuth.ts`
- Create: `apps/api/src/lib/totp.ts`
- Test: `apps/api/src/lib/passwordAuth.test.ts`
- Test: `apps/api/src/lib/totp.test.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `env.APP_SECRET_KEY` from `../env` (Task 5 — the TOTP encryption path only; `passwordAuth.ts` has no env dependency).
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, hash: string): Promise<boolean>` from `passwordAuth.ts`; `generateTotpSecret(): string`, `buildOtpauthUrl(secretBase32: string, accountLabel: string): string`, `verifyTotpCode(secretBase32: string, code: string, usedCodes: Set<string>): boolean`, `encryptTotpSecret(secretBase32: string): string`, `decryptTotpSecret(encrypted: string): string` from `totp.ts` — consumed by Task 9, Task 10, Task 12.

- [ ] **Step 1: Add dependencies to `apps/api/package.json`**

Add to `dependencies`: `"hash-wasm": "^4.11.0"`, `"otpauth": "^9.3.6"`, `"nodemailer": "^6.9.16"`. Add to `devDependencies`: `"@types/nodemailer": "^6.4.16"`.

- [ ] **Step 2: Write the failing password-hashing test**

```typescript
// apps/api/src/lib/passwordAuth.test.ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./passwordAuth";

describe("passwordAuth", () => {
  it("hashes a password and verifies it correctly", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @e2ee-drop/api test -- passwordAuth`
Expected: FAIL — `./passwordAuth` module not found.

- [ ] **Step 4: Write `apps/api/src/lib/passwordAuth.ts`**

```typescript
// apps/api/src/lib/passwordAuth.ts
import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes } from "node:crypto";

const ARGON2_ITERATIONS = 2;
const ARGON2_MEMORY_KIB = 19456;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2Verify({ password, hash });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api test -- passwordAuth`
Expected: PASS (all three tests).

- [ ] **Step 6: Write the failing TOTP test**

```typescript
// apps/api/src/lib/totp.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../env", () => ({ env: { APP_SECRET_KEY: "a".repeat(32) } }));

import { generateTotpSecret, buildOtpauthUrl, verifyTotpCode, encryptTotpSecret, decryptTotpSecret } from "./totp";
import { TOTP, Secret } from "otpauth";

describe("totp", () => {
  it("generates a base32 secret and a usable otpauth URL", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThan(0);
    const url = buildOtpauthUrl(secret, "user@example.com");
    expect(url).toContain("otpauth://totp/");
  });

  it("verifies a currently-valid code and rejects a bogus one", () => {
    const secret = generateTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const validCode = totp.generate();
    const used = new Set<string>();

    expect(verifyTotpCode(secret, validCode, used)).toBe(true);
    expect(verifyTotpCode(secret, "000000", new Set())).toBe(false);
  });

  it("rejects a code that was already used in this window (replay)", () => {
    const secret = generateTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const validCode = totp.generate();
    const used = new Set<string>();

    expect(verifyTotpCode(secret, validCode, used)).toBe(true);
    expect(verifyTotpCode(secret, validCode, used)).toBe(false);
  });

  it("rejects a code generated far outside the tolerance window", () => {
    const secret = generateTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const staleCode = totp.generate({ timestamp: Date.now() - 10 * 60 * 1000 }); // 10 minutes ago

    expect(verifyTotpCode(secret, staleCode, new Set())).toBe(false);
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    expect(encrypted).not.toBe(secret);
    expect(decryptTotpSecret(encrypted)).toBe(secret);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/api test -- totp`
Expected: FAIL — `./totp` module not found.

- [ ] **Step 8: Write `apps/api/src/lib/totp.ts`**

```typescript
// apps/api/src/lib/totp.ts
import { TOTP, Secret } from "otpauth";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../env";

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function buildOtpauthUrl(secretBase32: string, accountLabel: string): string {
  const totp = new TOTP({
    issuer: "e2ee-drop",
    label: accountLabel,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

export function verifyTotpCode(secretBase32: string, code: string, usedCodes: Set<string>): boolean {
  if (usedCodes.has(code)) return false;
  const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return false;
  usedCodes.add(code);
  return true;
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(env.APP_SECRET_KEY).digest();
}

export function encryptTotpSecret(secretBase32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptTotpSecret(encrypted: string): string {
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api test -- totp`
Expected: PASS (all five tests).

- [ ] **Step 10: Commit**

```bash
git add apps/api/package.json apps/api/src/lib/passwordAuth.ts apps/api/src/lib/passwordAuth.test.ts apps/api/src/lib/totp.ts apps/api/src/lib/totp.test.ts pnpm-lock.yaml
git commit -m "feat(api): add Argon2id login-password hashing and TOTP libraries"
```

### Task 4: Client-side key-wrapping library

**Files:**
- Create: `apps/web/src/lib/keyWrapping.ts`
- Test: `apps/web/src/lib/keyWrapping.test.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: nothing beyond `tweetnacl`/`tweetnacl-util` (already present from Plan 1).
- Produces: `generateWrappingSalt(): string`, `deriveWrappingKey(password: string, saltB64: string): Promise<Uint8Array>`, `wrapPrivateKey(privateKey: Uint8Array, wrappingKey: Uint8Array): string`, `unwrapPrivateKey(wrapped: string, wrappingKey: Uint8Array): Uint8Array` (throws on failure), `generateRecoveryCode(): string`, `deriveRecoveryKey(recoveryCode: string): Uint8Array` — consumed by Task 13 (`useAuth`).

- [ ] **Step 1: Add `hash-wasm` to `apps/web/package.json` dependencies**

Add `"hash-wasm": "^4.11.0"` to `dependencies`.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web/src/lib/keyWrapping.test.ts
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  generateRecoveryCode,
  deriveRecoveryKey,
} from "./keyWrapping";

describe("keyWrapping", () => {
  it("wraps and unwraps a private key with a password-derived key", async () => {
    const keyPair = nacl.box.keyPair();
    const salt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey("my-password", salt);

    const wrapped = wrapPrivateKey(keyPair.secretKey, wrappingKey);
    const unwrapped = unwrapPrivateKey(wrapped, wrappingKey);

    expect(Array.from(unwrapped)).toEqual(Array.from(keyPair.secretKey));
  });

  it("throws when unwrapping with the wrong password-derived key", async () => {
    const keyPair = nacl.box.keyPair();
    const salt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey("my-password", salt);
    const wrongKey = await deriveWrappingKey("wrong-password", salt);

    const wrapped = wrapPrivateKey(keyPair.secretKey, wrappingKey);

    expect(() => unwrapPrivateKey(wrapped, wrongKey)).toThrow();
  });

  it("wraps and unwraps a private key with a recovery-code-derived key", () => {
    const keyPair = nacl.box.keyPair();
    const code = generateRecoveryCode();
    const recoveryKey = deriveRecoveryKey(code);

    const wrapped = wrapPrivateKey(keyPair.secretKey, recoveryKey);
    const unwrapped = unwrapPrivateKey(wrapped, deriveRecoveryKey(code));

    expect(Array.from(unwrapped)).toEqual(Array.from(keyPair.secretKey));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @e2ee-drop/web test -- keyWrapping`
Expected: FAIL — `./keyWrapping` module not found.

- [ ] **Step 4: Write `apps/web/src/lib/keyWrapping.ts`**

```typescript
// apps/web/src/lib/keyWrapping.ts
import { argon2id } from "hash-wasm";
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";

const ARGON2_ITERATIONS = 2;
const ARGON2_MEMORY_KIB = 19456;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;
const RECOVERY_CODE_BYTES = 20;

export function generateWrappingSalt(): string {
  return encodeBase64(nacl.randomBytes(16));
}

export async function deriveWrappingKey(password: string, saltB64: string): Promise<Uint8Array> {
  const hash = await argon2id({
    password,
    salt: decodeBase64(saltB64),
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: "binary",
  });
  return new Uint8Array(hash);
}

export function wrapPrivateKey(privateKey: Uint8Array, wrappingKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(privateKey, nonce, wrappingKey);
  const combined = new Uint8Array(nonce.length + box.length);
  combined.set(nonce);
  combined.set(box, nonce.length);
  return encodeBase64(combined);
}

export function unwrapPrivateKey(wrapped: string, wrappingKey: Uint8Array): Uint8Array {
  const combined = decodeBase64(wrapped);
  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const box = combined.slice(nacl.secretbox.nonceLength);
  const opened = nacl.secretbox.open(box, nonce, wrappingKey);
  if (!opened) throw new Error("Unwrap failed: incorrect password or corrupted data");
  return opened;
}

export function generateRecoveryCode(): string {
  const bytes = nacl.randomBytes(RECOVERY_CODE_BYTES);
  return encodeBase64(bytes).replace(/[+/=]/g, "").toUpperCase();
}

export function deriveRecoveryKey(recoveryCode: string): Uint8Array {
  return nacl.hash(new TextEncoder().encode(recoveryCode)).slice(0, 32);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- keyWrapping`
Expected: PASS (all three tests). Note: `argon2id` runs WebAssembly under the hood; Vitest's default `jsdom` environment (configured in Plan 1's `vite.config.ts`) supports `WebAssembly.instantiate`, so no extra config is needed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/lib/keyWrapping.ts apps/web/src/lib/keyWrapping.test.ts pnpm-lock.yaml
git commit -m "feat(web): add Argon2id password-derived and recovery-code key wrapping"
```

### Task 5: Env additions

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: nothing (extends Plan 1's `env.ts`).
- Produces: `env.SESSION_SECRET: string`, `env.APP_SECRET_KEY: string`, `env.ALLOW_REGISTRATION: boolean`, `env.DEFAULT_STORAGE_QUOTA_BYTES: number`, `env.APP_URL: string`, `env.SMTP_HOST: string | undefined`, `env.SMTP_PORT: number | undefined`, `env.SMTP_USER: string | undefined`, `env.SMTP_PASS: string | undefined`, `env.SMTP_FROM: string | undefined` — consumed by Tasks 7, 8, 9, 10, 11, 12.

- [ ] **Step 1: Modify `apps/api/src/env.ts`** — add a `bool` helper and the new fields to the exported `env` object:

```typescript
// apps/api/src/env.ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === "true";
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: int("PORT", 3000),
  MAX_FILE_SIZE_BYTES: int("MAX_FILE_SIZE_BYTES", 500 * 1024 * 1024),
  LINK_EXPIRY_HOURS: int("LINK_EXPIRY_HOURS", 24),
  DROP_RETENTION_DAYS: int("DROP_RETENTION_DAYS", 7),
  MINIO_ENDPOINT: required("MINIO_ENDPOINT"),
  MINIO_REGION: process.env.MINIO_REGION ?? "us-east-1",
  MINIO_BUCKET: required("MINIO_BUCKET"),
  MINIO_ACCESS_KEY: required("MINIO_ACCESS_KEY"),
  MINIO_SECRET_KEY: required("MINIO_SECRET_KEY"),
  SESSION_SECRET: required("SESSION_SECRET"),
  APP_SECRET_KEY: required("APP_SECRET_KEY"),
  ALLOW_REGISTRATION: bool("ALLOW_REGISTRATION", true),
  DEFAULT_STORAGE_QUOTA_BYTES: int("DEFAULT_STORAGE_QUOTA_BYTES", 5 * 1024 * 1024 * 1024),
  APP_URL: process.env.APP_URL ?? "http://localhost:8080",
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  SMTP_FROM: process.env.SMTP_FROM,
};
```

- [ ] **Step 2: Add the new variables to `.env.example`** (append to the existing `# API` section):

```
SESSION_SECRET=change-me-to-a-random-64-char-string
APP_SECRET_KEY=change-me-to-another-random-32-byte-string
ALLOW_REGISTRATION=true
DEFAULT_STORAGE_QUOTA_BYTES=5368709120
APP_URL=http://localhost:8080

# SMTP (optional — password-reset email is unavailable until set)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=e2ee-drop <no-reply@example.com>
```

- [ ] **Step 3: Pass the new variables through to the `api`, `migrate`, and `cleanup` services in `docker-compose.yml`** — add to each of those three services' `environment:` blocks (the `migrate` service only needs `DATABASE_URL`, already present; add the rest only to `api` and `cleanup`):

```yaml
      SESSION_SECRET: ${SESSION_SECRET}
      APP_SECRET_KEY: ${APP_SECRET_KEY}
      ALLOW_REGISTRATION: ${ALLOW_REGISTRATION}
      DEFAULT_STORAGE_QUOTA_BYTES: ${DEFAULT_STORAGE_QUOTA_BYTES}
      APP_URL: ${APP_URL}
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASS: ${SMTP_PASS}
      SMTP_FROM: ${SMTP_FROM}
```

- [ ] **Step 4: Validate the compose file**

Run: `docker compose config`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/env.ts .env.example docker-compose.yml
git commit -m "feat(api): add session/app-secret/registration/quota/SMTP env vars"
```

### Task 6: Account cascade-delete library

**Files:**
- Create: `apps/api/src/lib/accountDeletion.ts`
- Test: `apps/api/src/lib/accountDeletion.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@e2ee-drop/db` (Plan 1/Task 1); `deleteObject` from `../lib/storage` (Plan 1 Task 7).
- Produces: `cascadeDeleteUserLinks(userId: string): Promise<void>` — deletes every `Link` (and its `Drop` rows via the existing `onDelete: Cascade` on `Drop.linkId`) owned by `userId`, plus the corresponding MinIO objects, but does **not** delete the `User` row itself. Consumed by this plan's own Task 11 (password reset without recovery code) and by Plan 4 (full account deletion) — the exact name and signature must not change.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/accountDeletion.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("./storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { cascadeDeleteUserLinks } from "./accountDeletion";
import { deleteObject } from "./storage";

async function createTestUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `user-${suffix}@example.com`,
      username: `user-${suffix}`,
      name: "Test User",
      passwordHash: "hash",
      passwordSalt: "salt",
      passwordWrappedPrivateKey: "wrapped",
      recoveryWrappedPrivateKey: "recovery",
      publicKey: "pubkey",
      storageQuotaBytes: 1000,
    },
  });
}

describe("cascadeDeleteUserLinks", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    vi.clearAllMocks();
  });

  it("deletes all of a user's links, their drops, and the drops' MinIO objects, leaving the user row intact", async () => {
    const user = await createTestUser("a");
    const otherUser = await createTestUser("b");

    const link = await prisma.link.create({
      data: { ownerId: user.id, slug: "mine", mode: "permanent", recipientPublicKey: "x" },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "s",
        s3Key: `${link.id}/drop1`,
        nonce: "n",
        fileName: "f",
        fileSize: 1,
        mimeType: "text/plain",
        contentMD5: "m",
      },
    });
    const otherLink = await prisma.link.create({
      data: { ownerId: otherUser.id, slug: "theirs", mode: "permanent", recipientPublicKey: "y" },
    });

    await cascadeDeleteUserLinks(user.id);

    expect(await prisma.link.findUnique({ where: { id: link.id } })).toBeNull();
    expect(await prisma.link.findUnique({ where: { id: otherLink.id } })).not.toBeNull();
    expect(deleteObject).toHaveBeenCalledWith(`${link.id}/drop1`);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- accountDeletion`
Expected: FAIL — `./accountDeletion` module not found.

- [ ] **Step 3: Write `apps/api/src/lib/accountDeletion.ts`**

```typescript
// apps/api/src/lib/accountDeletion.ts
import { prisma } from "@e2ee-drop/db";
import { deleteObject } from "./storage";

export async function cascadeDeleteUserLinks(userId: string): Promise<void> {
  const links = await prisma.link.findMany({ where: { ownerId: userId }, include: { drops: true } });

  for (const link of links) {
    for (const drop of link.drops) {
      await deleteObject(drop.s3Key);
    }
    await prisma.link.delete({ where: { id: link.id } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- accountDeletion`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/accountDeletion.ts apps/api/src/lib/accountDeletion.test.ts
git commit -m "feat(api): add cascadeDeleteUserLinks for password-reset and account deletion"
```

### Task 7: SMTP mailer library

**Files:**
- Create: `apps/api/src/lib/mailer.ts`
- Test: `apps/api/src/lib/mailer.test.ts`

**Interfaces:**
- Consumes: `env.SMTP_HOST/PORT/USER/PASS/FROM` from `../env` (Task 5).
- Produces: `isMailerConfigured(): boolean`, `sendPasswordResetEmail(to: string, resetUrl: string): Promise<void>` (throws if not configured — callers must check `isMailerConfigured()` first) — consumed by Task 11.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/mailer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMailMock = vi.fn().mockResolvedValue(undefined);
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock }) },
}));

describe("mailer", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMailMock.mockClear();
  });

  it("reports unconfigured when SMTP_HOST is unset", async () => {
    vi.doMock("../env", () => ({ env: { SMTP_HOST: undefined } }));
    const { isMailerConfigured } = await import("./mailer");
    expect(isMailerConfigured()).toBe(false);
  });

  it("sends a password reset email when configured", async () => {
    vi.doMock("../env", () => ({
      env: {
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: 587,
        SMTP_USER: "user",
        SMTP_PASS: "pass",
        SMTP_FROM: "e2ee-drop <no-reply@example.com>",
      },
    }));
    const { isMailerConfigured, sendPasswordResetEmail } = await import("./mailer");
    expect(isMailerConfigured()).toBe(true);

    await sendPasswordResetEmail("someone@example.com", "https://app.example.com/reset?token=abc");

    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "someone@example.com", from: "e2ee-drop <no-reply@example.com>" })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/api test -- mailer`
Expected: FAIL — `./mailer` module not found.

- [ ] **Step 3: Write `apps/api/src/lib/mailer.ts`**

```typescript
// apps/api/src/lib/mailer.ts
import nodemailer from "nodemailer";
import { env } from "../env";

export function isMailerConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM);
}

function getTransport() {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  if (!isMailerConfigured()) throw new Error("SMTP is not configured");
  const transport = getTransport();
  await transport.sendMail({
    to,
    from: env.SMTP_FROM,
    subject: "Reset your e2ee-drop password",
    text: `Reset your password: ${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api test -- mailer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/mailer.ts apps/api/src/lib/mailer.test.ts
git commit -m "feat(api): add SMTP mailer for password-reset emails"
```

---

## Wave 2 — Sessions, routes (parallel where marked; each depends on specific Wave 0/1 tasks as noted)

### Task 8: Sessions library and Fastify auth plugin

**Files:**
- Create: `apps/api/src/lib/sessions.ts`
- Create: `apps/api/src/plugins/auth.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/src/lib/sessions.test.ts`
- Test: `apps/api/src/plugins/auth.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@e2ee-drop/db` (Task 1); `env.SESSION_SECRET` from `../env` (Task 5).
- Produces: `createSession(userId: string): Promise<{ id: string; expiresAt: Date }>`, `getUserIdFromSession(sessionId: string): Promise<string | null>`, `deleteSession(sessionId: string): Promise<void>`, `deleteAllUserSessions(userId: string): Promise<void>` from `sessions.ts` — consumed by Tasks 9, 10, 11. `SESSION_COOKIE_NAME` constant and a Fastify plugin from `plugins/auth.ts` that decorates every `request.user: {id: string} | null` and the server with `server.requireAuth` (a preHandler that replies 403 when `request.user` is null) — consumed by Tasks 9, 10, 11, 12, and by Plan 3 (contacts routes, run in parallel, cannot see this task's code — it imports `server.requireAuth` by that exact name). **Note:** this task changes `buildServer()`'s earlier contract from Plan 1 (which deliberately kept `server.ts` free of any `env` import so it was testable without a full env) — from this task onward, `server.ts` reads `env.SESSION_SECRET` to configure the cookie plugin, so every `apps/api` test now needs `SESSION_SECRET` and `APP_SECRET_KEY` set, on top of Plan 1's env vars.

- [ ] **Step 1: Add `@fastify/cookie` and `fastify-plugin` to `apps/api/package.json` dependencies**

Add `"@fastify/cookie": "^11.0.2"`, `"fastify-plugin": "^5.0.1"`.

- [ ] **Step 2: Write the failing sessions test**

```typescript
// apps/api/src/lib/sessions.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { createSession, getUserIdFromSession, deleteSession, deleteAllUserSessions } from "./sessions";

async function createTestUser() {
  return prisma.user.create({
    data: {
      email: `u-${Date.now()}@example.com`,
      username: `u-${Date.now()}`,
      name: "T",
      passwordHash: "h",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k",
      storageQuotaBytes: 1000,
    },
  });
}

describe("sessions", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  it("creates a session and resolves the user id from it", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);
    expect(await getUserIdFromSession(session.id)).toBe(user.id);
  });

  it("returns null for an unknown session id", async () => {
    expect(await getUserIdFromSession("does-not-exist")).toBeNull();
  });

  it("deletes a single session", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);
    await deleteSession(session.id);
    expect(await getUserIdFromSession(session.id)).toBeNull();
  });

  it("deletes all sessions for a user", async () => {
    const user = await createTestUser();
    const a = await createSession(user.id);
    const b = await createSession(user.id);
    await deleteAllUserSessions(user.id);
    expect(await getUserIdFromSession(a.id)).toBeNull();
    expect(await getUserIdFromSession(b.id)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too SESSION_SECRET=test-session-secret-32-chars-min APP_SECRET_KEY=test-app-secret-32-chars-minimum pnpm --filter @e2ee-drop/api test -- sessions`

(this full env var line is reused by every `apps/api` test task from here on)

Expected: FAIL — `./sessions` module not found.

- [ ] **Step 4: Write `apps/api/src/lib/sessions.ts`**

```typescript
// apps/api/src/lib/sessions.ts
import { prisma } from "@e2ee-drop/db";

const SESSION_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  return prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + SESSION_LENGTH_MS) } });
}

export async function getUserIdFromSession(sessionId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: sessionId } });
    return null;
  }
  return session.userId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function deleteAllUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run the Step 3 command again.
Expected: PASS (all four tests).

- [ ] **Step 6: Write `apps/api/src/plugins/auth.ts`**

```typescript
// apps/api/src/plugins/auth.ts
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getUserIdFromSession } from "../lib/sessions";

export const SESSION_COOKIE_NAME = "e2ee_drop_session";

export interface AuthenticatedUser {
  id: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async function authPlugin(server: FastifyInstance) {
  server.decorateRequest("user", null);

  server.addHook("onRequest", async (request) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (!raw) {
      request.user = null;
      return;
    }
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      request.user = null;
      return;
    }
    const userId = await getUserIdFromSession(unsigned.value);
    request.user = userId ? { id: userId } : null;
  });

  server.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      reply.status(403).send({ error: "Authentication required" });
    }
  });
});
```

- [ ] **Step 7: Wire cookie support and the auth plugin into `apps/api/src/server.ts`**

```typescript
// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import authPlugin from "./plugins/auth";
import { registerLinkRoutes } from "./routes/links";
import { registerUploadRoutes } from "./routes/uploads";
import { registerDownloadRoutes } from "./routes/downloads";
import { env } from "./env";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.register(cookie, { secret: env.SESSION_SECRET });
  server.register(authPlugin);

  server.get("/api/health", async () => ({ status: "ok" }));
  registerLinkRoutes(server);
  registerUploadRoutes(server);
  registerDownloadRoutes(server);

  return server;
}
```

- [ ] **Step 8: Write the failing auth-plugin test**

```typescript
// apps/api/src/plugins/auth.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../server";

describe("auth plugin", () => {
  it("leaves request.user null and 403s protected routes with no cookie", async () => {
    const server = buildServer();
    server.get("/__test/protected", { preHandler: server.requireAuth }, async () => ({ ok: true }));

    const response = await server.inject({ method: "GET", url: "/__test/protected" });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a garbage/unsigned cookie value the same as no cookie", async () => {
    const server = buildServer();
    server.get("/__test/protected", { preHandler: server.requireAuth }, async () => ({ ok: true }));

    const response = await server.inject({
      method: "GET",
      url: "/__test/protected",
      cookies: { e2ee_drop_session: "not-a-real-signed-value" },
    });
    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 9: Run test to verify it passes**

Run the Step 3 command with `-- auth`.
Expected: PASS (both tests).

- [ ] **Step 10: Commit**

```bash
git add apps/api/package.json apps/api/src/lib/sessions.ts apps/api/src/lib/sessions.test.ts apps/api/src/plugins/auth.ts apps/api/src/plugins/auth.test.ts apps/api/src/server.ts pnpm-lock.yaml
git commit -m "feat(api): add DB-backed sessions and a Fastify auth plugin with requireAuth"
```

### Task 9: Registration route

**Files:**
- Create: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/lib/links.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `hashPassword` from `../lib/passwordAuth` (Task 3); `createSession` from `../lib/sessions`, `SESSION_COOKIE_NAME` from `../plugins/auth` (Task 8); `env.ALLOW_REGISTRATION`, `env.DEFAULT_STORAGE_QUOTA_BYTES` (Task 5); `RegisterRequest`, `RegisterResponse` from `@e2ee-drop/shared` (Task 2).
- Produces: `createDefaultLinkForUser(userId: string, username: string, publicKey: string): Promise<Link>` added to `../lib/links.ts` — also consumed by Task 11 (fresh-keypair password reset). Registers `POST /api/auth/register` — consumed by Task 13 (`useAuth`).

- [ ] **Step 1: Add `createDefaultLinkForUser` to `apps/api/src/lib/links.ts`** — append this export to the existing file (do not remove anything already there):

```typescript
export async function createDefaultLinkForUser(userId: string, username: string, publicKey: string): Promise<Link> {
  return prisma.link.create({
    data: {
      ownerId: userId,
      slug: username,
      mode: "permanent",
      visibility: "public",
      recipientPublicKey: publicKey,
      isDefault: true,
    },
  });
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/src/routes/auth.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

describe("POST /api/auth/register", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("registers a new user, creates their default permanent link, and sets a session cookie", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "alice@example.com",
        username: "alice",
        name: "Alice",
        password: "correct horse battery staple",
        passwordSalt: "c2FsdA==",
        passwordWrappedPrivateKey: "d3JhcHBlZA==",
        recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
        publicKey: "cHVia2V5",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.username).toBe("alice");
    expect(body.defaultLinkSlug).toBe("alice");
    expect(response.cookies.some((c: { name: string }) => c.name === "e2ee_drop_session")).toBe(true);

    const link = await prisma.link.findFirst({ where: { slug: "alice" } });
    expect(link?.isDefault).toBe(true);
    expect(link?.mode).toBe("permanent");
    expect(link?.ownerId).toBe(body.userId);
  });

  it("returns 409 when the email is already registered", async () => {
    const server = buildServer();
    const payload = {
      email: "bob@example.com",
      username: "bob",
      name: "Bob",
      password: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k1",
    };
    await server.inject({ method: "POST", url: "/api/auth/register", payload });
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, username: "bob2", publicKey: "k2" },
    });

    expect(second.statusCode).toBe(409);
  });

  it("rejects registration when ALLOW_REGISTRATION is disabled", async () => {
    vi.resetModules();
    vi.doMock("../env", () => ({ env: { ALLOW_REGISTRATION: false, DEFAULT_STORAGE_QUOTA_BYTES: 1000 } }));
    const Fastify = (await import("fastify")).default;
    const { registerAuthRoutes } = await import("./auth");
    const freshServer = Fastify();
    registerAuthRoutes(freshServer);

    const response = await freshServer.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "x@example.com",
        username: "x",
        name: "X",
        password: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
      },
    });

    expect(response.statusCode).toBe(403);
    vi.doUnmock("../env");
    vi.resetModules();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run the standard env line (Task 8 Step 3) with `-- routes/auth`.
Expected: FAIL — `./auth` route module not found.

- [ ] **Step 4: Write `apps/api/src/routes/auth.ts`**

```typescript
// apps/api/src/routes/auth.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { RegisterRequest, RegisterResponse } from "@e2ee-drop/shared";
import { hashPassword } from "../lib/passwordAuth";
import { createDefaultLinkForUser } from "../lib/links";
import { createSession } from "../lib/sessions";
import { env } from "../env";
import { SESSION_COOKIE_NAME } from "../plugins/auth";

export function registerAuthRoutes(server: FastifyInstance): void {
  server.post<{ Body: RegisterRequest }>("/api/auth/register", async (request, reply) => {
    if (!env.ALLOW_REGISTRATION) {
      return reply.status(403).send({ error: "Registration is disabled on this instance" });
    }

    const {
      email,
      username,
      name,
      password,
      passwordSalt,
      passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey,
      publicKey,
    } = request.body;
    if (
      !email ||
      !username ||
      !name ||
      !password ||
      !passwordSalt ||
      !passwordWrappedPrivateKey ||
      !recoveryWrappedPrivateKey ||
      !publicKey
    ) {
      return reply.status(400).send({ error: "Missing required fields" });
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await prisma.user.create({
        data: {
          email,
          username,
          name,
          passwordHash,
          passwordSalt,
          passwordWrappedPrivateKey,
          recoveryWrappedPrivateKey,
          publicKey,
          storageQuotaBytes: env.DEFAULT_STORAGE_QUOTA_BYTES,
        },
      });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        return reply.status(409).send({ error: "Email or username already in use" });
      }
      throw error;
    }

    const defaultLink = await createDefaultLinkForUser(user.id, user.username, user.publicKey);
    const session = await createSession(user.id);

    reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });

    const body: RegisterResponse = { userId: user.id, username: user.username, defaultLinkSlug: defaultLink.slug };
    return reply.send(body);
  });
}
```

- [ ] **Step 5: Register the routes in `apps/api/src/server.ts`** — add the import and call alongside the others:

```typescript
import { registerAuthRoutes } from "./routes/auth";
// ...
  registerAuthRoutes(server);
```

- [ ] **Step 6: Run test to verify it passes**

Run the Step 3 command again.
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts apps/api/src/lib/links.ts apps/api/src/server.ts
git commit -m "feat(api): add registration route with default personal link creation"
```

### Task 10: Login, logout, and me routes

**Files:**
- Create: `apps/api/src/lib/totpReplayGuard.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/server.ts` (no change needed — routes are added to the same `registerAuthRoutes` function already registered by Task 9)
- Test: `apps/api/src/routes/auth.test.ts` (append)

**Interfaces:**
- Consumes: `verifyPassword` from `../lib/passwordAuth`, `decryptTotpSecret`, `verifyTotpCode` from `../lib/totp` (Task 3); `createSession`, `deleteSession` from `../lib/sessions`, `SESSION_COOKIE_NAME` from `../plugins/auth` (Task 8); `LoginRequest`, `LoginResponse`, `MeResponse` from `@e2ee-drop/shared` (Task 2).
- Produces: `getUsedCodesForUser(userId: string): Set<string>` from `totpReplayGuard.ts` (a module-level in-memory store — matches the spec's single-instance design, §13) — also consumed by Task 12 (2FA enable), so both entry points into TOTP verification share one replay window per user. Registers `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.

- [ ] **Step 1: Write `apps/api/src/lib/totpReplayGuard.ts`**

```typescript
// apps/api/src/lib/totpReplayGuard.ts
const usedCodesByUser = new Map<string, Set<string>>();

export function getUsedCodesForUser(userId: string): Set<string> {
  let set = usedCodesByUser.get(userId);
  if (!set) {
    set = new Set();
    usedCodesByUser.set(userId, set);
  }
  return set;
}
```

- [ ] **Step 2: Append the failing tests to `apps/api/src/routes/auth.test.ts`**

```typescript
// apps/api/src/routes/auth.test.ts (append inside a new describe block)
import { encryptTotpSecret, generateTotpSecret } from "../lib/totp";
import { TOTP, Secret } from "otpauth";

describe("POST /api/auth/login, /api/auth/logout, GET /api/auth/me", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  async function register(server: ReturnType<typeof buildServer>, overrides: Record<string, unknown> = {}) {
    return server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "carol@example.com",
        username: "carol",
        name: "Carol",
        password: "correct horse battery staple",
        passwordSalt: "c2FsdA==",
        passwordWrappedPrivateKey: "d3JhcHBlZA==",
        recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
        publicKey: "cHVia2V5",
        ...overrides,
      },
    });
  }

  it("logs in with the correct password and returns key-wrapping material", async () => {
    const server = buildServer();
    await register(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", password: "correct horse battery staple" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passwordWrappedPrivateKey).toBe("d3JhcHBlZA==");
    expect(body.passwordSalt).toBe("c2FsdA==");
  });

  it("rejects the wrong password", async () => {
    const server = buildServer();
    await register(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", password: "wrong password" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("requires a TOTP code when 2FA is enabled, accepts a valid one, and rejects replaying it", async () => {
    const server = buildServer();
    await register(server);
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { email: "carol@example.com" },
      data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) },
    });

    const withoutCode = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", password: "correct horse battery staple" },
    });
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.json().requiresTotp).toBe(true);

    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const code = totp.generate();

    const withCode = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", password: "correct horse battery staple", totpCode: code },
    });
    expect(withCode.statusCode).toBe(200);

    const replay = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "carol@example.com", password: "correct horse battery staple", totpCode: code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("logs out and clears the session so /me subsequently 403s", async () => {
    const server = buildServer();
    const registerResponse = await register(server);
    const cookie = registerResponse.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;

    const meBefore = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { e2ee_drop_session: cookie.value },
    });
    expect(meBefore.statusCode).toBe(200);

    await server.inject({ method: "POST", url: "/api/auth/logout", cookies: { e2ee_drop_session: cookie.value } });

    const meAfter = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { e2ee_drop_session: cookie.value },
    });
    expect(meAfter.statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run the standard env line with `-- routes/auth`.
Expected: FAIL — no `/api/auth/login` route registered yet.

- [ ] **Step 4: Append the routes to `apps/api/src/routes/auth.ts`** — add these imports at the top:

```typescript
import type { LoginRequest, LoginResponse, MeResponse } from "@e2ee-drop/shared";
import { verifyPassword } from "../lib/passwordAuth";
import { decryptTotpSecret, verifyTotpCode } from "../lib/totp";
import { deleteSession } from "../lib/sessions";
import { getUsedCodesForUser } from "../lib/totpReplayGuard";
```

and add these three route registrations inside `registerAuthRoutes`, after the `/api/auth/register` handler:

```typescript
  server.post<{ Body: LoginRequest }>("/api/auth/login", async (request, reply) => {
    const { email, password, totpCode } = request.body;
    if (!email || !password) return reply.status(400).send({ error: "Missing email or password" });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    if (user.totpEnabled) {
      if (!totpCode) {
        return reply.status(401).send({ error: "TOTP code required", requiresTotp: true });
      }
      const secret = decryptTotpSecret(user.totpSecretEncrypted!);
      if (!verifyTotpCode(secret, totpCode, getUsedCodesForUser(user.id))) {
        return reply.status(401).send({ error: "Invalid TOTP code" });
      }
    }

    const session = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });

    const body: LoginResponse = {
      userId: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      publicKey: user.publicKey,
      passwordSalt: user.passwordSalt,
      passwordWrappedPrivateKey: user.passwordWrappedPrivateKey,
      totpEnabled: user.totpEnabled,
    };
    return reply.send(body);
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) await deleteSession(unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.send({ loggedOut: true });
  });

  server.get("/api/auth/me", { preHandler: server.requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user!.id } });
    if (!user) return reply.status(404).send({ error: "User not found" });
    const body: MeResponse = {
      userId: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      publicKey: user.publicKey,
      passwordSalt: user.passwordSalt,
      passwordWrappedPrivateKey: user.passwordWrappedPrivateKey,
      totpEnabled: user.totpEnabled,
    };
    return reply.send(body);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run the Step 3 command again.
Expected: PASS (all tests in the file, including the new describe block).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/totpReplayGuard.ts apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(api): add login, logout, and me routes with TOTP replay protection"
```

### Task 11: Password reset routes (recovery-code path and no-recovery cascade-delete path)

**Files:**
- Create: `apps/api/src/routes/passwordReset.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/passwordReset.test.ts`

**Interfaces:**
- Consumes: `deleteAllUserSessions` from `../lib/sessions` (Task 8); `isMailerConfigured`, `sendPasswordResetEmail` from `../lib/mailer` (Task 7); `cascadeDeleteUserLinks` from `../lib/accountDeletion` (Task 6); `createDefaultLinkForUser` from `../lib/links` (Task 9); `env.APP_URL` (Task 5); `PasswordResetRequestRequest`, `PasswordResetVerifyTokenResponse`, `PasswordResetCompleteRequest`, `PasswordResetCompleteFreshRequest` from `@e2ee-drop/shared` (Task 2).
- Produces: registers `POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/verify-token`, `POST /api/auth/password-reset/complete`, `POST /api/auth/password-reset/complete-fresh` — consumed by Task 14 (password-reset pages).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/routes/passwordReset.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { verifyPassword } from "../lib/passwordAuth";

vi.mock("../lib/mailer", () => ({
  isMailerConfigured: vi.fn().mockReturnValue(false),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

async function registerUser(server: ReturnType<typeof buildServer>) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "dana@example.com",
      username: "dana",
      name: "Dana",
      password: "original password",
      passwordSalt: "b3JpZ2luYWwtc2FsdA==",
      passwordWrappedPrivateKey: "b3JpZ2luYWwtd3JhcHBlZA==",
      recoveryWrappedPrivateKey: "b3JpZ2luYWwtcmVjb3Zlcnk=",
      publicKey: "b3JpZ2luYWwtcHVia2V5",
    },
  });
  return response.json();
}

async function issueResetToken(userId: string): Promise<string> {
  const token = "test-reset-token";
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

describe("password reset routes", () => {
  beforeEach(async () => {
    await prisma.passwordResetToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("always returns 200 from /request, even for an unregistered email, without creating a token for it", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "nobody@example.com" },
    });
    expect(response.statusCode).toBe(200);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("creates a token for a registered email and verify-token returns the recovery blob", async () => {
    const server = buildServer();
    const { userId } = await registerUser(server);

    await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      payload: { email: "dana@example.com" },
    });
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(1);
  });

  it("rejects verify-token and complete for an invalid token", async () => {
    const server = buildServer();
    const verify = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/verify-token",
      payload: { token: "not-a-real-token" },
    });
    expect(verify.statusCode).toBe(400);
  });

  it("recovery-code path: preserves existing links/drops, rotates only credentials, and revokes old sessions", async () => {
    const server = buildServer();
    const { userId, defaultLinkSlug } = await registerUser(server);
    const link = await prisma.link.findFirstOrThrow({ where: { slug: defaultLinkSlug } });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "s",
        s3Key: `${link.id}/drop1`,
        nonce: "n",
        fileName: "f",
        fileSize: 1,
        mimeType: "text/plain",
        contentMD5: "m",
      },
    });
    const oldSessionCountBefore = await prisma.session.count({ where: { userId } });
    expect(oldSessionCountBefore).toBeGreaterThan(0);

    const token = await issueResetToken(userId);
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete",
      payload: {
        token,
        newPassword: "a brand new password",
        newPasswordSalt: "bmV3LXNhbHQ=",
        newPasswordWrappedPrivateKey: "bmV3LXdyYXBwZWQ=",
      },
    });

    expect(response.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.passwordWrappedPrivateKey).toBe("bmV3LXdyYXBwZWQ=");
    expect(await verifyPassword("a brand new password", user.passwordHash)).toBe(true);
    expect(user.publicKey).toBe("b3JpZ2luYWwtcHVia2V5");
    expect(await prisma.link.count({ where: { id: link.id } })).toBe(1);
    expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(1);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  it("no-recovery-code path: cascade-deletes existing links/drops and issues a fresh default link", async () => {
    const server = buildServer();
    const { userId, defaultLinkSlug } = await registerUser(server);
    const oldLink = await prisma.link.findFirstOrThrow({ where: { slug: defaultLinkSlug } });

    const token = await issueResetToken(userId);
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete-fresh",
      payload: {
        token,
        newPassword: "a fresh new password",
        newPasswordSalt: "bmV3LXNhbHQ=",
        newPasswordWrappedPrivateKey: "bmV3LXdyYXBwZWQ=",
        newRecoveryWrappedPrivateKey: "bmV3LXJlY292ZXJ5",
        newPublicKey: "bmV3LXB1YmtleQ==",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await prisma.link.count({ where: { id: oldLink.id } })).toBe(0);
    const newDefaultLink = await prisma.link.findFirstOrThrow({ where: { ownerId: userId, isDefault: true } });
    expect(newDefaultLink.recipientPublicKey).toBe("bmV3LXB1YmtleQ==");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.publicKey).toBe("bmV3LXB1YmtleQ==");
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the standard env line with `-- passwordReset`.
Expected: FAIL — `./passwordReset` route module not found.

- [ ] **Step 3: Write `apps/api/src/routes/passwordReset.ts`**

```typescript
// apps/api/src/routes/passwordReset.ts
import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@e2ee-drop/db";
import type {
  PasswordResetRequestRequest,
  PasswordResetVerifyTokenResponse,
  PasswordResetCompleteRequest,
  PasswordResetCompleteFreshRequest,
} from "@e2ee-drop/shared";
import { deleteAllUserSessions } from "../lib/sessions";
import { isMailerConfigured, sendPasswordResetEmail } from "../lib/mailer";
import { cascadeDeleteUserLinks } from "../lib/accountDeletion";
import { createDefaultLinkForUser } from "../lib/links";
import { hashPassword } from "../lib/passwordAuth";
import { env } from "../env";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function findValidResetToken(token: string) {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.expiresAt.getTime() < Date.now()) return null;
  return record;
}

export function registerPasswordResetRoutes(server: FastifyInstance): void {
  server.post<{ Body: PasswordResetRequestRequest }>(
    "/api/auth/password-reset/request",
    async (request, reply) => {
      const { email } = request.body;
      const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
      if (user) {
        const token = randomBytes(32).toString("base64url");
        await prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
        });
        if (isMailerConfigured()) {
          await sendPasswordResetEmail(user.email, `${env.APP_URL}/reset-password?token=${token}`);
        }
      }
      // Always 200, regardless of whether the email is registered, so this endpoint cannot be used to enumerate accounts.
      return reply.send({ requested: true });
    }
  );

  server.post<{ Body: { token: string } }>("/api/auth/password-reset/verify-token", async (request, reply) => {
    const record = await findValidResetToken(request.body.token);
    if (!record) return reply.status(400).send({ error: "Invalid or expired reset token" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    const body: PasswordResetVerifyTokenResponse = {
      email: user.email,
      passwordSalt: user.passwordSalt,
      recoveryWrappedPrivateKey: user.recoveryWrappedPrivateKey,
    };
    return reply.send(body);
  });

  server.post<{ Body: PasswordResetCompleteRequest }>(
    "/api/auth/password-reset/complete",
    async (request, reply) => {
      const { token, newPassword, newPasswordSalt, newPasswordWrappedPrivateKey } = request.body;
      const record = await findValidResetToken(token);
      if (!record) return reply.status(400).send({ error: "Invalid or expired reset token" });

      await prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(newPassword),
          passwordSalt: newPasswordSalt,
          passwordWrappedPrivateKey: newPasswordWrappedPrivateKey,
        },
      });
      await deleteAllUserSessions(record.userId);
      await prisma.passwordResetToken.delete({ where: { id: record.id } });
      return reply.send({ reset: true });
    }
  );

  server.post<{ Body: PasswordResetCompleteFreshRequest }>(
    "/api/auth/password-reset/complete-fresh",
    async (request, reply) => {
      const {
        token,
        newPassword,
        newPasswordSalt,
        newPasswordWrappedPrivateKey,
        newRecoveryWrappedPrivateKey,
        newPublicKey,
      } = request.body;
      const record = await findValidResetToken(token);
      if (!record) return reply.status(400).send({ error: "Invalid or expired reset token" });

      await cascadeDeleteUserLinks(record.userId);
      const user = await prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(newPassword),
          passwordSalt: newPasswordSalt,
          passwordWrappedPrivateKey: newPasswordWrappedPrivateKey,
          recoveryWrappedPrivateKey: newRecoveryWrappedPrivateKey,
          publicKey: newPublicKey,
        },
      });
      await createDefaultLinkForUser(user.id, user.username, user.publicKey);
      await deleteAllUserSessions(user.id);
      await prisma.passwordResetToken.delete({ where: { id: record.id } });
      return reply.send({ reset: true });
    }
  );
}
```

- [ ] **Step 4: Register the routes in `apps/api/src/server.ts`**

```typescript
import { registerPasswordResetRoutes } from "./routes/passwordReset";
// ...
  registerPasswordResetRoutes(server);
```

- [ ] **Step 5: Run test to verify it passes**

Run the Step 2 command again.
Expected: PASS (all six tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/passwordReset.ts apps/api/src/routes/passwordReset.test.ts apps/api/src/server.ts
git commit -m "feat(api): add password reset routes with recovery-code and cascade-delete paths"
```

### Task 12: Two-factor authentication routes

**Files:**
- Create: `apps/api/src/routes/twoFactor.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/twoFactor.test.ts`

**Interfaces:**
- Consumes: `generateTotpSecret`, `buildOtpauthUrl`, `verifyTotpCode`, `encryptTotpSecret` from `../lib/totp` (Task 3); `getUsedCodesForUser` from `../lib/totpReplayGuard` (Task 10); `server.requireAuth` (Task 8); `TotpSetupResponse`, `TotpEnableRequest` from `@e2ee-drop/shared` (Task 2).
- Produces: registers `POST /api/auth/2fa/setup`, `POST /api/auth/2fa/enable`, `POST /api/auth/2fa/disable` — consumed by Plan 3's account-settings UI (not built in this plan).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/routes/twoFactor.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { TOTP, Secret } from "otpauth";

async function registerAndGetCookie(server: ReturnType<typeof buildServer>) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "erin@example.com",
      username: "erin",
      name: "Erin",
      password: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k",
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return { userId: response.json().userId, cookieValue: cookie.value };
}

describe("2FA routes", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("requires authentication to set up 2FA", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "POST", url: "/api/auth/2fa/setup" });
    expect(response.statusCode).toBe(403);
  });

  it("sets up, enables with a valid code, and disables 2FA", async () => {
    const server = buildServer();
    const { userId, cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };

    const setupResponse = await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });
    expect(setupResponse.statusCode).toBe(200);
    const { secretBase32 } = setupResponse.json();

    const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
    const enableResponse = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: totp.generate() },
    });
    expect(enableResponse.statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.totpEnabled).toBe(true);

    const disableResponse = await server.inject({ method: "POST", url: "/api/auth/2fa/disable", cookies });
    expect(disableResponse.statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).totpEnabled).toBe(false);
  });

  it("rejects enabling 2FA with the wrong code", async () => {
    const server = buildServer();
    const { cookieValue } = await registerAndGetCookie(server);
    const cookies = { e2ee_drop_session: cookieValue };
    await server.inject({ method: "POST", url: "/api/auth/2fa/setup", cookies });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      cookies,
      payload: { code: "000000" },
    });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the standard env line with `-- twoFactor`.
Expected: FAIL — `./twoFactor` route module not found.

- [ ] **Step 3: Write `apps/api/src/routes/twoFactor.ts`**

```typescript
// apps/api/src/routes/twoFactor.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { TotpSetupResponse, TotpEnableRequest } from "@e2ee-drop/shared";
import { generateTotpSecret, buildOtpauthUrl, verifyTotpCode, encryptTotpSecret } from "../lib/totp";
import { getUsedCodesForUser } from "../lib/totpReplayGuard";

const pendingSetupSecrets = new Map<string, string>();

export function registerTwoFactorRoutes(server: FastifyInstance): void {
  server.post("/api/auth/2fa/setup", { preHandler: server.requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    const secret = generateTotpSecret();
    pendingSetupSecrets.set(user.id, secret);
    const body: TotpSetupResponse = { secretBase32: secret, otpauthUrl: buildOtpauthUrl(secret, user.email) };
    return reply.send(body);
  });

  server.post<{ Body: TotpEnableRequest }>(
    "/api/auth/2fa/enable",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const pendingSecret = pendingSetupSecrets.get(request.user!.id);
      if (!pendingSecret) {
        return reply.status(400).send({ error: "No pending 2FA setup. Call /api/auth/2fa/setup first." });
      }
      if (!verifyTotpCode(pendingSecret, request.body.code, getUsedCodesForUser(request.user!.id))) {
        return reply.status(401).send({ error: "Invalid code" });
      }
      await prisma.user.update({
        where: { id: request.user!.id },
        data: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(pendingSecret) },
      });
      pendingSetupSecrets.delete(request.user!.id);
      return reply.send({ enabled: true });
    }
  );

  server.post("/api/auth/2fa/disable", { preHandler: server.requireAuth }, async (request, reply) => {
    await prisma.user.update({
      where: { id: request.user!.id },
      data: { totpEnabled: false, totpSecretEncrypted: null },
    });
    return reply.send({ disabled: true });
  });
}
```

- [ ] **Step 4: Register the routes in `apps/api/src/server.ts`**

```typescript
import { registerTwoFactorRoutes } from "./routes/twoFactor";
// ...
  registerTwoFactorRoutes(server);
```

- [ ] **Step 5: Run test to verify it passes**

Run the Step 2 command again.
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/twoFactor.ts apps/api/src/routes/twoFactor.test.ts apps/api/src/server.ts
git commit -m "feat(api): add 2FA setup/enable/disable routes"
```

---

## Wave 3 — Frontend auth (parallel; Task 13 depends on Task 4 + Task 2's contracts, Tasks 14/15 depend on Task 13)

### Task 13: `useAuth` hook and provider

**Files:**
- Create: `apps/web/src/hooks/useAuth.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/hooks/useAuth.test.tsx`

**Interfaces:**
- Consumes: `generateWrappingSalt`, `deriveWrappingKey`, `wrapPrivateKey`, `unwrapPrivateKey`, `generateRecoveryCode`, `deriveRecoveryKey` from `@/lib/keyWrapping` (Task 4); `LoginResponse`, `MeResponse`, `RegisterResponse` from `@e2ee-drop/shared` (Task 2); talks to `POST /api/auth/register` (Task 9), `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` (Task 10) over `fetch`.
- Produces: `<AuthProvider>` (wraps the app in `App.tsx`) and `useAuth()` returning `{ user: AuthUser | null, login(email, password, totpCode?): Promise<{ requiresTotp: boolean }>, logout(): Promise<void>, register(input): Promise<{ recoveryCode: string }> }`, where `AuthUser` includes `{ id, username, name, email, emailVerified, publicKey, totpEnabled, keyPair: nacl.BoxKeyPair | null }`. Imported as `from "@/hooks/useAuth"` — the `.tsx` extension is not part of the import path, so this matches the name Plan 3 expects. `keyPair` is populated only by `login()`/`register()` within the current page load (it is never persisted anywhere — a bare page reload clears it even though `user` itself is restored from the session cookie via `GET /api/auth/me`, so callers needing crypto after a reload must prompt for the password again via `login()`). Consumed by Plan 3.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/hooks/useAuth.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { generateWrappingSalt, deriveWrappingKey, wrapPrivateKey } from "@/lib/keyWrapping";
import { AuthProvider, useAuth } from "./useAuth";

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("useAuth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("register() generates a key pair locally and stores it, unwrapped, in state", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/register")) {
        return new Response(JSON.stringify({ userId: "u1", username: "frank", defaultLinkSlug: "frank" }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    let recoveryCode = "";
    await act(async () => {
      const { recoveryCode: code } = await result.current.register({
        email: "frank@example.com",
        username: "frank",
        name: "Frank",
        password: "p",
      });
      recoveryCode = code;
    });

    expect(result.current.user?.username).toBe("frank");
    expect(result.current.user?.keyPair).not.toBeNull();
    expect(recoveryCode.length).toBeGreaterThan(0);
  });

  it("login() derives the wrapping key from the server-returned salt and unwraps the real private key", async () => {
    const keyPair = nacl.box.keyPair();
    const salt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey("secret", salt);
    const wrapped = wrapPrivateKey(keyPair.secretKey, wrappingKey);

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/login")) {
        return new Response(
          JSON.stringify({
            userId: "u1",
            username: "grace",
            name: "Grace",
            email: "grace@example.com",
            emailVerified: false,
            publicKey: encodeBase64(keyPair.publicKey),
            passwordSalt: salt,
            passwordWrappedPrivateKey: wrapped,
            totpEnabled: false,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.login("grace@example.com", "secret");
    });

    expect(result.current.user?.keyPair?.publicKey).toEqual(keyPair.publicKey);
  });

  it("login() reports requiresTotp instead of throwing when the server asks for a code", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/login")) {
        return new Response(JSON.stringify({ error: "TOTP code required", requiresTotp: true }), { status: 401 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    let outcome: { requiresTotp: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.login("grace@example.com", "secret");
    });

    expect(outcome?.requiresTotp).toBe(true);
    expect(result.current.user).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- useAuth`
Expected: FAIL — `./useAuth` module not found.

- [ ] **Step 3: Write `apps/web/src/hooks/useAuth.tsx`**

```tsx
// apps/web/src/hooks/useAuth.tsx
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import type { LoginResponse, MeResponse, RegisterResponse } from "@e2ee-drop/shared";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  generateRecoveryCode,
  deriveRecoveryKey,
} from "@/lib/keyWrapping";

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  email: string;
  emailVerified: boolean;
  publicKey: string;
  totpEnabled: boolean;
  keyPair: nacl.BoxKeyPair | null;
}

export interface RegisterInput {
  email: string;
  username: string;
  name: string;
  password: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  login: (email: string, password: string, totpCode?: string) => Promise<{ requiresTotp: boolean }>;
  logout: () => Promise<void>;
  register: (input: RegisterInput) => Promise<{ recoveryCode: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? (res.json() as Promise<MeResponse>) : null))
      .then((data) => {
        if (!data) return;
        setUser({
          id: data.userId,
          username: data.username,
          name: data.name,
          email: data.email,
          emailVerified: data.emailVerified,
          publicKey: data.publicKey,
          totpEnabled: data.totpEnabled,
          keyPair: null,
        });
      })
      .catch(() => undefined);
  }, []);

  const register = useCallback(async (input: RegisterInput): Promise<{ recoveryCode: string }> => {
    const keyPair = nacl.box.keyPair();
    const passwordSalt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey(input.password, passwordSalt);
    const passwordWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, wrappingKey);

    const recoveryCode = generateRecoveryCode();
    const recoveryWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));

    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        username: input.username,
        name: input.name,
        password: input.password,
        passwordSalt,
        passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey,
        publicKey: encodeBase64(keyPair.publicKey),
      }),
    });
    if (!response.ok) throw new Error("Registration failed");
    const body: RegisterResponse = await response.json();

    setUser({
      id: body.userId,
      username: body.username,
      name: input.name,
      email: input.email,
      emailVerified: false,
      publicKey: encodeBase64(keyPair.publicKey),
      totpEnabled: false,
      keyPair,
    });

    return { recoveryCode };
  }, []);

  const login = useCallback(
    async (email: string, password: string, totpCode?: string): Promise<{ requiresTotp: boolean }> => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, totpCode }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.requiresTotp) return { requiresTotp: true };
        throw new Error(body.error ?? "Login failed");
      }
      const loginBody = body as LoginResponse;
      const wrappingKey = await deriveWrappingKey(password, loginBody.passwordSalt);
      const secretKey = unwrapPrivateKey(loginBody.passwordWrappedPrivateKey, wrappingKey);
      const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);

      setUser({
        id: loginBody.userId,
        username: loginBody.username,
        name: loginBody.name,
        email: loginBody.email,
        emailVerified: loginBody.emailVerified,
        publicKey: loginBody.publicKey,
        totpEnabled: loginBody.totpEnabled,
        keyPair,
      });

      return { requiresTotp: false };
    },
    []
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, login, logout, register }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
```

- [ ] **Step 4: Wrap the app in `AuthProvider` — modify `apps/web/src/App.tsx`**

```tsx
// apps/web/src/App.tsx
import { Routes, Route } from "react-router-dom";
import { HomePage } from "@/components/HomePage";
import { CreateLinkPage } from "@/components/CreateLinkPage";
import { UploadPage } from "@/components/UploadPage";
import { DownloadPage } from "@/components/DownloadPage";
import { RegisterPage } from "@/components/RegisterPage";
import { LoginPage } from "@/components/LoginPage";
import { RequestPasswordResetPage } from "@/components/RequestPasswordResetPage";
import { ConfirmPasswordResetPage } from "@/components/ConfirmPasswordResetPage";
import { AuthProvider } from "@/hooks/useAuth";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreateLinkPage />} />
        <Route path="/send/:slug" element={<UploadPage />} />
        <Route path="/download/:slug" element={<DownloadPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<RequestPasswordResetPage />} />
        <Route path="/reset-password/confirm" element={<ConfirmPasswordResetPage />} />
      </Routes>
    </AuthProvider>
  );
}
```

(`RegisterPage`, `LoginPage`, `RequestPasswordResetPage`, `ConfirmPasswordResetPage` are created by Tasks 14 and 15 — this `App.tsx` edit is finished once those files exist; if run before them, the app fails to build until Tasks 14/15 land, which is expected since they're in the same wave and reviewed together.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- useAuth`
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hooks/useAuth.tsx apps/web/src/hooks/useAuth.test.tsx apps/web/src/App.tsx
git commit -m "feat(web): add useAuth hook with client-side key wrapping/unwrapping"
```

### Task 14: Register and login pages

**Files:**
- Create: `apps/web/src/components/RegisterPage.tsx`
- Create: `apps/web/src/components/LoginPage.tsx`
- Create: `apps/web/src/locales/en/auth.json`, `apps/web/src/locales/nb/auth.json`
- Modify: `apps/web/package.json` (adds `@testing-library/user-event` devDependency)
- Test: `apps/web/src/components/RegisterPage.test.tsx`
- Test: `apps/web/src/components/LoginPage.test.tsx`

**Interfaces:**
- Consumes: `useAuth` from `@/hooks/useAuth` (Task 13).
- Produces: `<RegisterPage />`, `<LoginPage />`, routed at `/register` and `/login` by Task 13's `App.tsx` edit.

- [ ] **Step 1: Write locale files**

```json
// apps/web/src/locales/en/auth.json
{
  "register": {
    "title": "Create an account",
    "email": "Email",
    "username": "Username",
    "name": "Display name",
    "password": "Password",
    "submit": "Create account",
    "recoveryTitle": "Save your recovery code",
    "recoveryWarning": "This code is the only way to reset your password without losing access to files waiting for you. It is shown once and never stored anywhere retrievable.",
    "recoveryConfirm": "I've saved my recovery code",
    "errors": { "failed": "Registration failed. Please try again." }
  },
  "login": {
    "title": "Log in",
    "email": "Email",
    "password": "Password",
    "totpCode": "6-digit code",
    "submit": "Log in",
    "errors": { "invalid": "Invalid email or password.", "invalidTotp": "Invalid code." }
  }
}
```

```json
// apps/web/src/locales/nb/auth.json
{
  "register": {
    "title": "Opprett konto",
    "email": "E-post",
    "username": "Brukernavn",
    "name": "Visningsnavn",
    "password": "Passord",
    "submit": "Opprett konto",
    "recoveryTitle": "Lagre gjenopprettingskoden din",
    "recoveryWarning": "Denne koden er eneste måte å tilbakestille passordet uten å miste tilgang til filer som venter på deg. Den vises kun én gang og lagres aldri noe sted den kan hentes fra igjen.",
    "recoveryConfirm": "Jeg har lagret gjenopprettingskoden",
    "errors": { "failed": "Registrering feilet. Prøv igjen." }
  },
  "login": {
    "title": "Logg inn",
    "email": "E-post",
    "password": "Passord",
    "totpCode": "6-sifret kode",
    "submit": "Logg inn",
    "errors": { "invalid": "Ugyldig e-post eller passord.", "invalidTotp": "Ugyldig kode." }
  }
}
```

- [ ] **Step 2: Write the failing tests**

```tsx
// apps/web/src/components/RegisterPage.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const registerMock = vi.fn().mockResolvedValue({ recoveryCode: "ABCD1234EFGH5678IJKL" });
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null, register: registerMock, login: vi.fn(), logout: vi.fn() }) }));

import { RegisterPage } from "./RegisterPage";

describe("RegisterPage", () => {
  it("shows the recovery code once registration succeeds", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText(/email/i), "h@example.com");
    await user.type(screen.getByLabelText(/username/i), "hank");
    await user.type(screen.getByLabelText(/display name/i), "Hank");
    await user.type(screen.getByLabelText(/^password/i), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("ABCD1234EFGH5678IJKL")).toBeInTheDocument();
    });
    expect(registerMock).toHaveBeenCalledWith({
      email: "h@example.com",
      username: "hank",
      name: "Hank",
      password: "correct horse battery staple",
    });
  });
});
```

```tsx
// apps/web/src/components/LoginPage.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const loginMock = vi.fn().mockResolvedValue({ requiresTotp: true });
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null, login: loginMock, register: vi.fn(), logout: vi.fn() }) }));

import { LoginPage } from "./LoginPage";

describe("LoginPage", () => {
  it("shows a TOTP field after the server asks for a code", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText(/email/i), "grace@example.com");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @e2ee-drop/web add -D @testing-library/user-event@^14.5.2 && pnpm --filter @e2ee-drop/web test -- RegisterPage LoginPage`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write `apps/web/src/components/RegisterPage.tsx`**

```tsx
// apps/web/src/components/RegisterPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import authEn from "@/locales/en/auth.json";
import authNb from "@/locales/nb/auth.json";

i18n.addResourceBundle("en", "auth", authEn, true, false);
i18n.addResourceBundle("nb", "auth", authNb, true, false);

export function RegisterPage() {
  const { t } = useTranslation("auth");
  const { register } = useAuth();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { recoveryCode: code } = await register({ email, username, name, password });
      setRecoveryCode(code);
    } catch {
      setError(t("register.errors.failed"));
    }
  };

  if (recoveryCode && !confirmed) {
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardHeader>
          <CardTitle>{t("register.recoveryTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{t("register.recoveryWarning")}</AlertDescription>
          </Alert>
          <p className="break-all rounded bg-muted p-2 font-mono text-sm">{recoveryCode}</p>
          <Button onClick={() => setConfirmed(true)}>{t("register.recoveryConfirm")}</Button>
        </CardContent>
      </Card>
    );
  }

  if (confirmed) return <p>{t("register.title")} ✓</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("register.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && <p role="alert">{error}</p>}
          <div>
            <label htmlFor="email">{t("register.email")}</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded border p-2" />
          </div>
          <div>
            <label htmlFor="username">{t("register.username")}</label>
            <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full rounded border p-2" />
          </div>
          <div>
            <label htmlFor="name">{t("register.name")}</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border p-2" />
          </div>
          <div>
            <label htmlFor="password">{t("register.password")}</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded border p-2" />
          </div>
          <Button type="submit">{t("register.submit")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Write `apps/web/src/components/LoginPage.tsx`**

```tsx
// apps/web/src/components/LoginPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import authEn from "@/locales/en/auth.json";
import authNb from "@/locales/nb/auth.json";

i18n.addResourceBundle("en", "auth", authEn, true, false);
i18n.addResourceBundle("nb", "auth", authNb, true, false);

export function LoginPage() {
  const { t } = useTranslation("auth");
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await login(email, password, needsTotp ? totpCode : undefined);
      if (result.requiresTotp) {
        setNeedsTotp(true);
        return;
      }
      setDone(true);
    } catch {
      setError(needsTotp ? t("login.errors.invalidTotp") : t("login.errors.invalid"));
    }
  };

  if (done) return <p>{t("login.title")} ✓</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("login.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && <p role="alert">{error}</p>}
          <div>
            <label htmlFor="login-email">{t("login.email")}</label>
            <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded border p-2" />
          </div>
          <div>
            <label htmlFor="login-password">{t("login.password")}</label>
            <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded border p-2" />
          </div>
          {needsTotp && (
            <div>
              <label htmlFor="login-totp">{t("login.totpCode")}</label>
              <input id="login-totp" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} className="w-full rounded border p-2" />
            </div>
          )}
          <Button type="submit">{t("login.submit")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @e2ee-drop/web test -- RegisterPage LoginPage`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/RegisterPage.tsx apps/web/src/components/RegisterPage.test.tsx apps/web/src/components/LoginPage.tsx apps/web/src/components/LoginPage.test.tsx apps/web/src/locales/en/auth.json apps/web/src/locales/nb/auth.json apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add register and login pages, including one-time recovery code display"
```

### Task 15: Password reset pages

**Files:**
- Create: `apps/web/src/components/RequestPasswordResetPage.tsx`
- Create: `apps/web/src/components/ConfirmPasswordResetPage.tsx`
- Create: `apps/web/src/locales/en/passwordReset.json`, `apps/web/src/locales/nb/passwordReset.json`
- Test: `apps/web/src/components/ConfirmPasswordResetPage.test.tsx`

**Interfaces:**
- Consumes: `generateWrappingSalt`, `deriveWrappingKey`, `wrapPrivateKey`, `unwrapPrivateKey`, `deriveRecoveryKey`, `generateRecoveryCode` from `@/lib/keyWrapping` (Task 4); talks to `POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/verify-token`, `POST /api/auth/password-reset/complete`, `POST /api/auth/password-reset/complete-fresh` (Task 11) over `fetch`.
- Produces: `<RequestPasswordResetPage />` (routed at `/reset-password`), `<ConfirmPasswordResetPage />` (routed at `/reset-password/confirm?token=...` by Task 13's `App.tsx` edit).

- [ ] **Step 1: Write locale files**

```json
// apps/web/src/locales/en/passwordReset.json
{
  "request": { "title": "Reset your password", "email": "Email", "submit": "Send reset link", "sent": "If that email is registered, a reset link has been sent." },
  "confirm": {
    "title": "Choose a new password",
    "recoveryCode": "Recovery code",
    "recoveryHelp": "Enter the recovery code you saved at registration to keep access to files already waiting for you.",
    "newPassword": "New password",
    "submitWithRecovery": "Reset with recovery code",
    "noRecovery": "I don't have my recovery code",
    "freshWarning": "Without your recovery code, any links and files waiting for you cannot be recovered. Continuing creates a brand-new key and permanently deletes them.",
    "submitFresh": "Start fresh and reset password",
    "success": "Your password has been reset.",
    "errors": { "invalidToken": "This reset link is invalid or has expired.", "wrongRecoveryCode": "That recovery code doesn't match this account." }
  }
}
```

```json
// apps/web/src/locales/nb/passwordReset.json
{
  "request": { "title": "Tilbakestill passordet ditt", "email": "E-post", "submit": "Send tilbakestillingslenke", "sent": "Hvis denne e-posten er registrert, er det sendt en lenke." },
  "confirm": {
    "title": "Velg et nytt passord",
    "recoveryCode": "Gjenopprettingskode",
    "recoveryHelp": "Skriv inn gjenopprettingskoden du lagret ved registrering for å beholde tilgang til filer som allerede venter på deg.",
    "newPassword": "Nytt passord",
    "submitWithRecovery": "Tilbakestill med gjenopprettingskode",
    "noRecovery": "Jeg har ikke gjenopprettingskoden",
    "freshWarning": "Uten gjenopprettingskoden kan ikke lenker og filer som venter på deg gjenopprettes. Å fortsette oppretter en helt ny nøkkel og sletter dem permanent.",
    "submitFresh": "Start på nytt og tilbakestill passord",
    "success": "Passordet ditt er tilbakestilt.",
    "errors": { "invalidToken": "Denne tilbakestillingslenken er ugyldig eller utløpt.", "wrongRecoveryCode": "Den gjenopprettingskoden stemmer ikke med denne kontoen." }
  }
}
```

- [ ] **Step 2: Write `apps/web/src/components/RequestPasswordResetPage.tsx`**

```tsx
// apps/web/src/components/RequestPasswordResetPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import passwordResetEn from "@/locales/en/passwordReset.json";
import passwordResetNb from "@/locales/nb/passwordReset.json";

i18n.addResourceBundle("en", "passwordReset", passwordResetEn, true, false);
i18n.addResourceBundle("nb", "passwordReset", passwordResetNb, true, false);

export function RequestPasswordResetPage() {
  const { t } = useTranslation("passwordReset");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSent(true);
  };

  if (sent) return <p>{t("request.sent")}</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("request.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="reset-email">{t("request.email")}</label>
            <input id="reset-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded border p-2" />
          </div>
          <Button type="submit">{t("request.submit")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Write the failing test for `ConfirmPasswordResetPage`**

```tsx
// apps/web/src/components/ConfirmPasswordResetPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { generateWrappingSalt, wrapPrivateKey, generateRecoveryCode, deriveRecoveryKey } from "@/lib/keyWrapping";

import { ConfirmPasswordResetPage } from "./ConfirmPasswordResetPage";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password/confirm" element={<ConfirmPasswordResetPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ConfirmPasswordResetPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resets with a correct recovery code without warning about data loss", async () => {
    const keyPair = nacl.box.keyPair();
    const recoveryCode = generateRecoveryCode();
    const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
    const salt = generateWrappingSalt();

    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "i@example.com", passwordSalt: salt, recoveryWrappedPrivateKey: recoveryWrapped }),
          { status: 200 }
        );
      }
      if (url.includes("/complete") && !url.includes("fresh")) {
        return new Response(JSON.stringify({ reset: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");

    await waitFor(() => screen.getByLabelText(/recovery code/i));
    await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
    await user.type(screen.getByLabelText(/new password/i), "a brand new password");
    await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));

    await waitFor(() => {
      expect(screen.getByText(/password has been reset/i)).toBeInTheDocument();
    });
    expect(encodeBase64(keyPair.publicKey)).toBeTruthy(); // sanity: the key pair used above is valid
  });

  it("shows the data-loss warning and calls complete-fresh when the user has no recovery code", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "j@example.com", passwordSalt: "c2FsdA==", recoveryWrappedPrivateKey: "d2FzdGVk" }),
          { status: 200 }
        );
      }
      if (url.includes("complete-fresh")) {
        return new Response(JSON.stringify({ reset: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");

    await waitFor(() => screen.getByRole("button", { name: /don't have my recovery code/i }));
    await user.click(screen.getByRole("button", { name: /don't have my recovery code/i }));

    expect(screen.getByText(/cannot be recovered/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/new password/i), "a brand new password");
    await user.click(screen.getByRole("button", { name: /start fresh and reset password/i }));

    await waitFor(() => {
      expect(screen.getByText(/password has been reset/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- ConfirmPasswordResetPage`
Expected: FAIL — `./ConfirmPasswordResetPage` module not found.

- [ ] **Step 5: Write `apps/web/src/components/ConfirmPasswordResetPage.tsx`**

```tsx
// apps/web/src/components/ConfirmPasswordResetPage.tsx
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  deriveRecoveryKey,
  generateRecoveryCode,
} from "@/lib/keyWrapping";
import i18n from "@/i18n";
import passwordResetEn from "@/locales/en/passwordReset.json";
import passwordResetNb from "@/locales/nb/passwordReset.json";

i18n.addResourceBundle("en", "passwordReset", passwordResetEn, true, false);
i18n.addResourceBundle("nb", "passwordReset", passwordResetNb, true, false);

interface VerifyTokenInfo {
  passwordSalt: string;
  recoveryWrappedPrivateKey: string;
}

export function ConfirmPasswordResetPage() {
  const { t } = useTranslation("passwordReset");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [info, setInfo] = useState<VerifyTokenInfo | null>(null);
  const [invalidToken, setInvalidToken] = useState(false);
  const [noRecovery, setNoRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/auth/password-reset/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setInfo)
      .catch(() => setInvalidToken(true));
  }, [token]);

  const handleRecoverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!info) return;
    setError(null);
    try {
      const recoveryKey = deriveRecoveryKey(recoveryCode);
      const privateKey = unwrapPrivateKey(info.recoveryWrappedPrivateKey, recoveryKey);
      const newSalt = generateWrappingSalt();
      const newWrappingKey = await deriveWrappingKey(newPassword, newSalt);
      const newPasswordWrappedPrivateKey = wrapPrivateKey(privateKey, newWrappingKey);

      const response = await fetch("/api/auth/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          newPassword,
          newPasswordSalt: newSalt,
          newPasswordWrappedPrivateKey,
        }),
      });
      if (!response.ok) throw new Error("reset failed");
      setDone(true);
    } catch {
      setError(t("confirm.errors.wrongRecoveryCode"));
    }
  };

  const handleFreshSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const keyPair = nacl.box.keyPair();
    const newSalt = generateWrappingSalt();
    const newWrappingKey = await deriveWrappingKey(newPassword, newSalt);
    const newPasswordWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, newWrappingKey);
    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(newRecoveryCode));

    const response = await fetch("/api/auth/password-reset/complete-fresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        newPassword,
        newPasswordSalt: newSalt,
        newPasswordWrappedPrivateKey,
        newRecoveryWrappedPrivateKey,
        newPublicKey: encodeBase64(keyPair.publicKey),
      }),
    });
    if (!response.ok) return setError(t("confirm.errors.invalidToken"));
    setDone(true);
  };

  if (invalidToken) return <p role="alert">{t("confirm.errors.invalidToken")}</p>;
  if (done) return <p>{t("confirm.success")}</p>;
  if (!info) return <p>…</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("confirm.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {!noRecovery && (
          <form className="space-y-4" onSubmit={handleRecoverySubmit}>
            <p>{t("confirm.recoveryHelp")}</p>
            <div>
              <label htmlFor="recovery-code">{t("confirm.recoveryCode")}</label>
              <input id="recovery-code" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} className="w-full rounded border p-2" />
            </div>
            <div>
              <label htmlFor="new-password">{t("confirm.newPassword")}</label>
              <input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full rounded border p-2" />
            </div>
            <Button type="submit">{t("confirm.submitWithRecovery")}</Button>
            <Button type="button" variant="ghost" onClick={() => setNoRecovery(true)}>
              {t("confirm.noRecovery")}
            </Button>
          </form>
        )}
        {noRecovery && (
          <form className="space-y-4" onSubmit={handleFreshSubmit}>
            <Alert variant="destructive">
              <AlertDescription>{t("confirm.freshWarning")}</AlertDescription>
            </Alert>
            <div>
              <label htmlFor="fresh-new-password">{t("confirm.newPassword")}</label>
              <input id="fresh-new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full rounded border p-2" />
            </div>
            <Button type="submit">{t("confirm.submitFresh")}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- ConfirmPasswordResetPage`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/RequestPasswordResetPage.tsx apps/web/src/components/ConfirmPasswordResetPage.tsx apps/web/src/components/ConfirmPasswordResetPage.test.tsx apps/web/src/locales/en/passwordReset.json apps/web/src/locales/nb/passwordReset.json
git commit -m "feat(web): add password reset pages with recovery-code and fresh-key paths"
```
