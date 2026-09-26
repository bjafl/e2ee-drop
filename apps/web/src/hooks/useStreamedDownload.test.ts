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
    // Wrap in new Uint8Array() to normalize realm: jsdom's TextEncoder returns a
    // Uint8Array from a different realm, which fails tweetnacl's instanceof checks
    const bytes = new Uint8Array(new TextEncoder().encode("ciphertext-stand-in"));
    const hash = encodeBase64(nacl.hash(bytes));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(bytes)));

    const result = await downloadWithProgress("http://example.test/get", hash);
    expect(result.integrityOk).toBe(true);
    expect(result.bytes).toEqual(bytes);
  });

  it("reports integrityOk false when the hash does not match, without throwing", async () => {
    // Wrap in new Uint8Array() to normalize realm: jsdom's TextEncoder returns a
    // Uint8Array from a different realm, which fails tweetnacl's instanceof checks
    const bytes = new Uint8Array(new TextEncoder().encode("ciphertext-stand-in"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(bytes)));

    const result = await downloadWithProgress("http://example.test/get", "wrong-hash-base64");
    expect(result.integrityOk).toBe(false);
  });

  it("still throws on a network-level failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(downloadWithProgress("http://example.test/get", "any")).rejects.toThrow("network down");
  });
});
