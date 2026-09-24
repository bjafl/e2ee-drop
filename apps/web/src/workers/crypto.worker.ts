// apps/web/src/workers/crypto.worker.ts
import { encryptFile, decryptFile } from "../lib/cryptoUtils";

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data;
  if (type === "ping") {
    self.postMessage({ type: "pong" });
    return;
  }
  if (type === "encryptFile") {
    const result = encryptFile(data);
    self.postMessage({ type: "fileEncrypted", data: result }, [result.encrypted.buffer]);
    return;
  }
  if (type === "decryptFile") {
    try {
      const decrypted = decryptFile(data);
      self.postMessage({ type: "fileDecrypted", data: { decrypted } }, [decrypted.buffer]);
    } catch (error) {
      self.postMessage({ type: "decryptError", error: String(error) });
    }
  }
};
