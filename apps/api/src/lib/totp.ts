// apps/api/src/lib/totp.ts
//
// TOTP (RFC 6238) generation/verification for 2FA — a pure login gate,
// deliberately separate from the password-derived key-wrapping KDF (see
// apps/web, Task 4). Secrets are encrypted at rest with AES-256-GCM using
// a key derived from env.APP_SECRET_KEY.
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

// NOTE: `usedCodes` is caller-supplied and must be a durable, per-user store
// (e.g. persisted alongside the user's TOTP secret) rather than a fresh
// in-memory Set per request/call — otherwise replay protection only holds
// within a single call and a code could be replayed across separate login
// attempts. Wiring that persistence is not part of this task; see the
// consuming route tasks (9, 10, 12).
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
