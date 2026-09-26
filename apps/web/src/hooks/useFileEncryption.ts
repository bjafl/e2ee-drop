// apps/web/src/hooks/useFileEncryption.ts
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { useCallback, useEffect, useRef, useState } from "react";

export interface SendEnvelopes {
  archiveBlob: Blob;
  archiveNonce: string;
  encryptedMetadata: string;
  metadataNonce: string;
  encryptedMessage: string | null;
  messageNonce: string | null;
  senderPublicKey: string;
  fileSize: number; // cleartext plaintext-zip size, sent alongside for quota checks (design spec §5)
  contentMD5: string;
}

export interface DecryptedMetadata {
  files: { name: string; size: number }[];
  mimeType: string;
}

interface EncryptProgress {
  phase: "zipping" | "encrypting" | "hashing" | "done";
  percent: number;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function useFileEncryption(initialKeyPair?: nacl.BoxKeyPair) {
  const workerRef = useRef<Worker | null>(null);
  const [keyPair, setKeyPair] = useState<nacl.BoxKeyPair | null>(initialKeyPair ?? null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    workerRef.current = new Worker(new URL("../workers/crypto.worker.ts", import.meta.url), {
      type: "module",
    });
    return () => workerRef.current?.terminate();
  }, []);

  const encryptForSend = useCallback(
    (
      files: { name: string; data: Uint8Array }[],
      message: string | null,
      recipientPublicKey: string,
      onProgress?: (p: EncryptProgress) => void
    ): Promise<SendEnvelopes> => {
      if (!keyPair) return Promise.reject(new Error("No local key pair found"));
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error("Crypto worker not ready"));

      setIsProcessing(true);
      setProgress(0);
      return new Promise<SendEnvelopes>((resolve, reject) => {
        const onMessage = (e: MessageEvent) => {
          if (e.data.type === "zipAndEncryptProgress") {
            setProgress(e.data.data.percent);
            onProgress?.(e.data.data);
            return;
          }
          if (e.data.type === "zipAndEncryptError") {
            worker.removeEventListener("message", onMessage);
            setIsProcessing(false);
            reject(new Error(e.data.error));
            return;
          }
          if (e.data.type !== "sendEnvelopesReady") return;
          worker.removeEventListener("message", onMessage);
          setIsProcessing(false);
          const { archive, metadata, message: messagePayload, contentMD5 } = e.data.data;
          resolve({
            archiveBlob: new Blob([archive.encrypted], { type: "application/octet-stream" }),
            archiveNonce: encodeBase64(archive.nonce),
            encryptedMetadata: encodeBase64(metadata.encrypted),
            metadataNonce: encodeBase64(metadata.nonce),
            encryptedMessage: messagePayload ? encodeBase64(messagePayload.encrypted) : null,
            messageNonce: messagePayload ? encodeBase64(messagePayload.nonce) : null,
            senderPublicKey: encodeBase64(keyPair.publicKey),
            fileSize: archive.originalSize,
            contentMD5: encodeBase64(contentMD5),
          });
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({
          type: "zipAndEncrypt",
          data: {
            files,
            message,
            recipientPublicKey: decodeBase64(recipientPublicKey),
            senderSecretKey: keyPair.secretKey,
          },
        });
      }).catch((err) => {
        setIsProcessing(false);
        throw err;
      });
    },
    [keyPair]
  );

  // Shared plumbing for the three decrypt* functions below: post one decryptBytes message, match
  // the response by requestId (multiple decrypts can be in flight from one page — e.g. metadata
  // and message decrypted close together on receiver page load).
  const decryptViaWorker = useCallback(
    (encrypted: Uint8Array, nonce: Uint8Array, senderPublicKey: Uint8Array): Promise<Uint8Array> => {
      if (!keyPair) return Promise.reject(new Error("No local key pair found"));
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error("Crypto worker not ready"));
      const requestId = nextRequestId();
      return new Promise((resolve, reject) => {
        const onMessage = (e: MessageEvent) => {
          if (e.data?.data?.requestId !== requestId) return;
          worker.removeEventListener("message", onMessage);
          if (e.data.type === "decryptError") reject(new Error(e.data.error));
          else resolve(e.data.data.decrypted);
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({
          type: "decryptBytes",
          data: { encrypted, nonce, senderPublicKey, recipientSecretKey: keyPair.secretKey, requestId },
        });
      });
    },
    [keyPair]
  );

  const decryptMetadata = useCallback(
    async (encryptedMetadata: string, metadataNonce: string, senderPublicKey: string): Promise<DecryptedMetadata> => {
      const bytes = await decryptViaWorker(decodeBase64(encryptedMetadata), decodeBase64(metadataNonce), decodeBase64(senderPublicKey));
      return JSON.parse(new TextDecoder().decode(bytes)) as DecryptedMetadata;
    },
    [decryptViaWorker]
  );

  const decryptMessage = useCallback(
    async (encryptedMessage: string, messageNonce: string, senderPublicKey: string): Promise<string> => {
      const bytes = await decryptViaWorker(decodeBase64(encryptedMessage), decodeBase64(messageNonce), decodeBase64(senderPublicKey));
      return new TextDecoder().decode(bytes);
    },
    [decryptViaWorker]
  );

  const decryptArchive = useCallback(
    async (archiveBytes: Uint8Array, archiveNonce: string, senderPublicKey: string): Promise<Uint8Array> => {
      return decryptViaWorker(archiveBytes, decodeBase64(archiveNonce), decodeBase64(senderPublicKey));
    },
    [decryptViaWorker]
  );

  return {
    keyPair,
    setKeyPair,
    encryptForSend,
    decryptMetadata,
    decryptMessage,
    decryptArchive,
    isProcessing,
    progress,
  };
}
