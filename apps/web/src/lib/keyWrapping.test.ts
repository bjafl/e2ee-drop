// apps/web/src/lib/keyWrapping.test.ts
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";
import { argon2id, sha256 } from "hash-wasm";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  deriveAuthKey,
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

describe("deriveAuthKey", () => {
  it("is deterministic and encodes a 32-byte Argon2id output as base64", async () => {
    const salt = generateWrappingSalt();
    const a = await deriveAuthKey("my-password", salt);
    const b = await deriveAuthKey("my-password", salt);
    expect(a).toBe(b);
    expect(decodeBase64(a)).toHaveLength(32);
  });

  it("matches Argon2id(password, sha256(salt ++ domain)) with the wrapping key's cost parameters", async () => {
    const salt = generateWrappingSalt();
    const saltBytes = decodeBase64(salt);
    const domain = new Uint8Array(new TextEncoder().encode("e2ee-drop-auth-key-v1"));
    const concatenated = new Uint8Array(saltBytes.length + domain.length);
    concatenated.set(saltBytes);
    concatenated.set(domain, saltBytes.length);
    const authSaltHex = await sha256(concatenated);
    const authSalt = new Uint8Array(authSaltHex.match(/../g)!.map((h) => parseInt(h, 16)));
    const expected = await argon2id({
      password: "my-password",
      salt: authSalt,
      iterations: 2,
      memorySize: 19456,
      parallelism: 1,
      hashLength: 32,
      outputType: "binary",
    });

    expect(await deriveAuthKey("my-password", salt)).toBe(encodeBase64(new Uint8Array(expected)));
  });

  it("is not equal to (and not usable as) the wrapping key for the same password and salt", async () => {
    const salt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey("my-password", salt);
    const authKey = await deriveAuthKey("my-password", salt);
    expect(authKey).not.toBe(encodeBase64(wrappingKey));

    const keyPair = nacl.box.keyPair();
    const wrapped = wrapPrivateKey(keyPair.secretKey, wrappingKey);
    expect(() => unwrapPrivateKey(wrapped, decodeBase64(authKey))).toThrow();
  });

  it("differs for different passwords and for different salts", async () => {
    const salt1 = generateWrappingSalt();
    const salt2 = generateWrappingSalt();
    const base = await deriveAuthKey("my-password", salt1);
    expect(await deriveAuthKey("other-password", salt1)).not.toBe(base);
    expect(await deriveAuthKey("my-password", salt2)).not.toBe(base);
  });
});
