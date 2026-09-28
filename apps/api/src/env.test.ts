// apps/api/src/env.test.ts
//
// env.ts is evaluated eagerly at module load (every var is computed as soon
// as the module is imported), so the only faithful way to test "fails
// startup" is to actually re-import it with a mutated process.env, rather
// than calling envParsers.int() directly (envParsers.test.ts already covers
// that generically). vi.resetModules() plus a fresh dynamic import forces
// env.ts to re-run its module-level `int(...)` calls against the mutated env.
import { describe, it, expect, afterEach, vi } from "vitest";

const RETENTION_VARS = ["DROP_RETENTION_DAYS_DEFAULT", "DROP_RETENTION_DAYS_MAX", "AUDIT_RETENTION_DAYS"] as const;

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("env.ts retention var bounds", () => {
  it.each(RETENTION_VARS)("rejects %s = 0 at startup instead of silently accepting a destructive value", async (name) => {
    process.env[name] = "0";
    vi.resetModules();
    await expect(import("./env")).rejects.toThrow(new RegExp(name));
  });

  it.each(RETENTION_VARS)("rejects a negative %s at startup", async (name) => {
    process.env[name] = "-1";
    vi.resetModules();
    await expect(import("./env")).rejects.toThrow(new RegExp(name));
  });

  it.each(RETENTION_VARS)("still accepts a valid positive %s", async (name) => {
    process.env[name] = "5";
    vi.resetModules();
    const { env } = await import("./env");
    expect(env[name]).toBe(5);
  });
});
