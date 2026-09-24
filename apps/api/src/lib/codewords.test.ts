// apps/api/src/lib/codewords.test.ts
import { describe, it, expect } from "vitest";
import { deriveCodewords, resolveLocale, CODEWORD_DEFAULT_COUNT, CODEWORD_MAX_COUNT } from "./codewords";
import { WORDLISTS } from "./wordlists";

const KEY_A = "cmVjaXBpZW50a2V5MTIzNDU2Nzg5MA==";
const KEY_B = "YW5vdGhlcmtleTk4NzY1NDMyMTA=";

describe("codewords", () => {
  it("is deterministic for the same key and locale", () => {
    const first = deriveCodewords(KEY_A, "en");
    const second = deriveCodewords(KEY_A, "en");
    expect(first).toEqual(second);
  });

  it("returns words that belong to the requested locale's wordlist", () => {
    const words = deriveCodewords(KEY_A, "nb", CODEWORD_MAX_COUNT);
    for (const word of words) {
      expect(WORDLISTS.nb).toContain(word);
    }
  });

  it("falls back to the default locale for an unsupported locale code", () => {
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("nb")).toBe("nb");
  });

  it("is prefix-stable across word counts", () => {
    const three = deriveCodewords(KEY_A, "en", CODEWORD_DEFAULT_COUNT);
    const five = deriveCodewords(KEY_A, "en", CODEWORD_MAX_COUNT);
    expect(five.slice(0, CODEWORD_DEFAULT_COUNT)).toEqual(three);
  });

  it("produces a different phrase for a different public key", () => {
    const wordsA = deriveCodewords(KEY_A, "en");
    const wordsB = deriveCodewords(KEY_B, "en");
    expect(wordsA).not.toEqual(wordsB);
  });
});
