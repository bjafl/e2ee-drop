// apps/web/src/hooks/useFileEncryption.ts
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { useCallback, useEffect, useRef, useState } from "react";
import { encryptFile as encryptFileSyncFn, decryptFile as decryptFileSyncFn } from "@/lib/cryptoUtils";

export interface EncryptedFileResult {
  encrypted: Blob;
  nonce: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  senderPublicKey: string;
  contentMD5: string;
}

export interface DecryptMetadata {
  nonce: string;
  senderPublicKey: string;
  fileName: string;
  mimeType: string;
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

  const encryptFile = useCallback(
    async (file: File, recipientPublicKey: string): Promise<EncryptedFileResult> => {
      if (!keyPair) throw new Error("No local key pair found");
      setIsProcessing(true);
      setProgress(0);
      try {
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        setProgress(30);
        const { encrypted, nonce, originalSize } = encryptFileSyncFn({
          unencrypted: fileBytes,
          recipientPublicKey: decodeBase64(recipientPublicKey),
          senderSecretKey: keyPair.secretKey,
        });
        setProgress(100);
        const md5Hash = nacl.hash(encrypted);
        return {
          encrypted: new Blob([encrypted as BlobPart], { type: "application/octet-stream" }),
          nonce: encodeBase64(nonce),
          fileName: file.name,
          mimeType: file.type,
          fileSize: originalSize,
          senderPublicKey: encodeBase64(keyPair.publicKey),
          contentMD5: encodeBase64(md5Hash),
        };
      } finally {
        setIsProcessing(false);
      }
    },
    [keyPair]
  );

  const decryptFile = useCallback(
    async (encryptedBlob: Blob, metadata: DecryptMetadata): Promise<File> => {
      if (!keyPair) throw new Error("No local key pair found");
      setIsProcessing(true);
      setProgress(0);
      try {
        const encryptedBytes = new Uint8Array(await encryptedBlob.arrayBuffer());
        setProgress(50);
        const decrypted = decryptFileSyncFn({
          encrypted: encryptedBytes,
          nonce: decodeBase64(metadata.nonce),
          senderPublicKey: decodeBase64(metadata.senderPublicKey),
          recipientSecretKey: keyPair.secretKey,
        });
        setProgress(100);
        return new File([decrypted as BlobPart], metadata.fileName, { type: metadata.mimeType });
      } finally {
        setIsProcessing(false);
      }
    },
    [keyPair]
  );

  return { keyPair, setKeyPair, encryptFile, decryptFile, isProcessing, progress };
}
