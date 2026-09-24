// packages/shared/src/crypto.ts
export interface EncryptedFilePayload {
  encrypted: Uint8Array;
  nonce: Uint8Array;
  originalSize: number;
}

export interface EncryptFileInput {
  unencrypted: Uint8Array;
  recipientPublicKey: Uint8Array;
  senderSecretKey: Uint8Array;
}

export interface DecryptFileInput {
  encrypted: Uint8Array;
  nonce: Uint8Array;
  senderPublicKey: Uint8Array;
  recipientSecretKey: Uint8Array;
}
