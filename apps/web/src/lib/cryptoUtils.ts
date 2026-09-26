// apps/web/src/lib/cryptoUtils.ts
import nacl from "tweetnacl";
import { zipSync, type Zippable } from "fflate";
import type { EncryptFileInput, DecryptFileInput, EncryptedFilePayload } from "@e2ee-drop/shared";

// Renamed from encryptFile/decryptFile: these never inspected what the bytes represented, and the
// three-envelope design (message, metadata, archive — design spec §3.1) now uses the same two
// functions for all three, not just the file archive.
export function encryptBytes({
  unencrypted,
  recipientPublicKey,
  senderSecretKey,
}: EncryptFileInput): EncryptedFilePayload {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(unencrypted, nonce, recipientPublicKey, senderSecretKey);
  return { encrypted, nonce, originalSize: unencrypted.length };
}

export function decryptBytes({
  encrypted,
  nonce,
  senderPublicKey,
  recipientSecretKey,
}: DecryptFileInput): Uint8Array {
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
