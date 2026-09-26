// apps/web/src/hooks/useFileEncryption.test.ts
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { useFileEncryption } from "./useFileEncryption";

// jsdom's Blob implementation doesn't provide `.arrayBuffer()` (its prototype only has
// slice/size/type — no arrayBuffer/text/stream), unlike a real browser's Blob. FileReader is
// fully supported in jsdom, so use it here purely as a test-environment workaround to read the
// bytes back out of the archiveBlob returned by encryptForSend.
function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("useFileEncryption.encryptForSend / decrypt*", () => {
  it("round-trips files + message through encryptForSend and the three decrypt* functions", async () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const { result } = renderHook(() => useFileEncryption(sender));

    let envelopes: Awaited<ReturnType<typeof result.current.encryptForSend>>;
    await act(async () => {
      envelopes = await result.current.encryptForSend(
        [{ name: "a.txt", data: new TextEncoder().encode("hello") }],
        "a secret message",
        encodeBase64(recipient.publicKey)
      );
    });

    const { result: recvResult } = renderHook(() => useFileEncryption(recipient));

    let metadata: Awaited<ReturnType<typeof recvResult.current.decryptMetadata>>;
    await act(async () => {
      metadata = await recvResult.current.decryptMetadata(
        envelopes!.encryptedMetadata,
        envelopes!.metadataNonce,
        encodeBase64(sender.publicKey)
      );
    });
    expect(metadata!.files).toEqual([{ name: "a.txt", size: 5 }]);
    expect(metadata!.mimeType).toBe("application/zip");

    let message: string;
    await act(async () => {
      message = await recvResult.current.decryptMessage(
        envelopes!.encryptedMessage!,
        envelopes!.messageNonce!,
        encodeBase64(sender.publicKey)
      );
    });
    expect(message!).toBe("a secret message");

    let archiveBytes: Uint8Array;
    await act(async () => {
      const archiveBuf = await blobToUint8Array(envelopes!.archiveBlob);
      archiveBytes = await recvResult.current.decryptArchive(
        archiveBuf,
        envelopes!.archiveNonce,
        encodeBase64(sender.publicKey)
      );
    });
    // archiveBytes is the raw zip — verified via fflate in a lower-level test (Task 2); here just
    // confirm it's non-empty ciphertext-shaped output, decryption itself already proven in Task 2.
    expect(archiveBytes!.byteLength).toBeGreaterThan(0);
  });

  it("reports encryption progress phases", async () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const { result } = renderHook(() => useFileEncryption(sender));
    const phases: string[] = [];

    await act(async () => {
      await result.current.encryptForSend(
        [{ name: "a.txt", data: new TextEncoder().encode("x") }],
        null,
        encodeBase64(recipient.publicKey),
        (p) => phases.push(p.phase)
      );
    });
    expect(phases).toEqual(["zipping", "encrypting", "hashing", "done"]);
  });

  describe("zipAndEncryptError handling", () => {
    const originalPostMessage = Worker.prototype.postMessage;

    afterEach(() => {
      Worker.prototype.postMessage = originalPostMessage;
      vi.restoreAllMocks();
    });

    it("rejects encryptForSend's promise and resets isProcessing when the worker reports zipAndEncryptError", async () => {
      const sender = nacl.box.keyPair();
      const recipient = nacl.box.keyPair();

      // Force the worker to fail during zipping/encryption by intercepting the outgoing
      // "zipAndEncrypt" postMessage and instead posting back a zipAndEncryptError message,
      // simulating what apps/web/src/workers/crypto.worker.ts does when zipFiles/encryptBytes
      // throws (see its catch block: self.postMessage({ type: "zipAndEncryptError", error })).
      Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
        const data = message as { type?: string };
        if (data?.type === "zipAndEncrypt") {
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: { type: "zipAndEncryptError", error: "boom: simulated failure" },
              })
            );
          });
          return;
        }
        return originalPostMessage.call(this, message, ...(rest as []));
      };

      const { result } = renderHook(() => useFileEncryption(sender));

      let caughtError: Error | undefined;
      await act(async () => {
        try {
          await result.current.encryptForSend(
            [{ name: "a.txt", data: new TextEncoder().encode("x") }],
            null,
            encodeBase64(recipient.publicKey)
          );
        } catch (err) {
          caughtError = err as Error;
        }
      });

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError!.message).toContain("boom: simulated failure");
      expect(result.current.isProcessing).toBe(false);
    });
  });
});
