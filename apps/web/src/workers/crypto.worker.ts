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

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === "ping") {
    self.postMessage({ type: "pong" });
    return;
  }

  if (type === "zipAndEncrypt") {
    try {
      const { files, message, recipientPublicKey, senderSecretKey } = data as ZipAndEncryptInput;
      self.postMessage({ type: "zipAndEncryptProgress", data: { phase: "zipping", percent: 0 } });
      const zipped = zipFiles(files);
      self.postMessage({ type: "zipAndEncryptProgress", data: { phase: "encrypting", percent: 40 } });

      const archive = encryptBytes({ unencrypted: zipped, recipientPublicKey, senderSecretKey });
      const metadataJson = JSON.stringify({
        files: files.map((f) => ({ name: f.name, size: f.data.byteLength })),
        mimeType: "application/zip",
      });
      const metadata = encryptBytes({
        unencrypted: new TextEncoder().encode(metadataJson),
        recipientPublicKey,
        senderSecretKey,
      });
      const messagePayload =
        message !== null
          ? encryptBytes({ unencrypted: new TextEncoder().encode(message), recipientPublicKey, senderSecretKey })
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
      const decrypted = decryptBytes(data);
      self.postMessage({ type: "bytesDecrypted", data: { decrypted, requestId: data.requestId } }, [decrypted.buffer]);
    } catch (error) {
      self.postMessage({ type: "decryptError", error: String(error), data: { requestId: data.requestId } });
    }
  }
};
