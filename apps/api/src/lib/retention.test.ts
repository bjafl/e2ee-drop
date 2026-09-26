import { describe, it, expect, vi } from "vitest";
import { resolveRetentionDays } from "./retention";
import { env } from "../env";

describe("resolveRetentionDays", () => {
  it("defaults to DROP_RETENTION_DAYS_DEFAULT when omitted", () => {
    expect(resolveRetentionDays(undefined, null)).toBe(env.DROP_RETENTION_DAYS_DEFAULT);
    expect(resolveRetentionDays(null, null)).toBe(env.DROP_RETENTION_DAYS_DEFAULT);
  });

  it("accepts an explicit value at or below the max, for a permanent link (no expiry)", () => {
    expect(resolveRetentionDays(env.DROP_RETENTION_DAYS_MAX, null)).toBe(env.DROP_RETENTION_DAYS_MAX);
  });

  it("rejects a value above DROP_RETENTION_DAYS_MAX", () => {
    const result = resolveRetentionDays(env.DROP_RETENTION_DAYS_MAX + 1, null);
    expect(result).toEqual({ error: expect.stringContaining("retentionDays") });
  });

  it("rejects a value above the link's own expiry duration", () => {
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h from now, i.e. < 1 day
    const result = resolveRetentionDays(1, expiresAt);
    expect(result).toEqual({ error: expect.stringContaining("retentionDays") });
  });

  it("accepts a value equal to the link's own expiry duration, rounded up", () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // exactly 1 day from now
    expect(resolveRetentionDays(1, expiresAt)).toBe(1);
  });

  it("rejects zero, negative, and non-integer values", () => {
    expect(resolveRetentionDays(0, null)).toEqual({ error: expect.any(String) });
    expect(resolveRetentionDays(-1, null)).toEqual({ error: expect.any(String) });
    expect(resolveRetentionDays(1.5, null)).toEqual({ error: expect.any(String) });
  });

  it("does not collapse a default (omitted) retentionDays to 0 when the caller's expiresAt was computed from an earlier, slightly-drifted Date.now() read (regression: fix round 1)", () => {
    // Mirrors the real call sites in routes/links.ts: `provisionalExpiresAt` is computed from
    // one Date.now() read, then handed to this function, which re-reads Date.now() itself. Here
    // we simulate the realistic case where those two reads land a few ms apart, with the second
    // (this function's internal) read being LATER — i.e. actual wall-clock drift, not a fake
    // going-backwards clock — which is exactly the scenario that used to floor a whole day of
    // retention down to 0.
    const first = 1_700_000_000_000;
    const drifted = first + 3; // 3ms later, well within realistic synchronous-code drift
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(first); // caller's Date.now() call, building provisionalExpiresAt
    const expiresAt = new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000);
    nowSpy.mockReturnValue(drifted); // this function's internal Date.now() call(s)

    const result = resolveRetentionDays(undefined, expiresAt);

    nowSpy.mockRestore();
    expect(result).toBe(env.DROP_RETENTION_DAYS_DEFAULT);
    expect(typeof result === "number" && result >= 1).toBe(true);
  });
});
