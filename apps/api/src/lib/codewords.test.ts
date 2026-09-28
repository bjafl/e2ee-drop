// apps/api/src/lib/codewords.test.ts
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { WORDLISTS, CODEWORD_WORD_COUNT, type CodewordLocale } from "@e2ee-drop/shared";
import { deriveCodewords, resolveLocale } from "./codewords";
import { env } from "../env";

const KEY_A = "cmVjaXBpZW50a2V5MTIzNDU2Nzg5MA==";
const KEY_B = "YW5vdGhlcmtleTk4NzY1NDMyMTA=";
const LINK_1 = "link-id-one";
const LINK_2 = "link-id-two";

// Verbatim copy of the pre-move, server-only implementation (node:crypto +
// Buffer). The shared, browser-capable version must produce byte-identical
// output for every input, or a client's locally derived phrase would stop
// matching what this server (and any older client) computes.
function referenceDeriveCodewords(
  publicKeyBase64: string,
  linkId: string,
  locale: CodewordLocale,
  count: number
): string[] {
  const wordlist = WORDLISTS[locale];
  const keyBytes = Buffer.concat([Buffer.from(publicKeyBase64, "base64"), Buffer.from(linkId, "utf8")]);
  const hash = createHash("sha256").update(keyBytes).digest();
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(wordlist[hash[i % hash.length]]);
  }
  return words;
}

describe("codewords", () => {
  it("is deterministic for the same key, link and locale", async () => {
    const first = await deriveCodewords(KEY_A, LINK_1, "en", 4);
    const second = await deriveCodewords(KEY_A, LINK_1, "en", 4);
    expect(first).toEqual(second);
  });

  it("returns words that belong to the requested locale's wordlist", async () => {
    const words = await deriveCodewords(KEY_A, LINK_1, "nb", 5);
    for (const word of words) {
      expect(WORDLISTS.nb).toContain(word);
    }
  });

  it("falls back to the default locale for an unsupported locale code", () => {
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("nb")).toBe("nb");
  });

  it("returns exactly `count` words, and is prefix-stable across counts", async () => {
    const four = await deriveCodewords(KEY_A, LINK_1, "en", 4);
    const five = await deriveCodewords(KEY_A, LINK_1, "en", 5);
    expect(four).toHaveLength(4);
    expect(five).toHaveLength(5);
    expect(five.slice(0, 4)).toEqual(four);
  });

  it("produces a different phrase for a different public key", async () => {
    const wordsA = await deriveCodewords(KEY_A, LINK_1, "en", 4);
    const wordsB = await deriveCodewords(KEY_B, LINK_1, "en", 4);
    expect(wordsA).not.toEqual(wordsB);
  });

  // The bug this closes: two links owned by the same user share the same
  // recipientPublicKey (createDefaultLinkForUser / POST /api/links/custom
  // both set it to owner.publicKey), so before linkId was folded into the
  // hash, every link a user owned displayed the identical phrase forever.
  it("produces a different phrase for the same public key on a different link", async () => {
    const wordsLink1 = await deriveCodewords(KEY_A, LINK_1, "en", 4);
    const wordsLink2 = await deriveCodewords(KEY_A, LINK_2, "en", 4);
    expect(wordsLink1).not.toEqual(wordsLink2);
  });

  // Review finding F1: the derivation moved to packages/shared (hash-wasm
  // instead of node:crypto, hand-rolled base64/UTF-8 instead of Buffer) so
  // browsers can run it. Its output must not change for any input.
  it("matches the original node:crypto implementation byte-for-byte", async () => {
    const cases: Array<[string, string]> = [
      [KEY_A, LINK_1],
      [KEY_B, LINK_2],
      ["", ""],
      // Real-shaped inputs: 32-byte nacl box public keys, cuid-like ids.
      ...Array.from({ length: 200 }, (_, i): [string, string] => [
        randomBytes(32).toString("base64"),
        `c${randomBytes(12).toString("hex")}${i}`,
      ]),
      // Arbitrary-length keys, exercising every base64 padding case.
      ...Array.from({ length: 50 }, (_, i): [string, string] => [randomBytes(i).toString("base64"), `link-${i}`]),
      // Malformed/lenient base64 Buffer.from tolerates (unpadded, URL-safe,
      // whitespace, junk, data after "="), and non-ASCII / lone-surrogate ids.
      ["cmVjaXBpZW50a2V5MTIzNDU2Nzg5MA", LINK_1],
      ["-_-_abcd", LINK_1],
      ["cmVj aXBp\nZW50", LINK_1],
      ["cmVj*aXBp!", LINK_1],
      ["cmVj=aXBp", LINK_1],
      ["Q", LINK_1],
      ["QUJD", "lenke-ø-æ-å-😀"],
      ["QUJD", "lone-\ud800-surrogate"],
    ];
    for (const [key, linkId] of cases) {
      for (const locale of ["en", "nb"] as const) {
        for (const count of [4, 5, 33, 64]) {
          expect(await deriveCodewords(key, linkId, locale, count)).toEqual(
            referenceDeriveCodewords(key, linkId, locale, count)
          );
        }
      }
    }
  });

  it("defaults the server's word count to the shared client-side count", () => {
    // Only meaningful when the environment doesn't override the variable.
    if (process.env.CODEWORD_WORD_COUNT === undefined) {
      expect(env.CODEWORD_WORD_COUNT).toBe(CODEWORD_WORD_COUNT);
    }
  });
});
