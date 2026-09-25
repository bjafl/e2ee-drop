// apps/web/src/lib/keyWrapping.ts
import { argon2id, createSHA256 } from "hash-wasm";
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

const AUTH_KEY_DOMAIN = "e2ee-drop-auth-key-v1";

// The login credential sent to the server in place of the password. It is a
// SEPARATE Argon2id computation from deriveWrappingKey: same password and
// same cost parameters, but the Argon2id salt is
// sha256(decodedPasswordSalt ++ "e2ee-drop-auth-key-v1") instead of the raw
// passwordSalt. The server knows passwordSalt and receives authKey, but
// cannot invert authKey back to the password, so it can never compute the
// wrapping key (and thus never unwrap passwordWrappedPrivateKey).
export async function deriveAuthKey(password: string, saltB64: string): Promise<string> {
  const saltBytes = decodeBase64(saltB64);
  const domainBytes = new Uint8Array(new TextEncoder().encode(AUTH_KEY_DOMAIN));
  const input = new Uint8Array(saltBytes.length + domainBytes.length);
  input.set(saltBytes);
  input.set(domainBytes, saltBytes.length);
  const hasher = await createSHA256();
  hasher.init();
  hasher.update(input);
  const authSalt = new Uint8Array(hasher.digest("binary"));

  const hash = await argon2id({
    password,
    salt: authSalt,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: "binary",
  });
  return encodeBase64(new Uint8Array(hash));
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
  // Re-wrap in `new Uint8Array(...)` to normalize the realm: some environments
  // (notably jsdom, used in this project's Vitest test environment) implement
  // `TextEncoder` such that it returns a `Uint8Array` whose prototype is from a
  // different realm than the global `Uint8Array`, which fails tweetnacl's
  // `instanceof Uint8Array` checks. This has no effect on the resulting bytes.
  const encoded = new Uint8Array(new TextEncoder().encode(recoveryCode));
  return nacl.hash(encoded).slice(0, 32);
}
