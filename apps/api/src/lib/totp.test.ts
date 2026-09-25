// apps/api/src/lib/totp.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../env", () => ({ env: { APP_SECRET_KEY: "a".repeat(32) } }));

import { generateTotpSecret, buildOtpauthUrl, verifyTotpCode, encryptTotpSecret, decryptTotpSecret } from "./totp";
import { TOTP, Secret } from "otpauth";

describe("totp", () => {
  it("generates a base32 secret and a usable otpauth URL", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThan(0);
    const url = buildOtpauthUrl(secret, "user@example.com");
    expect(url).toContain("otpauth://totp/");
  });

  it("verifies a currently-valid code and rejects a bogus one", () => {
    const secret = generateTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const validCode = totp.generate();
    const used = new Set<string>();

    expect(verifyTotpCode(secret, validCode, used)).toBe(true);
    expect(verifyTotpCode(secret, "000000", new Set())).toBe(false);
  });

  it("rejects a code that was already used in this window (replay)", () => {
    const secret = generateTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const validCode = totp.generate();
    const used = new Set<string>();

    expect(verifyTotpCode(secret, validCode, used)).toBe(true);
    expect(verifyTotpCode(secret, validCode, used)).toBe(false);
  });

  it("rejects a code generated far outside the tolerance window", () => {
    const secret = generateTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const staleCode = totp.generate({ timestamp: Date.now() - 10 * 60 * 1000 }); // 10 minutes ago

    expect(verifyTotpCode(secret, staleCode, new Set())).toBe(false);
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    expect(encrypted).not.toBe(secret);
    expect(decryptTotpSecret(encrypted)).toBe(secret);
  });
});
