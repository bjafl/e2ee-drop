// apps/web/src/lib/cryptoUtils.test.ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { encryptBytes, decryptBytes, zipFiles } from "./cryptoUtils";
import { unzipSync } from "fflate";

describe("encryptBytes/decryptBytes", () => {
  it("round-trips arbitrary bytes", () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const plaintext = new TextEncoder().encode("hello");
    const { encrypted, nonce } = encryptBytes({
      unencrypted: plaintext,
      recipientPublicKey: recipient.publicKey,
      senderSecretKey: sender.secretKey,
    });
    const decrypted = decryptBytes({
      encrypted,
      nonce,
      senderPublicKey: sender.publicKey,
      recipientSecretKey: recipient.secretKey,
    });
    expect(new TextDecoder().decode(decrypted)).toBe("hello");
  });

  it("fails to decrypt with the wrong sender public key (tamper/impersonation check)", () => {
    const sender = nacl.box.keyPair();
    const impostor = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const { encrypted, nonce } = encryptBytes({
      unencrypted: new TextEncoder().encode("hello"),
      recipientPublicKey: recipient.publicKey,
      senderSecretKey: sender.secretKey,
    });
    expect(() =>
      decryptBytes({ encrypted, nonce, senderPublicKey: impostor.publicKey, recipientSecretKey: recipient.secretKey })
    ).toThrow();
  });
});

describe("zipFiles", () => {
  it("produces a zip whose entries round-trip through fflate's own unzipSync", () => {
    const zipped = zipFiles([
      { name: "a.txt", data: new TextEncoder().encode("A") },
      { name: "b.txt", data: new TextEncoder().encode("B") },
    ]);
    const entries = unzipSync(zipped);
    expect(new TextDecoder().decode(entries["a.txt"])).toBe("A");
    expect(new TextDecoder().decode(entries["b.txt"])).toBe("B");
  });

  it("de-duplicates same-named files instead of silently colliding", () => {
    const zipped = zipFiles([
      { name: "report.pdf", data: new TextEncoder().encode("first") },
      { name: "report.pdf", data: new TextEncoder().encode("second") },
    ]);
    const entries = unzipSync(zipped);
    expect(Object.keys(entries)).toEqual(["report.pdf", "report (1).pdf"]);
  });
});
