import { describe, it, expect } from "vitest";
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
});
