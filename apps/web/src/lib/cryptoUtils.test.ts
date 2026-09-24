// apps/web/src/lib/cryptoUtils.test.ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { encryptFile, decryptFile } from "./cryptoUtils";

describe("cryptoUtils", () => {
  it("round-trips a message through encrypt then decrypt", () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const message = new TextEncoder().encode("hello e2ee-drop");

    const { encrypted, nonce } = encryptFile({
      unencrypted: message,
      recipientPublicKey: recipient.publicKey,
      senderSecretKey: sender.secretKey,
    });

    const decrypted = decryptFile({
      encrypted,
      nonce,
      senderPublicKey: sender.publicKey,
      recipientSecretKey: recipient.secretKey,
    });

    expect(new TextDecoder().decode(decrypted)).toBe("hello e2ee-drop");
  });

  it("throws when decrypting with the wrong key", () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const wrongRecipient = nacl.box.keyPair();
    const message = new TextEncoder().encode("secret");

    const { encrypted, nonce } = encryptFile({
      unencrypted: message,
      recipientPublicKey: recipient.publicKey,
      senderSecretKey: sender.secretKey,
    });

    expect(() =>
      decryptFile({
        encrypted,
        nonce,
        senderPublicKey: sender.publicKey,
        recipientSecretKey: wrongRecipient.secretKey,
      })
    ).toThrow("Decryption failed");
  });
});
