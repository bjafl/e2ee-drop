// apps/api/src/lib/trustProxy.test.ts
import { describe, it, expect } from "vitest";
import { createTrustProxyFn } from "./trustProxy";

describe("createTrustProxyFn", () => {
  it("trusts exactly the first `hops` hops", () => {
    const one = createTrustProxyFn(1);
    expect([0, 1, 2].map((h) => one("10.0.0.1", h))).toEqual([true, false, false]);
    const two = createTrustProxyFn(2);
    expect([0, 1, 2].map((h) => two("10.0.0.1", h))).toEqual([true, true, false]);
    const zero = createTrustProxyFn(0);
    expect(zero("10.0.0.1", 0)).toBe(false);
  });

  it("rejects invalid hop counts (e.g. a non-numeric TRUST_PROXY_HOPS parsed to NaN)", () => {
    expect(() => createTrustProxyFn(NaN)).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => createTrustProxyFn(-1)).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => createTrustProxyFn(1.5)).toThrow(/TRUST_PROXY_HOPS/);
  });
});
