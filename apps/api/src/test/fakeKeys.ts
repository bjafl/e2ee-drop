// apps/api/src/test/fakeKeys.ts
//
// Deterministic, valid-shaped fake public keys for tests. Routes now reject
// any publicKey/recipientPublicKey/senderPublicKey that doesn't base64-decode
// to exactly 32 bytes (lib/validation.ts) — a placeholder like "k" or
// "${username}-pubkey" no longer passes register/claim/upload-url. This
// derives a real 32-byte value (sha256's output is always exactly 32 bytes)
// from any seed string, so existing tests keep their original intent —
// different seeds still produce different-looking, per-test-deterministic
// keys — while satisfying the new validation.
import { createHash } from "node:crypto";

export function fakePublicKey(seed: string): string {
  return createHash("sha256").update(seed).digest("base64");
}
