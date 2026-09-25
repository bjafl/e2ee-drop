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
