// apps/api/src/lib/codewords.test.ts
import { describe, it, expect } from "vitest";
import { deriveCodewords, resolveLocale } from "./codewords";
import { WORDLISTS } from "./wordlists";

const KEY_A = "cmVjaXBpZW50a2V5MTIzNDU2Nzg5MA==";
const KEY_B = "YW5vdGhlcmtleTk4NzY1NDMyMTA=";
const LINK_1 = "link-id-one";
const LINK_2 = "link-id-two";

describe("codewords", () => {
  it("is deterministic for the same key, link and locale", () => {
    const first = deriveCodewords(KEY_A, LINK_1, "en", 4);
    const second = deriveCodewords(KEY_A, LINK_1, "en", 4);
    expect(first).toEqual(second);
  });

  it("returns words that belong to the requested locale's wordlist", () => {
    const words = deriveCodewords(KEY_A, LINK_1, "nb", 5);
    for (const word of words) {
      expect(WORDLISTS.nb).toContain(word);
    }
  });

  it("falls back to the default locale for an unsupported locale code", () => {
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("nb")).toBe("nb");
  });

  it("returns exactly `count` words, and is prefix-stable across counts", () => {
    const four = deriveCodewords(KEY_A, LINK_1, "en", 4);
    const five = deriveCodewords(KEY_A, LINK_1, "en", 5);
    expect(four).toHaveLength(4);
    expect(five).toHaveLength(5);
    expect(five.slice(0, 4)).toEqual(four);
  });

  it("produces a different phrase for a different public key", () => {
    const wordsA = deriveCodewords(KEY_A, LINK_1, "en", 4);
    const wordsB = deriveCodewords(KEY_B, LINK_1, "en", 4);
    expect(wordsA).not.toEqual(wordsB);
  });

  // The bug this closes: two links owned by the same user share the same
  // recipientPublicKey (createDefaultLinkForUser / POST /api/links/custom
  // both set it to owner.publicKey), so before linkId was folded into the
  // hash, every link a user owned displayed the identical phrase forever.
  it("produces a different phrase for the same public key on a different link", () => {
    const wordsLink1 = deriveCodewords(KEY_A, LINK_1, "en", 4);
    const wordsLink2 = deriveCodewords(KEY_A, LINK_2, "en", 4);
    expect(wordsLink1).not.toEqual(wordsLink2);
  });
});
