# E2EE flow — Plan 3/3: Frontend (crypto, hooks, pages)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the sender and receiver pages against plan 2's API: multi-file zip, three-envelope
encrypt/decrypt, dropzone + explicit send button + anonymous consent, dual progress bars, the claim
flow, owner note, extended badge, optional PIN-protected local keys.

**Architecture:** `crypto.worker.ts`/`cryptoUtils.ts` grow from single-file encrypt/decrypt to
zip+three-envelope encrypt and three independent decrypt operations, still fully off the main
thread. `useFileEncryption.ts` becomes the one hook both pages call for all crypto. Two new small
hooks own byte-level progress (`useXhrUpload` for the PUT, `useStreamedDownload` for the GET +
hash verification) — kept separate from the crypto hook because they talk to `fetch`/`XMLHttpRequest`,
not the worker, and pages compose all three independently.

**Tech Stack:** React 19, `tweetnacl`/`tweetnacl-util` (existing), `fflate` (new),
`react-dropzone` (new), existing shadcn/`@base-ui` components (`ui/progress.tsx`,
`ui/alert-dialog.tsx`), existing `lib/keyWrapping.ts` (argon2id via `hash-wasm`).

**Spec:** `docs/superpowers/specs/2026-09-26-e2ee-send-receive-flow-design.md`

**Plan sequence:** Plan 3 of 3. Requires plan 2 (`2026-09-26-e2ee-flow-2-backend-endpoints.md`)
merged first — every API call below assumes plan 2's endpoint shapes exist.

## Global Constraints

- All crypto (zip, encrypt, decrypt) stays inside `crypto.worker.ts` — never inline it on the main
  thread "just for this one small case"; large files freezing the UI is exactly what the worker
  exists to prevent.
- Every `@base-ui/react`-based shadcn component in this codebase composes via a `render` prop, not
  `asChild` (see `DeleteAccountDialog.tsx`'s inline comment) — new dialog usage must follow the same
  pattern.
- `useLocalLinks.ts`'s existing consumers (`CreateLinkPage.tsx`, `HomePage.tsx`,
  `DownloadPage.tsx`/`ReceivePage.tsx`) must keep working for a link saved *without* a PIN — the PIN
  feature is additive, never a required step.
- No `i18next` string is hardcoded inline — every new user-facing string goes through the existing
  `t()`/locale-bundle pattern each page already uses (see any existing page's
  `i18n.addResourceBundle` calls for the exact pattern to copy).

## Review Focus

- **A file selected, then removed from the dropzone before clicking send**: the send button's
  enabled/disabled state and the worker's zip step must agree on what "no files" means — a
  dropzone library managing its own internal file list separately from the component's own state is
  a classic source of this kind of drift.
- **Multiple files with the same name**: `fflate`'s `Zippable` record is keyed by path/filename — two
  selected files literally named `report.pdf` would silently collide (one overwrites the other in
  the zip) unless de-duplicated before zipping.
- **A PUT that fails partway through** (not just fails to start): `XMLHttpRequest.upload.onprogress`
  reporting < 100% when the request ends in `error`/`abort` must trigger the same `/abandon` call as
  an outright connection failure — a partially-uploaded object is exactly the case `/abandon` exists
  for.
