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
