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
