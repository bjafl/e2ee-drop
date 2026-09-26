// apps/web/src/hooks/useLocalLinks.test.ts
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useLocalLinks } from "./useLocalLinks";

// Must be valid base64 (unlike a plain placeholder string) because the PIN-protected
// path round-trips it through tweetnacl-util's decodeBase64/encodeBase64 and
// nacl.secretbox — this is the base64 encoding of the literal string "raw-key-base64".
const RAW_KEY_B64 = "cmF3LWtleS1iYXNlNjQ=";

describe("useLocalLinks PIN protection", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores and retrieves a key without a PIN unchanged", async () => {
    const { result } = renderHook(() => useLocalLinks());
    act(() => {
      result.current.saveLink("slug1", RAW_KEY_B64, Date.now() + 1000);
    });
    await expect(result.current.unlockLink("slug1")).resolves.toBe(RAW_KEY_B64);
  });

  it("wraps and unwraps a key with a correct PIN", async () => {
    const { result } = renderHook(() => useLocalLinks());
    await act(async () => {
      await result.current.saveLink("slug2", RAW_KEY_B64, Date.now() + 1000, "1234");
    });
    expect(result.current.links["slug2"].pinProtected).toBe(true);
    await expect(result.current.unlockLink("slug2", "1234")).resolves.toBe(RAW_KEY_B64);
  });

  it("rejects the wrong PIN", async () => {
    const { result } = renderHook(() => useLocalLinks());
    await act(async () => {
      await result.current.saveLink("slug3", RAW_KEY_B64, Date.now() + 1000, "1234");
    });
    await expect(result.current.unlockLink("slug3", "0000")).rejects.toThrow();
  });
});
