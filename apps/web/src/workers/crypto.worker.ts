// apps/web/src/workers/crypto.worker.ts
/// <reference lib="webworker" />
import nacl from "tweetnacl";
import { encryptBytes, decryptBytes, zipFiles } from "../lib/cryptoUtils";

declare const self: DedicatedWorkerGlobalScope;

interface ZipAndEncryptInput {
  files: { name: string; data: Uint8Array }[];
  message: string | null;
  recipientPublicKey: Uint8Array;
  senderSecretKey: Uint8Array;
}

// Structured-clone (or a test-environment polyfill of it) is responsible for reconstructing
// typed arrays that cross the postMessage boundary as instances of *this* realm's Uint8Array.
// Real browsers' native structured clone always does this correctly. Some test runners' worker
// polyfills (e.g. @vitest/web-worker under vitest+jsdom) hand the worker a Uint8Array-shaped
// object built against a different realm's Uint8Array constructor, which fails tweetnacl's
// strict `instanceof Uint8Array` checks even though the bytes are correct. Re-wrapping with
// `Uint8Array.from` is a no-op when the input is already same-realm, so this is safe in
// production and only matters for that test scenario.
function toLocalUint8Array(bytes: Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === "ping") {
    self.postMessage({ type: "pong" });
    return;
  }

  if (type === "zipAndEncrypt") {
    try {
      const { files, message, recipientPublicKey, senderSecretKey } = data as ZipAndEncryptInput;
      const localFiles = files.map((f) => ({ name: f.name, data: toLocalUint8Array(f.data) }));
      const localRecipientPublicKey = toLocalUint8Array(recipientPublicKey);
      const localSenderSecretKey = toLocalUint8Array(senderSecretKey);
      self.postMessage({ type: "zipAndEncryptProgress", data: { phase: "zipping", percent: 0 } });
      const zipped = zipFiles(localFiles);
      self.postMessage({ type: "zipAndEncryptProgress", data: { phase: "encrypting", percent: 40 } });

      const archive = encryptBytes({
        unencrypted: zipped,
        recipientPublicKey: localRecipientPublicKey,
        senderSecretKey: localSenderSecretKey,
      });
      const metadataJson = JSON.stringify({
        files: localFiles.map((f) => ({ name: f.name, size: f.data.byteLength })),
        mimeType: "application/zip",
      });
      const metadata = encryptBytes({
        unencrypted: toLocalUint8Array(new TextEncoder().encode(metadataJson)),
        recipientPublicKey: localRecipientPublicKey,
        senderSecretKey: localSenderSecretKey,
      });
      const messagePayload =
        message !== null
          ? encryptBytes({
              unencrypted: toLocalUint8Array(new TextEncoder().encode(message)),
              recipientPublicKey: localRecipientPublicKey,
              senderSecretKey: localSenderSecretKey,
            })
          : null;

      self.postMessage({ type: "zipAndEncryptProgress", data: { phase: "hashing", percent: 90 } });
      const contentMD5 = nacl.hash(archive.encrypted);

      self.postMessage({ type: "zipAndEncryptProgress", data: { phase: "done", percent: 100 } });
      const transferables = [archive.encrypted.buffer, metadata.encrypted.buffer];
      if (messagePayload) transferables.push(messagePayload.encrypted.buffer);
      self.postMessage(
        {
          type: "sendEnvelopesReady",
          data: {
            archive: { encrypted: archive.encrypted, nonce: archive.nonce, originalSize: archive.originalSize },
            metadata: { encrypted: metadata.encrypted, nonce: metadata.nonce },
            message: messagePayload ? { encrypted: messagePayload.encrypted, nonce: messagePayload.nonce } : null,
            contentMD5,
          },
        },
        transferables
      );
    } catch (error) {
      self.postMessage({ type: "zipAndEncryptError", error: String(error) });
    }
    return;
  }

  if (type === "decryptBytes") {
    try {
      const decrypted = decryptBytes({
        encrypted: toLocalUint8Array(data.encrypted),
        nonce: toLocalUint8Array(data.nonce),
        senderPublicKey: toLocalUint8Array(data.senderPublicKey),
        recipientSecretKey: toLocalUint8Array(data.recipientSecretKey),
      });
      self.postMessage({ type: "bytesDecrypted", data: { decrypted, requestId: data.requestId } }, [decrypted.buffer]);
    } catch (error) {
      self.postMessage({ type: "decryptError", error: String(error), data: { requestId: data.requestId } });
    }
  }
};
