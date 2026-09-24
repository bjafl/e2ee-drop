// apps/web/src/lib/cryptoUtils.ts
import nacl from "tweetnacl";
import type { EncryptFileInput, DecryptFileInput, EncryptedFilePayload } from "@e2ee-drop/shared";

export function encryptFile({
  unencrypted,
  recipientPublicKey,
  senderSecretKey,
}: EncryptFileInput): EncryptedFilePayload {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(unencrypted, nonce, recipientPublicKey, senderSecretKey);
  return { encrypted, nonce, originalSize: unencrypted.length };
}

export function decryptFile({
  encrypted,
  nonce,
  senderPublicKey,
  recipientSecretKey,
}: DecryptFileInput): Uint8Array {
  const decrypted = nacl.box.open(encrypted, nonce, senderPublicKey, recipientSecretKey);
  if (!decrypted) throw new Error("Decryption failed");
  return decrypted;
}