- **Reloading the receiver page after a message has already been revealed**: `hasMessage` will now
  be `false` from the server — the UI must not show a stale "decrypt message" button from
  client-side state left over from before the reload (there shouldn't be any such state, since
  reveal state isn't cached client-side, but a naive implementation could introduce one).
- **A PIN-wrapped local key on a browser that never entered the PIN correctly**: `unwrapPrivateKey`
  throws on a wrong PIN (`lib/keyWrapping.ts`'s existing behavior) — the receive page must surface
  this as a retryable "wrong PIN" state, not an unhandled exception that blanks the page.

---

## Task 1: Add dependencies

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install**

```bash
pnpm --filter @e2ee-drop/web add fflate react-dropzone
```

- [ ] **Step 2: Verify**

```bash
grep -n "\"fflate\"\|\"react-dropzone\"" apps/web/package.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add fflate and react-dropzone"
```

## Task 2: `cryptoUtils.ts` — generic byte encrypt/decrypt + zip helpers

**Files:**
- Modify: `apps/web/src/lib/cryptoUtils.ts`
- Test: `apps/web/src/lib/cryptoUtils.test.ts` (create if it doesn't exist)

**Interfaces:**
- Produces: `encryptBytes`/`decryptBytes` (renamed from `encryptFile`/`decryptFile` — the same two
  functions, since they never actually cared what the bytes represented; used for all three
  envelopes now, not just the archive), `zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array`.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/lib/cryptoUtils.test.ts
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/lib/cryptoUtils.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/lib/cryptoUtils.ts
import nacl from "tweetnacl";
import { zipSync, type Zippable } from "fflate";
import type { EncryptFileInput, DecryptFileInput, EncryptedFilePayload } from "@e2ee-drop/shared";

// Renamed from encryptFile/decryptFile: these never inspected what the bytes represented, and the
// three-envelope design (message, metadata, archive — design spec §3.1) now uses the same two
// functions for all three, not just the file archive.
export function encryptBytes({ unencrypted, recipientPublicKey, senderSecretKey }: EncryptFileInput): EncryptedFilePayload {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(unencrypted, nonce, recipientPublicKey, senderSecretKey);
  return { encrypted, nonce, originalSize: unencrypted.length };
}

export function decryptBytes({ encrypted, nonce, senderPublicKey, recipientSecretKey }: DecryptFileInput): Uint8Array {
  const decrypted = nacl.box.open(encrypted, nonce, senderPublicKey, recipientSecretKey);
  if (!decrypted) throw new Error("Decryption failed");
  return decrypted;
}

// Splits "name.ext" into base/extension so a collision becomes "name (1).ext", not
// "name.ext (1)" — matches the filename convention most OS file managers already use for this.
function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 1;
  let candidate = `${base} (${n})${ext}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

export function zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const taken = new Set<string>();
  const zippable: Zippable = {};
  for (const file of files) {
    const name = dedupeName(file.name, taken);
    taken.add(name);
    zippable[name] = file.data;
  }
  return zipSync(zippable, { level: 6 });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/lib/cryptoUtils.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/cryptoUtils.ts apps/web/src/lib/cryptoUtils.test.ts
git commit -m "feat(web): generalize crypto helpers, add zip helper with name de-duplication"
```

## Task 3: `crypto.worker.ts` — zip + three-envelope messages

**Files:**
- Modify: `apps/web/src/workers/crypto.worker.ts`

**Interfaces:**
- Produces: worker message types `zipAndEncrypt` → `sendEnvelopesReady`, `decryptBytes` →
  `bytesDecrypted`/`decryptError` (generic, replaces `decryptFile`/`fileDecrypted`), and progress
  events `zipAndEncryptProgress` posted mid-operation (used by Task 4's hook to drive the
  encryption progress bar).

- [ ] **Step 1: Implement**

```typescript
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
```

`requestId` (a caller-supplied opaque string) lets Task 4's hook distinguish which of several
concurrent decrypt calls (metadata, message, archive can all be in flight from one page) a given
response belongs to, since the worker has one shared `onmessage`/`postMessage` channel.

- [ ] **Step 2: No dedicated unit test for this file**

This worker is a thin message-passing wrapper around `cryptoUtils.ts` (already unit-tested in Task
2) and `fflate` — its own correctness is exercised end-to-end by Task 4's hook tests (jsdom can
instantiate real Web Workers; the existing `useFileEncryption.test.ts`, if any, already does this —
check with `ls apps/web/src/hooks/useFileEncryption.test.ts` before assuming one needs to be
created from scratch).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/workers/crypto.worker.ts
git commit -m "feat(web): extend crypto worker for zip + three-envelope encryption"
```

## Task 4: `useFileEncryption.ts` — multi-envelope hook

**Files:**
- Modify: `apps/web/src/hooks/useFileEncryption.ts`

**Interfaces:**
- Produces: `encryptForSend(files, message, recipientPublicKey): Promise<SendEnvelopes>`,
  `decryptMetadata(encryptedMetadata, metadataNonce, senderPublicKey): Promise<DecryptedMetadata>`,
  `decryptMessage(encryptedMessage, messageNonce, senderPublicKey): Promise<string>`,
  `decryptArchive(archiveBytes, archiveNonce, senderPublicKey): Promise<Uint8Array>`, plus the
  existing `keyPair`/`setKeyPair`/`progress`/`isProcessing`. Consumed by Task 9 (`RequestLinkPage`
  doesn't need crypto), Task 10 (`UploadPage`), Task 11 (`ReceivePage`).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/hooks/useFileEncryption.test.ts (extend the existing file if present, else create)
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { useFileEncryption } from "./useFileEncryption";

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
        recipient.publicKey
      );
    });

    const { result: recvResult } = renderHook(() => useFileEncryption(recipient));

    let metadata: Awaited<ReturnType<typeof recvResult.current.decryptMetadata>>;
    await act(async () => {
      metadata = await recvResult.current.decryptMetadata(
        envelopes!.encryptedMetadata,
        envelopes!.metadataNonce,
        sender.publicKey
      );
    });
    expect(metadata!.files).toEqual([{ name: "a.txt", size: 5 }]);
    expect(metadata!.mimeType).toBe("application/zip");

    let message: string;
    await act(async () => {
      message = await recvResult.current.decryptMessage(
        envelopes!.encryptedMessage!,
        envelopes!.messageNonce!,
        sender.publicKey
      );
    });
    expect(message!).toBe("a secret message");

    let archiveBytes: Uint8Array;
    await act(async () => {
      archiveBytes = await recvResult.current.decryptArchive(
        envelopes!.archiveBlob,
        envelopes!.archiveNonce,
        sender.publicKey
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
        recipient.publicKey,
        (p) => phases.push(p.phase)
      );
    });
    expect(phases).toEqual(["zipping", "encrypting", "hashing", "done"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useFileEncryption.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/hooks/useFileEncryption.ts
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { useCallback, useEffect, useRef, useState } from "react";
import { decryptBytes as decryptBytesSync } from "@/lib/cryptoUtils";

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
      return new Promise((resolve, reject) => {
        const onMessage = (e: MessageEvent) => {
          if (e.data.type === "zipAndEncryptProgress") {
            setProgress(e.data.data.percent);
            onProgress?.(e.data.data);
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
```

Note: `decryptBytesSync` is imported but unused above by design — remove the import; it was left
from an earlier draft and `decryptViaWorker` is the only decrypt path this hook exposes (everything
stays off the main thread, per this plan's Global Constraints). Delete that import line before
committing.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useFileEncryption.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useFileEncryption.ts apps/web/src/hooks/useFileEncryption.test.ts
git commit -m "feat(web): rebuild useFileEncryption for the three-envelope model"
```

## Task 5: `useXhrUpload` hook (byte-level upload progress)

**Files:**
- Create: `apps/web/src/hooks/useXhrUpload.ts`
- Test: `apps/web/src/hooks/useXhrUpload.test.ts`

**Interfaces:**
- Produces: `uploadWithProgress(url: string, body: Blob, onProgress?: (percent: number) => void): Promise<void>`
  (rejects on any non-2xx status or transport error/abort).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hooks/useXhrUpload.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadWithProgress } from "./useXhrUpload";

class FakeXhr {
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  open = vi.fn();
  send = vi.fn();
}

describe("uploadWithProgress", () => {
  let fakeXhr: FakeXhr;
  beforeEach(() => {
    fakeXhr = new FakeXhr();
    vi.stubGlobal("XMLHttpRequest", vi.fn(() => fakeXhr) as unknown as typeof XMLHttpRequest);
  });

  it("resolves on a 2xx response and reports progress along the way", async () => {
    const onProgress = vi.fn();
    const promise = uploadWithProgress("http://example.test/put", new Blob(["x"]), onProgress);
    fakeXhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    fakeXhr.status = 200;
    fakeXhr.onload?.();
    await expect(promise).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(50);
  });

  it("rejects on a non-2xx response", async () => {
    const promise = uploadWithProgress("http://example.test/put", new Blob(["x"]));
    fakeXhr.status = 403;
    fakeXhr.onload?.();
    await expect(promise).rejects.toThrow();
  });

  it("rejects on a transport error", async () => {
    const promise = uploadWithProgress("http://example.test/put", new Blob(["x"]));
    fakeXhr.onerror?.();
    await expect(promise).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useXhrUpload.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/hooks/useXhrUpload.ts
//
// fetch() has no cross-browser way to report request-body (upload) progress; XMLHttpRequest's
// upload.onprogress is the one reliable native mechanism for it (design spec §2, approach 1 —
// hybrid XHR-for-upload / fetch-for-download). Kept as a plain function, not a hook, since it has
// no component-lifecycle state of its own — callers (Task 10's UploadPage) own the progress state.
export function uploadWithProgress(url: string, body: Blob, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(body);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useXhrUpload.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useXhrUpload.ts apps/web/src/hooks/useXhrUpload.test.ts
git commit -m "feat(web): add XHR-based upload with byte-level progress"
```

## Task 6: `useStreamedDownload` hook (byte-level download progress + hash verification)

**Files:**
- Create: `apps/web/src/hooks/useStreamedDownload.ts`
- Test: `apps/web/src/hooks/useStreamedDownload.test.ts`

**Interfaces:**
- Produces: `downloadWithProgress(url: string, expectedContentMD5Base64: string, onProgress?: (percent: number) => void): Promise<{ bytes: Uint8Array; integrityOk: boolean }>`
  — design spec §3.3/§6.3: never throws on a hash mismatch, returns `integrityOk: false` instead, so
  the caller (Task 11) can report `download-failed` distinctly from a network-level failure (which
  *does* still throw).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hooks/useStreamedDownload.test.ts
import { describe, it, expect, vi } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { downloadWithProgress } from "./useStreamedDownload";

function fakeResponse(bytes: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-length": String(bytes.byteLength) } });
}

describe("downloadWithProgress", () => {
  it("reports integrityOk true when the hash matches", async () => {
    const bytes = new TextEncoder().encode("ciphertext-stand-in");
    const hash = encodeBase64(nacl.hash(bytes));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(bytes)));

    const result = await downloadWithProgress("http://example.test/get", hash);
    expect(result.integrityOk).toBe(true);
    expect(result.bytes).toEqual(bytes);
  });

  it("reports integrityOk false when the hash does not match, without throwing", async () => {
    const bytes = new TextEncoder().encode("ciphertext-stand-in");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(bytes)));

    const result = await downloadWithProgress("http://example.test/get", "wrong-hash-base64");
    expect(result.integrityOk).toBe(false);
  });

  it("still throws on a network-level failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(downloadWithProgress("http://example.test/get", "any")).rejects.toThrow("network down");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useStreamedDownload.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/hooks/useStreamedDownload.ts
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";

export async function downloadWithProgress(
  url: string,
  expectedContentMD5Base64: string,
  onProgress?: (percent: number) => void
): Promise<{ bytes: Uint8Array; integrityOk: boolean }> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) onProgress?.(Math.round((received / total) * 100));
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Design spec §3.3: verify before the caller ever reports completion — a mismatch is reported
  // as data, never thrown, since it is an expected, retryable outcome (delivery_failed), not a
  // transport-level exception.
  const integrityOk = encodeBase64(nacl.hash(bytes)) === expectedContentMD5Base64;
  return { bytes, integrityOk };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useStreamedDownload.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useStreamedDownload.ts apps/web/src/hooks/useStreamedDownload.test.ts
git commit -m "feat(web): add streamed download with progress and integrity verification"
```

## Task 7: PIN-protected local keys in `useLocalLinks.ts`

**Files:**
- Modify: `apps/web/src/hooks/useLocalLinks.ts`
- Test: `apps/web/src/hooks/useLocalLinks.test.ts` (create if none exists)

**Interfaces:**
- Produces: `saveLink(slug, privateKey, expiresAt, pin?: string)`,
  `unlockLink(slug, pin?: string): Promise<string>` (returns the raw base64 private key, throws on
  wrong PIN) — replaces direct `links[slug].privateKey` access for callers that need the *usable*
  key (Tasks 9, 11); `links` itself still exposes `pinProtected: boolean` per entry so the UI knows
  whether to prompt.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/hooks/useLocalLinks.test.ts
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useLocalLinks } from "./useLocalLinks";

describe("useLocalLinks PIN protection", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores and retrieves a key without a PIN unchanged", async () => {
    const { result } = renderHook(() => useLocalLinks());
    act(() => result.current.saveLink("slug1", "raw-key-base64", Date.now() + 1000));
    await expect(result.current.unlockLink("slug1")).resolves.toBe("raw-key-base64");
  });

  it("wraps and unwraps a key with a correct PIN", async () => {
    const { result } = renderHook(() => useLocalLinks());
    await act(async () => {
      await result.current.saveLink("slug2", "raw-key-base64", Date.now() + 1000, "1234");
    });
    expect(result.current.links["slug2"].pinProtected).toBe(true);
    await expect(result.current.unlockLink("slug2", "1234")).resolves.toBe("raw-key-base64");
  });

  it("rejects the wrong PIN", async () => {
    const { result } = renderHook(() => useLocalLinks());
    await act(async () => {
      await result.current.saveLink("slug3", "raw-key-base64", Date.now() + 1000, "1234");
    });
    await expect(result.current.unlockLink("slug3", "0000")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useLocalLinks.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/hooks/useLocalLinks.ts
import { useCallback, useEffect, useState } from "react";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
} from "@/lib/keyWrapping";
import { decodeBase64 } from "tweetnacl-util";

export interface StoredLink {
  // Exactly one of these two is set: `privateKey` for an unprotected key (unchanged from before
  // this task), `wrapped`+`salt` for a PIN-protected one (design spec §3.4, reusing lib/keyWrapping.ts
  // as-is — the same argon2id-then-nacl.secretbox primitives the account password flow already uses).
  privateKey?: string;
  wrapped?: string;
  salt?: string;
  pinProtected: boolean;
  createdAt: number;
  expiresAt: number;
}

type LocalLinks = Record<string, StoredLink>;

const STORAGE_KEY = "e2ee-drop:links";

export function useLocalLinks() {
  const [links, setLinks] = useState<LocalLinks>(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: LocalLinks = JSON.parse(raw);
      const now = Date.now();
      for (const slug of Object.keys(parsed)) {
        if (parsed[slug].expiresAt < now) delete parsed[slug];
      }
      return parsed;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
    } catch {
      // localStorage unavailable (private mode / quota) — link still usable for this tab session
    }
  }, [links]);

  const saveLink = useCallback(
    async (slug: string, privateKey: string, expiresAt: number, pin?: string) => {
      const createdAt = Date.now();
      if (!pin) {
        setLinks((prev) => ({ ...prev, [slug]: { privateKey, pinProtected: false, createdAt, expiresAt } }));
        return;
      }
      const salt = generateWrappingSalt();
      const wrappingKey = await deriveWrappingKey(pin, salt);
      const wrapped = wrapPrivateKey(decodeBase64(privateKey), wrappingKey);
      setLinks((prev) => ({ ...prev, [slug]: { wrapped, salt, pinProtected: true, createdAt, expiresAt } }));
    },
    []
  );

  // Returns the raw base64 private key, prompting-free for an unprotected entry. Throws (from
  // unwrapPrivateKey, unchanged from lib/keyWrapping.ts) on a wrong or missing PIN for a
  // pin-protected entry.
  const unlockLink = useCallback(
    async (slug: string, pin?: string): Promise<string> => {
      const stored = links[slug];
      if (!stored) throw new Error("No local key found for this link");
      if (!stored.pinProtected) return stored.privateKey!;
      if (!pin) throw new Error("This link's key is PIN-protected");
      const wrappingKey = await deriveWrappingKey(pin, stored.salt!);
      const unwrapped = unwrapPrivateKey(stored.wrapped!, wrappingKey);
      return Buffer.from(unwrapped).toString("base64"); // matches encodeBase64's output shape
    },
    [links]
  );

  const removeLink = useCallback((slug: string) => {
    setLinks((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  return { links, saveLink, unlockLink, removeLink };
}
```

`Buffer` is not available in browser code — replace that line with the project's own
`tweetnacl-util` `encodeBase64` (already imported everywhere else in this codebase for exactly this
purpose):

```typescript
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
// ...
      return encodeBase64(unwrapped);
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/hooks/useLocalLinks.test.ts
```

- [ ] **Step 5: Fix existing callers**

`HomePage.tsx` and (pre-rewrite) `DownloadPage.tsx` read `stored.privateKey` directly — grep for
every existing reference and update to use `unlockLink` (async) instead, or `stored.pinProtected ?
null : stored.privateKey` where only a quick unprotected-only check is needed (e.g. `HomePage`'s
list rendering, which never needs the actual key, only whether an entry exists):

```bash
grep -rn "\.privateKey\b" apps/web/src --include=*.tsx | grep -v useLocalLinks.ts
```

Fix each hit. `HomePage.tsx`'s list rendering doesn't touch `.privateKey` at all (it only reads
`slug`/`expiresAt`), so it needs no change; Task 11's `ReceivePage` rewrite is where the real
`unlockLink` usage lands.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hooks/useLocalLinks.ts apps/web/src/hooks/useLocalLinks.test.ts apps/web/src/components/HomePage.tsx
git commit -m "feat(web): optional PIN protection for locally-stored anonymous keys"
```

## Task 8: `CreateLinkPage.tsx` — explicit form (owner note, retention, create button)

**Files:**
- Modify: `apps/web/src/components/CreateLinkPage.tsx`
- Modify: `apps/web/src/locales/{en,nb}/createLink.json` (add new keys)

- [ ] **Step 1: Rewrite the component**

Replace the auto-create-on-mount `useEffect` (lines 28-63 in the current file) with an explicit
form step. The link is now created only when the user submits, not on mount:

```typescript
// apps/web/src/components/CreateLinkPage.tsx
import { useState } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { CreateLinkResponse } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import i18n from "@/i18n";
import createLinkEn from "@/locales/en/createLink.json";
import createLinkNb from "@/locales/nb/createLink.json";

i18n.addResourceBundle("en", "createLink", createLinkEn, true, false);
i18n.addResourceBundle("nb", "createLink", createLinkNb, true, false);

const CODEWORD_DEFAULT_COUNT = 3;

export function CreateLinkPage() {
  const { t, i18n: i18next } = useTranslation("createLink");
  const { saveLink } = useLocalLinks();
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">("");
  const [pin, setPin] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [codewords, setCodewords] = useState<string[]>([]);
  const [showAllCodewords, setShowAllCodewords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const keyPair = nacl.box.keyPair();
      const locale = i18next.language?.startsWith("nb") ? "nb" : "en";
      const response = await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientPublicKey: encodeBase64(keyPair.publicKey),
          locale,
          ownerNote: ownerNote || undefined,
          retentionDays: retentionDays === "" ? undefined : retentionDays,
        }),
      });
      if (!response.ok) throw new Error("create failed");
      const body = (await response.json()) as CreateLinkResponse;
      if (body.expiresAt === undefined) throw new Error("create failed: missing expiresAt");
      await saveLink(body.slug, encodeBase64(keyPair.secretKey), body.expiresAt, pin || undefined);
      setSlug(body.slug);
      setCodewords(body.codewords ?? []);
    } catch {
      setError(t("errors.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const link = slug ? `${window.location.origin}/send/${slug}` : null;
  const visibleCodewords = showAllCodewords ? codewords : codewords.slice(0, CODEWORD_DEFAULT_COUNT);

  const copyLink = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {!link && (
          <>
            <div>
              <label htmlFor="ownerNote">{t("ownerNoteLabel")}</label>
              <textarea
                id="ownerNote"
                value={ownerNote}
                onChange={(e) => setOwnerNote(e.target.value)}
                placeholder={t("ownerNotePlaceholder")}
                className="w-full rounded border p-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("ownerNoteWarning")}</p>
            </div>
            <div>
              <label htmlFor="retentionDays">{t("retentionDaysLabel")}</label>
              <input
                id="retentionDays"
                type="number"
                min={1}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full rounded border p-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="pin">{t("pinLabel")}</label>
              <input
                id="pin"
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder={t("pinPlaceholder")}
                className="w-full rounded border p-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("pinWarning")}</p>
            </div>
            <Button onClick={create} disabled={creating}>
              {creating ? t("creating") : t("createButton")}
            </Button>
          </>
        )}
        {link && (
          <>
            <p className="break-all rounded bg-muted p-2 text-sm">{link}</p>
            <Button onClick={copyLink}>{copied ? t("copied") : t("copyLink")}</Button>
            <div>
              <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
              <p className="font-mono text-lg">{visibleCodewords.join(" · ")}</p>
              {codewords.length > CODEWORD_DEFAULT_COUNT && (
                <button type="button" className="text-xs underline" onClick={() => setShowAllCodewords((v) => !v)}>
                  {showAllCodewords ? t("showFewerWords") : t("showMoreWords")}
                </button>
              )}
            </div>
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm text-muted-foreground">{t("downloadPageHint")}</p>
              <Button asChild variant="secondary">
                <Link to={`/download/${slug}`}>{t("goToDownloadPage")}</Link>
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

Note: the `goToDownloadPage` link still points at `/download/:slug` here deliberately — Task 12
below renames the *route* to `/receive/:slug` and every reference to it in one pass, rather than
mid-editing it in two different tasks.

- [ ] **Step 2: Add new locale keys**

Add to both `apps/web/src/locales/en/createLink.json` and `.../nb/createLink.json` (matching each
file's existing flat-key style): `ownerNoteLabel`, `ownerNotePlaceholder`, `ownerNoteWarning`,
`retentionDaysLabel`, `pinLabel`, `pinPlaceholder`, `pinWarning`. Copy for `ownerNoteWarning` and
`pinWarning` per the design spec's exact wording (§4.3, §3.4):

- `ownerNoteWarning` (en): "This note is not encrypted and is visible to anyone with the link."
- `pinWarning` (en): "This PIN makes it harder for someone else using this browser to decrypt your
  content. It's not a substitute for real security — don't rely on it on a shared or public
  computer."

(and the Norwegian equivalents already used verbatim earlier in this project's design discussion).

- [ ] **Step 3: Run the existing component test and fix it for the new flow**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/components/CreateLinkPage.test.tsx
```

The existing test (if present) almost certainly asserts the old auto-create-on-mount behavior —
update it to render the form, fill nothing in, click "Create", and assert the link appears,
matching this task's new flow.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/CreateLinkPage.tsx apps/web/src/components/CreateLinkPage.test.tsx apps/web/src/locales
git commit -m "feat(web): explicit create-link form with owner note, retention, and PIN"
```

## Task 9: `NewLinkPage.tsx` — add owner note and retention fields

**Files:**
- Modify: `apps/web/src/components/NewLinkPage.tsx`
- Modify: `apps/web/src/locales/{en,nb}/newLink.json`

- [ ] **Step 1: Add state and fields**

```typescript
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">("");
```

Include both in the `submit` request body (`ownerNote: ownerNote || undefined`,
`retentionDays: retentionDays === "" ? undefined : retentionDays`), and add matching `<textarea>`/
`<input type="number">` fields in the JSX, following the same label/input pattern already used for
`slug`/`mode`/`visibility` in this file.

- [ ] **Step 2: Add locale keys**

Same `ownerNoteLabel`/`ownerNoteWarning`/`retentionDaysLabel` keys as Task 8, added to
`apps/web/src/locales/{en,nb}/newLink.json`.

- [ ] **Step 3: Run and fix the existing test**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/components/NewLinkPage.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/NewLinkPage.tsx apps/web/src/components/NewLinkPage.test.tsx apps/web/src/locales
git commit -m "feat(web): add owner note and retention fields to the custom link form"
```

## Task 10: `RequestLinkPage.tsx` (new)

**Files:**
- Create: `apps/web/src/components/RequestLinkPage.tsx`
- Create: `apps/web/src/locales/{en,nb}/requestLink.json`
- Modify: `apps/web/src/App.tsx` (add route)

- [ ] **Step 1: Implement**

Closely mirrors `NewLinkPage.tsx`'s structure (form → submit → show result), but with no
`slug`/`mode`/`visibility` fields (the backend endpoint doesn't take them — see plan 2 Task 12) and
no client-side key generation at all:

```typescript
// apps/web/src/components/RequestLinkPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import requestLinkEn from "@/locales/en/requestLink.json";
import requestLinkNb from "@/locales/nb/requestLink.json";

i18n.addResourceBundle("en", "requestLink", requestLinkEn, true, false);
i18n.addResourceBundle("nb", "requestLink", requestLinkNb, true, false);

export function RequestLinkPage() {
  const { t } = useTranslation("requestLink");
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">("");
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const res = await fetch("/api/links/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerNote: ownerNote || undefined,
        retentionDays: retentionDays === "" ? undefined : retentionDays,
      }),
    });
    if (!res.ok) {
      setError(t("errors.createFailed"));
      return;
    }
    const body = await res.json();
    setCreatedSlug(body.slug);
  };

  const link = createdSlug ? `${window.location.origin}/receive/${createdSlug}` : null;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {link && (
          <p>
            {t("success")} <code className="break-all">{link}</code>
          </p>
        )}
        {!link && (
          <>
            <div>
              <label htmlFor="ownerNote">{t("ownerNoteLabel")}</label>
              <textarea
                id="ownerNote"
                value={ownerNote}
                onChange={(e) => setOwnerNote(e.target.value)}
                placeholder={t("ownerNotePlaceholder")}
                className="w-full rounded border p-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("ownerNoteWarning")}</p>
            </div>
            <div>
              <label htmlFor="retentionDays">{t("retentionDaysLabel")}</label>
              <input
                id="retentionDays"
                type="number"
                min={1}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full rounded border p-2 text-sm"
              />
            </div>
            <Button onClick={submit}>{t("createButton")}</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Add locale files**

Create `apps/web/src/locales/{en,nb}/requestLink.json` with: `title`, `ownerNoteLabel`,
`ownerNotePlaceholder`, `ownerNoteWarning` (same copy as Task 8), `retentionDaysLabel`,
`createButton`, `success`, `errors.createFailed` — matching the flat/nested key style
`newLink.json` already uses.

- [ ] **Step 3: Add the route**

```typescript
// apps/web/src/App.tsx
import { RequestLinkPage } from "@/components/RequestLinkPage";
// ...
        <Route path="/links/request" element={<RequestLinkPage />} />
```

- [ ] **Step 4: Write a basic render test**

```typescript
// apps/web/src/components/RequestLinkPage.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RequestLinkPage } from "./RequestLinkPage";

describe("RequestLinkPage", () => {
  it("submits and shows the resulting receive link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slug: "abc123" }) })
    );
    render(<RequestLinkPage />);
    fireEvent.click(screen.getByRole("button", { name: /./ }));
    await waitFor(() => expect(screen.getByText(/abc123/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/components/RequestLinkPage.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/RequestLinkPage.tsx apps/web/src/components/RequestLinkPage.test.tsx apps/web/src/locales apps/web/src/App.tsx
git commit -m "feat(web): add sender-initiated request-link page"
```

## Task 11: `UploadPage.tsx` rewrite

**Files:**
- Modify: `apps/web/src/components/UploadPage.tsx`
- Modify: `apps/web/src/locales/{en,nb}/upload.json`

**Interfaces:**
- Consumes: `useFileEncryption` (Task 4), `uploadWithProgress` (Task 5), `useAuth` (existing).

- [ ] **Step 1: Rewrite**

```typescript
// apps/web/src/components/UploadPage.tsx
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDropzone } from "react-dropzone";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import type { LinkStatusResponse, RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Progress } from "@/components/ui/progress";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import { uploadWithProgress } from "@/hooks/useXhrUpload";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import uploadEn from "@/locales/en/upload.json";
import uploadNb from "@/locales/nb/upload.json";

i18n.addResourceBundle("en", "upload", uploadEn, true, false);
i18n.addResourceBundle("nb", "upload", uploadNb, true, false);

const MAX_MESSAGE_LENGTH = 500;

export function UploadPage() {
  const { t } = useTranslation("upload");
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const [link, setLink] = useState<LinkStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [showConsent, setShowConsent] = useState(false);
  const { setKeyPair, encryptForSend, progress: encryptPercent } = useFileEncryption();

  useEffect(() => {
    setKeyPair(user?.keyPair ?? nacl.box.keyPair());
  }, [setKeyPair, user]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/links/${slug}`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json() as Promise<LinkStatusResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setLink(data);
      })
      .catch(() => {
        if (!cancelled) setError(t("errors.linkNotFound"));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, t]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted) => setFiles((prev) => [...prev, ...accepted]),
    disabled: isUploading,
  });

  const doSend = useCallback(async () => {
    if (!link?.recipientPublicKey || !slug || isUploading) return;
    setError(null);
    setIsUploading(true);
    setUploadPercent(0);
    let dropId: string | undefined;
    try {
      const fileData = await Promise.all(
        files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))
      );
      const envelopes = await encryptForSend(fileData, message || null, link.recipientPublicKey);

      const requestBody: RequestUploadUrlRequest = {
        senderPublicKey: envelopes.senderPublicKey,
        archiveNonce: envelopes.archiveNonce,
        encryptedMessage: envelopes.encryptedMessage ?? undefined,
        messageNonce: envelopes.messageNonce ?? undefined,
        encryptedMetadata: envelopes.encryptedMetadata,
        metadataNonce: envelopes.metadataNonce,
        metadata: { fileSize: envelopes.fileSize, contentMD5: envelopes.contentMD5 },
      };
      const uploadUrlRes = await fetch(`/api/links/${slug}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!uploadUrlRes.ok) throw new Error("upload-url failed");
      const { dropId: newDropId, uploadUrl } = (await uploadUrlRes.json()) as RequestUploadUrlResponse;
      dropId = newDropId;

      try {
        await uploadWithProgress(uploadUrl, envelopes.archiveBlob, setUploadPercent);
      } catch (uploadErr) {
        // Design spec §5.1: an interrupted PUT abandons the whole attempt rather than leaving a
        // stale reservation — a retry starts fully fresh (new encryption, new upload-url call).
        await fetch(`/api/links/${slug}/drops/${dropId}/abandon`, { method: "POST" }).catch(() => {});
        throw uploadErr;
      }

      const completeRes = await fetch(`/api/links/${slug}/drops/${dropId}/complete`, { method: "POST" });
      if (!completeRes.ok) throw new Error("complete failed");
      setDone(true);
    } catch {
      setError(t("errors.uploadFailed"));
    } finally {
      setIsUploading(false);
    }
  }, [link, slug, isUploading, files, message, encryptForSend, t]);

  const handleSendClick = () => {
    if (!user) {
      setShowConsent(true);
      return;
    }
    doSend();
  };

  if (error && !link) {
    return (
      <Alert variant="destructive" className="mx-auto mt-12 max-w-md">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!link) return <p>{t("loading")}</p>;
  if (done) return <p>{t("success")}</p>;
  if (link.recipientPublicKey === null) {
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardContent className="pt-6">
          <p>{t("waitingForClaim")}</p>
        </CardContent>
      </Card>
    );
  }

  const canSend = (message.trim() !== "" || files.length > 0) && !isUploading;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div data-testid="recipient-badge">
          {!link.recipientName ? (
            t("anonymousRecipient")
          ) : (
            <>
              <p>{t("recipientNameLabel", { name: link.recipientName })} (@{link.recipientUsername})</p>
              <p>{link.recipientEmailVerified ? t("emailVerified") : t("emailUnverified")}</p>
              {link.recipientEmail && <p>{link.recipientEmail}</p>}
              <p>{link.recipientTotpEnabled ? t("totpEnabled") : t("totpDisabled")}</p>
            </>
          )}
        </div>
        {link.ownerNote && (
          <Alert>
            <AlertDescription>
              {link.ownerNote}
              <br />
              <span className="text-xs">{t("ownerNoteWarning")}</span>
            </AlertDescription>
          </Alert>
        )}
        <div>
          <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
          <p className="font-mono text-lg">{link.codewords.slice(0, 3).join(" · ")}</p>
        </div>
        <div>
          <textarea
            value={message}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("messagePlaceholder")}
            className="w-full rounded border p-2 text-sm"
            disabled={isUploading}
          />
          <p className="text-right text-xs text-muted-foreground">
            {message.length}/{MAX_MESSAGE_LENGTH}
          </p>
        </div>
        <div
          {...getRootProps()}
          data-testid="dropzone"
          className={`rounded border-2 border-dashed p-6 text-center text-sm ${isDragActive ? "border-primary" : "border-muted"}`}
        >
          <input {...getInputProps()} data-testid="file-input" />
          {isDragActive ? t("dropActive") : t("dropInstructions")}
        </div>
        {files.length > 0 && (
          <ul className="text-sm">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>{f.name}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("retentionInfo", { days: link.retentionDays })}</p>
        {isUploading && (
          <div className="space-y-2">
            <Progress value={encryptPercent}>
              <p className="text-xs">{t("encrypting")}</p>
            </Progress>
            <Progress value={uploadPercent}>
              <p className="text-xs">{t("uploading")}</p>
            </Progress>
          </div>
        )}
        <Button onClick={handleSendClick} disabled={!canSend}>
          {t("sendButton")}
        </Button>
        <AlertDialog open={showConsent} onOpenChange={setShowConsent}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("anonymousConsentTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("anonymousConsentBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel render={<Button variant="secondary" />}>{t("logInInstead")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setShowConsent(false);
                  doSend();
                }}
              >
                {t("continueAnonymously")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
```

Note the `AlertDialogCancel` branch here doesn't actually navigate to `/login` — wire that up with
`useNavigate` (`react-router-dom`, already used elsewhere in this codebase) inside its `onClick`:
`onClick={() => navigate("/login", { state: { returnTo: location.pathname } })}` — matching
whatever return-to pattern `LoginPage.tsx` already supports (check it first; if none exists, a
plain `navigate("/login")` is an acceptable minimal version, since the sender's in-progress message
and file selection would be lost either way if they follow it).

- [ ] **Step 2: Add/update locale keys**

Add to `apps/web/src/locales/{en,nb}/upload.json`: `waitingForClaim`, `dropActive`,
`dropInstructions`, `retentionInfo` (with a `{{days}}` interpolation), `encrypting`, `uploading`,
`anonymousConsentTitle`, `anonymousConsentBody`, `logInInstead`, `continueAnonymously`,
`ownerNoteWarning`, `totpEnabled`, `totpDisabled`. Remove `messageNotEncryptedWarning` (the message
is now genuinely encrypted — the warning it described no longer applies) and its one usage in the
old file (already removed by this rewrite).

- [ ] **Step 3: Update the existing test file**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/components/UploadPage.test.tsx
```

Update `UploadPage.test.tsx` for: the dropzone replacing the raw file input (still queryable via
`data-testid="file-input"`, kept intentionally so existing test selectors mostly still work), the
send button no longer being implicit on file selection (tests must now select a file/type a
message AND click "send"), and the anonymous-consent dialog appearing for a logged-out sender
(mock `useAuth` to return `user: null` for that case, matching however this test file already mocks
`useAuth` for other scenarios).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/UploadPage.tsx apps/web/src/components/UploadPage.test.tsx apps/web/src/locales
git commit -m "feat(web): rebuild UploadPage — multi-file dropzone, consent, dual progress"
```

## Task 12: `ReceivePage.tsx` (renamed from `DownloadPage.tsx`)

**Files:**
- Rename+modify: `apps/web/src/components/DownloadPage.tsx` → `apps/web/src/components/ReceivePage.tsx`
- Rename+modify: `apps/web/src/components/DownloadPage.test.tsx` → `ReceivePage.test.tsx`
- Modify: `apps/web/src/App.tsx` (`/download/:slug` → `/receive/:slug`, `DownloadPage` → `ReceivePage`)
- Modify: every other reference to `/download/` or `DownloadPage` in the codebase (see Step 4)
- Rename+modify: `apps/web/src/locales/{en,nb}/download.json` → `receive.json`

- [ ] **Step 1: Rename the files**

```bash
git mv apps/web/src/components/DownloadPage.tsx apps/web/src/components/ReceivePage.tsx
git mv apps/web/src/components/DownloadPage.test.tsx apps/web/src/components/ReceivePage.test.tsx
git mv apps/web/src/locales/en/download.json apps/web/src/locales/en/receive.json
git mv apps/web/src/locales/nb/download.json apps/web/src/locales/nb/receive.json
```

- [ ] **Step 2: Rewrite the component**

Keep the existing `mode`/ownership/SSE-subscription structure (design spec §6's changes are additive
on top of it, not a replacement of the owned/anonymous branching) but add: the claim view, the
`?role=receiver` query param on the status fetch, automatic metadata decryption, one-time message
reveal, gated+progress-tracked download, and the auto-save toggle.

```typescript
// apps/web/src/components/ReceivePage.tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import nacl from "tweetnacl";
import type {
  DownloadUrlResponse,
  DropSummary,
  LinkStatusResponse,
  ListDropsResponse,
  RevealMessageResponse,
} from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import { useFileEncryption, type DecryptedMetadata } from "@/hooks/useFileEncryption";
import { downloadWithProgress } from "@/hooks/useStreamedDownload";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import receiveEn from "@/locales/en/receive.json";
import receiveNb from "@/locales/nb/receive.json";

i18n.addResourceBundle("en", "receive", receiveEn, true, false);
i18n.addResourceBundle("nb", "receive", receiveNb, true, false);

const AUTO_SAVE_STORAGE_KEY = "e2ee-drop:auto-save-zip";

export function ReceivePage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  return <ReceivePageForLink key={`${slug ?? ""}|${user?.publicKey ?? ""}`} />;
}

function ReceivePageForLink() {
  const { t } = useTranslation("receive");
  const { slug } = useParams<{ slug: string }>();
  const { links, saveLink, unlockLink } = useLocalLinks();
  const { user } = useAuth();
  const { setKeyPair, decryptMetadata, decryptMessage, decryptArchive, progress: decryptPercent } =
    useFileEncryption();

  const [link, setLink] = useState<LinkStatusResponse | null>(null);
  const [linkNotFound, setLinkNotFound] = useState(false);
  const [pinPrompt, setPinPrompt] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);
  const [metadata, setMetadata] = useState<DecryptedMetadata | null>(null);
  const [revealedMessage, setRevealedMessage] = useState<string | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [autoSave, setAutoSave] = useState(
    () => window.localStorage.getItem(AUTO_SAVE_STORAGE_KEY) !== "false"
  );
  const [savedBlobUrl, setSavedBlobUrl] = useState<string | null>(null);

  const stored = slug ? links[slug] : undefined;

  // Load key: unprotected local key loads immediately; a PIN-protected one prompts first.
  useEffect(() => {
    if (!stored) return;
    if (!stored.pinProtected) {
      unlockLink(slug!).then((raw) => setKeyPair(nacl.box.keyPair.fromSecretKey(decodeBase64(raw))));
    } else {
      setPinPrompt(true);
    }
  }, [stored, slug, unlockLink, setKeyPair]);

  useEffect(() => {
    if (user?.keyPair) setKeyPair(user.keyPair);
  }, [user, setKeyPair]);

  const submitPin = async () => {
    try {
      const raw = await unlockLink(slug!, pinInput);
      setKeyPair(nacl.box.keyPair.fromSecretKey(decodeBase64(raw)));
      setPinPrompt(false);
      setPinError(false);
    } catch {
      setPinError(true);
    }
  };

  // Status fetch with ?role=receiver — see design spec §6.1/plan 2 Task 9 for why this parameter
  // exists: this same GET also serves the sender's page, and only the receiver's visit should
  // advance deliveryStatus.
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/links/${slug}?role=receiver`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json() as Promise<LinkStatusResponse>;
      })
      .then(setLink)
      .catch(() => setLinkNotFound(true));
  }, [slug]);

  // Decrypt metadata automatically once both the link and the key pair are available — no gate,
  // per design spec §6.1 (this never counts as a secure envelope "leaving the server").
  useEffect(() => {
    if (!link?.drop || pinPrompt) return;
    decryptMetadata(link.drop.encryptedMetadata, link.drop.metadataNonce, link.drop.senderPublicKey)
      .then(setMetadata)
      .catch(() => {});
  }, [link, pinPrompt, decryptMetadata]);

  const revealMessage = async () => {
    if (!slug || !link?.drop) return;
    const res = await fetch(`/api/links/${slug}/drops/${link.drop.id}/reveal-message`, { method: "POST" });
    if (!res.ok) return;
    const { encryptedMessage, messageNonce } = (await res.json()) as RevealMessageResponse;
    const plaintext = await decryptMessage(encryptedMessage, messageNonce, link.drop.senderPublicKey);
    setRevealedMessage(plaintext);
  };

  const download = useCallback(async () => {
    if (!slug || !link?.drop) return;
    setDownloadFailed(false);
    setDownloadPercent(0);
    const dropId = link.drop.id;
    try {
      const urlRes = await fetch(`/api/links/${slug}/download-url?dropId=${encodeURIComponent(dropId)}`);
      if (!urlRes.ok) throw new Error("download-url failed");
      const info = (await urlRes.json()) as DownloadUrlResponse;

      const { bytes, integrityOk } = await downloadWithProgress(info.downloadUrl, info.contentMD5, setDownloadPercent);
      if (!integrityOk) {
        await fetch(`/api/links/${slug}/drops/${dropId}/download-failed`, { method: "POST" });
        setDownloadFailed(true);
        return;
      }

      const decrypted = await decryptArchive(bytes, info.archiveNonce, info.senderPublicKey);
      await fetch(`/api/links/${slug}/drops/${dropId}/complete-download`, { method: "POST" });

      const blob = new Blob([decrypted as BlobPart], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      if (autoSave) {
        const a = document.createElement("a");
        a.href = url;
        a.download = "download.zip";
        a.click();
        URL.revokeObjectURL(url);
      } else {
        setSavedBlobUrl(url);
      }
      setDownloaded(true);
    } catch {
      await fetch(`/api/links/${slug}/drops/${dropId}/download-failed`, { method: "POST" }).catch(() => {});
      setDownloadFailed(true);
    }
  }, [slug, link, decryptArchive, autoSave]);

  const toggleAutoSave = (value: boolean) => {
    setAutoSave(value);
    window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, String(value));
  };

  if (linkNotFound) return <p role="alert">{t("errors.linkNotFound")}</p>;
  if (!link) return <p>{t("loading")}</p>;

  if (pinPrompt) {
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardContent className="space-y-4 pt-6">
          <p>{t("enterPin")}</p>
          <input
            type="password"
            inputMode="numeric"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            className="w-full rounded border p-2 text-sm"
          />
          {pinError && (
            <Alert variant="destructive">
              <AlertDescription>{t("wrongPin")}</AlertDescription>
            </Alert>
          )}
          <Button onClick={submitPin}>{t("unlock")}</Button>
        </CardContent>
      </Card>
    );
  }

  if (link.recipientPublicKey === null) {
    return <ClaimView slug={slug!} saveLink={saveLink} onClaimed={setLink} t={t} />;
  }

  const drop: DropSummary | null = link.drop;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {link.ownerNote && (
          <Alert>
            <AlertDescription>
              {link.ownerNote}
              <br />
              <span className="text-xs">{t("ownerNoteWarning")}</span>
            </AlertDescription>
          </Alert>
        )}
        {!drop && <p>{t("waitingForFile")}</p>}
        {drop && (
          <>
            {metadata && (
              <ul className="text-sm">
                {metadata.files.map((f) => (
                  <li key={f.name}>
                    {f.name} — {f.size} {t("bytes")}
                  </li>
                ))}
              </ul>
            )}
            {drop.hasMessage && revealedMessage === null && (
              <Button variant="secondary" onClick={() => setConfirmReveal(true)}>
                {t("decryptMessageButton")}
              </Button>
            )}
            {revealedMessage !== null && <p className="italic">{revealedMessage}</p>}
            <p className="text-xs text-muted-foreground">
              {t("contentExpiresAt", { date: new Date(drop.contentExpiresAt).toLocaleString() })}
            </p>
            {!downloaded && !downloadFailed && (
              <Button onClick={download} disabled={downloadPercent > 0 && downloadPercent < 100}>
                {t("downloadButton")}
              </Button>
            )}
            {downloadFailed && (
              <>
                <Alert variant="destructive">
                  <AlertDescription>{t("errors.downloadFailed")}</AlertDescription>
                </Alert>
                <Button onClick={download}>{t("retryButton")}</Button>
              </>
            )}
            {(downloadPercent > 0 || decryptPercent > 0) && !downloaded && (
              <div className="space-y-2">
                <Progress value={downloadPercent}>
                  <p className="text-xs">{t("downloading")}</p>
                </Progress>
                <Progress value={decryptPercent}>
                  <p className="text-xs">{t("decrypting")}</p>
                </Progress>
              </div>
            )}
            {downloaded && !autoSave && savedBlobUrl && (
              <a href={savedBlobUrl} download="download.zip" className="underline">
                {t("saveFileLink")}
              </a>
            )}
            {downloaded && <p>{t("downloadedMessage")}</p>}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={autoSave} onChange={(e) => toggleAutoSave(e.target.checked)} />
              {t("autoSaveToggle")}
            </label>
          </>
        )}
        <AlertDialog open={confirmReveal} onOpenChange={setConfirmReveal}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("revealWarningTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("revealWarningBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmReveal(false);
                  revealMessage();
                }}
              >
                {t("revealConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// Design spec §4.2: claim view, shown when the link has no recipientPublicKey yet. Extracted as
// its own small component since it's a fully separate UI state from everything above (no drop,
// no metadata, no key pair needed to render it).
function ClaimView({
  slug,
  saveLink,
  onClaimed,
  t,
}: {
  slug: string;
  saveLink: (slug: string, privateKey: string, expiresAt: number, pin?: string) => Promise<void>;
  onClaimed: (link: LinkStatusResponse) => void;
  t: (key: string) => string;
}) {
  const { user } = useAuth();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const claimAnonymously = async () => {
    setError(null);
    const keyPair = nacl.box.keyPair();
    const res = await fetch(`/api/links/${slug}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: encodeBase64(keyPair.publicKey) }),
    });
    if (!res.ok) {
      setError(t("errors.claimFailed"));
      return;
    }
    // Permanent by default (design spec's request-link flow has no fixed expiry) — a far-future
    // expiry keeps useLocalLinks' own pruning from dropping it prematurely.
    await saveLink(slug, encodeBase64(keyPair.secretKey), Date.now() + 365 * 24 * 60 * 60 * 1000, pin || undefined);
    const statusRes = await fetch(`/api/links/${slug}?role=receiver`);
    onClaimed(await statusRes.json());
  };

  const claimWithAccount = async () => {
    if (!user?.publicKey) return;
    setError(null);
    const res = await fetch(`/api/links/${slug}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: user.publicKey }),
    });
    if (!res.ok) {
      setError(t("errors.claimFailed"));
      return;
    }
    const statusRes = await fetch(`/api/links/${slug}?role=receiver`);
    onClaimed(await statusRes.json());
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("claimTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {user ? (
          <Button onClick={claimWithAccount}>{t("claimWithAccount")}</Button>
        ) : (
          <p className="text-sm">
            <Link to="/login" className="underline">
              {t("logInToClaimWithAccount")}
            </Link>
          </p>
        )}
        <div className="space-y-2 border-t pt-4">
          <Alert>
            <AlertDescription>{t("anonymousClaimWarning")}</AlertDescription>
          </Alert>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t("pinPlaceholder")}
            className="w-full rounded border p-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("pinWarning")}</p>
          <Button variant="secondary" onClick={claimAnonymously}>
            {t("claimAnonymously")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

This rewrite keeps the anonymous-single-drop path but does not re-implement the owned-link "queue"
view from the pre-existing `DownloadPage.tsx` (`mode === "owned"` branch, SSE subscription,
`downloadedIds`/`downloadingIds` bookkeeping) — porting that view to the new per-drop envelope
model (each queued drop needs its own metadata-decrypt/message-reveal/download flow, not just one)
is substantial enough to warrant its own follow-up task. Add it now as a explicit, tracked
follow-up rather than silently dropping the feature:

- [ ] **Step 2a: Port the owned-link queue view**

Re-add a `mode === "owned"` branch (structure copied from the pre-rewrite `DownloadPage.tsx`:
`useLocalLinks`/ownership-check effect, `GET /api/links/:slug/drops`, SSE subscription via
`EventSource` on `/api/links/:slug/events`, `mergeDrops`/`newerOf` merge logic) rendering a list of
drops, where each list item gets its own instance of this task's metadata/message/download logic
(extract the drop-detail rendering — from `{drop && (...)}` down to before the closing `</>`  in
the single-drop view above — into a shared `DropDetail` component parameterized by `drop`, `slug`,
and the shared `decryptMetadata`/`decryptMessage`/`decryptArchive`/`autoSave` values, so both the
single-drop anonymous view and the owned queue view render through the same component instead of
duplicating the download/reveal logic).

- [ ] **Step 3: Update locale keys**

`receive.json` (renamed from `download.json`) needs new keys: `enterPin`, `wrongPin`, `unlock`,
`claimTitle`, `claimWithAccount`, `logInToClaimWithAccount`, `anonymousClaimWarning`,
`claimAnonymously`, `pinPlaceholder`, `pinWarning` (same copy as Task 8), `decryptMessageButton`,
`revealWarningTitle`, `revealWarningBody`, `revealConfirm`, `cancel`, `bytes`, `contentExpiresAt`
(with a `{{date}}` interpolation), `retryButton`, `downloading`, `decrypting`, `saveFileLink`,
`autoSaveToggle`, `ownerNoteWarning`, `errors.claimFailed`. Remove any now-unused keys from the old
`download.json` that referenced removed fields (e.g. anything about `fileName` shown directly,
since it's now inside `metadata.files`).

- [ ] **Step 4: Fix every other reference to the old route/component name**

```bash
grep -rln "DownloadPage\|/download/:slug\|\"/download/\"" apps/web/src --include=*.tsx --include=*.ts
```

Update each hit: `App.tsx`'s route and import, `CreateLinkPage.tsx`'s `goToDownloadPage` link
(Task 8 deliberately left this as `/download/${slug}` — fix it here to `/receive/${slug}`),
`HomePage.tsx`'s link list (`Link to={`/download/${slug}`}`), and any test file referencing the old
path.

- [ ] **Step 5: Run to verify tests pass**

```bash
pnpm --filter @e2ee-drop/web exec vitest run src/components/ReceivePage.test.tsx
pnpm --filter @e2ee-drop/web test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): rebuild receiver flow as ReceivePage — claim, metadata, message reveal, gated download"
```

## Task 13: Full-suite check and E2E script update

**Files:**
- Modify: `scripts/verify-e2e.mjs` (check its current content first — extend it, following its
  existing structure, rather than rewriting it wholesale)

- [ ] **Step 1: Read the existing E2E script's structure**

```bash
sed -n '1,60p' scripts/verify-e2e.mjs
```

- [ ] **Step 2: Extend it to cover, at minimum**

- A recipient-initiated one-time link: create → send a message + one file → receive page reveals
  the message once, downloads and decrypts the file once, second download attempt is refused
  server-side (or already shows "downloaded" client-side, matching whatever level of detail the
  existing script already operates at for the pre-rewrite flow).
- The sender-initiated request flow: create via `/api/links/request` → claim anonymously → send →
  receive.
- Match the existing script's assertion style (check its current error-handling/exit-code pattern
  before adding new checks, so failures report the same way).

- [ ] **Step 3: Run it**

```bash
pnpm verify:e2e
```

- [ ] **Step 4: Run the full monorepo test suite**

```bash
pnpm -r test
```

Expected: clean. This is the plan's final gate — do not consider the E2E redesign done until this
passes with no `@ts-expect-error` markers left over from plan 1 Task 6 anywhere in the codebase:

```bash
grep -rn "@ts-expect-error — rewritten in plan 2\|@ts-expect-error — fixed in plan 2" apps/
```

Expected: no results.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-e2e.mjs
git commit -m "test(e2e): cover multi-file send, message reveal, and the request/claim flow"
```

---

## Self-review notes (from the agent that wrote this plan)

- **Spec coverage:** covers design spec §3.1 (Tasks 2-4), §3.4 (Task 7), §4.1-§4.3 (Tasks 10, 12),
  §5 (Task 11), §6 (Task 12), §8 (Tasks 1-7 for libraries/hooks, 8-12 for components).
- **Judgment call flagged for review:** Task 12 explicitly does NOT fully implement the owned-link
  queue view in its main code listing — porting it to the per-drop envelope model is real,
  non-trivial work (each queued drop needs its own metadata/message/download sub-flow), and I
  judged it better to name this explicitly as Step 2a with a concrete extraction strategy
  (`DropDetail` shared component) than to either skip it silently or pad out an already-large task
  with a second full component listing. Confirm this split is acceptable before executing.
- **Judgment call flagged for review:** the login-return-to flow in Task 11's consent dialog
  (`AlertDialogCancel`) assumes `LoginPage.tsx` may or may not already support a `returnTo` state —
  I did not read that file during planning; the task instructs the implementer to check first
  rather than guessing its shape.
- **Type consistency:** `SendEnvelopes`, `DecryptedMetadata` (Task 4) are used identically in Tasks
  11 and 12; `uploadWithProgress`/`downloadWithProgress` signatures (Tasks 5-6) match their usage in
  Tasks 11-12 exactly (both take a plain callback, not an event emitter, keeping them framework-
  agnostic like the rest of this codebase's `lib/` helpers).
