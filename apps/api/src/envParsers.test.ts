// apps/api/src/envParsers.test.ts
import { describe, it, expect } from "vitest";
import { EnvError, bool, httpUrl, int, isHttpsUrl, optionalInt, required, requiredSecret } from "./envParsers";

describe("int", () => {
  it("parses a valid whole number", () => {
    expect(int("MAX_FILE_SIZE_BYTES", 1, {}, { MAX_FILE_SIZE_BYTES: "524288000" })).toBe(524288000);
    expect(int("PORT", 3000, { min: 1, max: 65535 }, { PORT: " 8080 " })).toBe(8080);
  });

  it("uses the fallback when unset or empty", () => {
    expect(int("LINK_EXPIRY_HOURS", 24, {}, {})).toBe(24);
    expect(int("LINK_EXPIRY_HOURS", 24, {}, { LINK_EXPIRY_HOURS: "" })).toBe(24);
  });

  it("throws a clear error naming the var and value instead of returning NaN", () => {
    expect(() => int("MAX_FILE_SIZE_BYTES", 1, {}, { MAX_FILE_SIZE_BYTES: "abc" })).toThrow(EnvError);
    expect(() => int("MAX_FILE_SIZE_BYTES", 1, {}, { MAX_FILE_SIZE_BYTES: "abc" })).toThrow(
      /MAX_FILE_SIZE_BYTES.*"abc"/
    );
  });

  it("rejects values parseInt would have silently truncated", () => {
    for (const raw of ["12abc", "1.5", "1e3", "0x10", "24h"]) {
      expect(() => int("LINK_EXPIRY_HOURS", 24, {}, { LINK_EXPIRY_HOURS: raw })).toThrow(/LINK_EXPIRY_HOURS/);
    }
  });

  it("enforces min/max bounds", () => {
    expect(() => int("LINK_EXPIRY_HOURS", 24, { min: 1 }, { LINK_EXPIRY_HOURS: "0" })).toThrow(/between 1/);
    expect(() => int("TRUST_PROXY_HOPS", 1, {}, { TRUST_PROXY_HOPS: "-1" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => int("PORT", 3000, { min: 1, max: 65535 }, { PORT: "70000" })).toThrow(/PORT/);
    expect(int("TRUST_PROXY_HOPS", 1, {}, { TRUST_PROXY_HOPS: "0" })).toBe(0);
  });
});

describe("optionalInt", () => {
  it("returns undefined when unset/empty, parses valid values, throws on invalid", () => {
    expect(optionalInt("SMTP_PORT", {}, { SMTP_PORT: "" })).toBeUndefined();
    expect(optionalInt("SMTP_PORT", {}, { SMTP_PORT: "587" })).toBe(587);
    expect(() => optionalInt("SMTP_PORT", {}, { SMTP_PORT: "smtp" })).toThrow(/SMTP_PORT/);
  });
});

describe("bool", () => {
  it("parses true/false case-insensitively and falls back when unset", () => {
    expect(bool("ALLOW_REGISTRATION", false, { ALLOW_REGISTRATION: "true" })).toBe(true);
    expect(bool("ALLOW_REGISTRATION", true, { ALLOW_REGISTRATION: "FALSE" })).toBe(false);
    expect(bool("ALLOW_REGISTRATION", true, {})).toBe(true);
  });

  it("keeps an empty value meaning false (compose passes \"\" for an omitted var)", () => {
    expect(bool("ALLOW_REGISTRATION", true, { ALLOW_REGISTRATION: "" })).toBe(false);
  });

  it("throws on an unrecognised value instead of silently treating it as false", () => {
    expect(() => bool("ALLOW_REGISTRATION", true, { ALLOW_REGISTRATION: "yes" })).toThrow(
      /ALLOW_REGISTRATION.*"yes"/
    );
  });
});

describe("required / requiredSecret", () => {
  it("throws when missing", () => {
    expect(() => required("DATABASE_URL", {})).toThrow(/Missing required env var: DATABASE_URL/);
    expect(() => requiredSecret("SESSION_SECRET", { SESSION_SECRET: "" })).toThrow(/SESSION_SECRET/);
  });

  it("rejects the .env.example placeholder secrets", () => {
    expect(() =>
      requiredSecret("SESSION_SECRET", { SESSION_SECRET: "change-me-to-a-random-64-char-string" })
    ).toThrow(/SESSION_SECRET.*placeholder/);
    expect(() =>
      requiredSecret("APP_SECRET_KEY", { APP_SECRET_KEY: "change-me-to-another-random-32-byte-string" })
    ).toThrow(/APP_SECRET_KEY.*placeholder/);
  });

  it("accepts a real secret", () => {
    const secret = "3f9a".repeat(16);
    expect(requiredSecret("SESSION_SECRET", { SESSION_SECRET: secret })).toBe(secret);
  });
});

describe("httpUrl / isHttpsUrl", () => {
  it("returns a valid http(s) URL and falls back when unset or empty", () => {
    expect(httpUrl("APP_URL", "http://localhost:8080", { APP_URL: "https://drop.example.com" })).toBe(
      "https://drop.example.com"
    );
    expect(httpUrl("APP_URL", "http://localhost:8080", {})).toBe("http://localhost:8080");
    expect(httpUrl("APP_URL", "http://localhost:8080", { APP_URL: "" })).toBe("http://localhost:8080");
  });

  it("throws on a value that is not an absolute http(s) URL", () => {
    expect(() => httpUrl("APP_URL", "http://x", { APP_URL: "drop.example.com" })).toThrow(/APP_URL/);
    expect(() => httpUrl("APP_URL", "http://x", { APP_URL: "ftp://drop.example.com" })).toThrow(EnvError);
  });

  it("marks only https:// origins as secure (so http:// local dev keeps working)", () => {
    expect(isHttpsUrl("https://drop.example.com")).toBe(true);
    expect(isHttpsUrl("HTTPS://drop.example.com")).toBe(true);
    expect(isHttpsUrl("http://localhost:8080")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
  });
});
