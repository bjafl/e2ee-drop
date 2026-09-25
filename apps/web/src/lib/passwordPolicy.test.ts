// apps/web/src/lib/passwordPolicy.test.ts
import { describe, it, expect } from "vitest";
import { MIN_PASSWORD_LENGTH, isPasswordLongEnough, passwordLength } from "./passwordPolicy";

describe("passwordPolicy", () => {
  it("requires at least 12 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(isPasswordLongEnough("")).toBe(false);
    expect(isPasswordLongEnough("a")).toBe(false);
    expect(isPasswordLongEnough("a".repeat(11))).toBe(false);
    expect(isPasswordLongEnough("a".repeat(12))).toBe(true);
    expect(isPasswordLongEnough("correct horse battery staple")).toBe(true);
  });

  it("imposes no composition rules", () => {
    expect(isPasswordLongEnough("aaaaaaaaaaaa")).toBe(true);
    expect(isPasswordLongEnough("            ")).toBe(true);
  });

  it("counts Unicode code points, not UTF-16 code units", () => {
    // Each emoji is 2 UTF-16 code units but 1 code point.
    const sixEmoji = "😀".repeat(6);
    expect(sixEmoji.length).toBe(12);
    expect(passwordLength(sixEmoji)).toBe(6);
    expect(isPasswordLongEnough(sixEmoji)).toBe(false);
    expect(isPasswordLongEnough("😀".repeat(12))).toBe(true);
  });
});
