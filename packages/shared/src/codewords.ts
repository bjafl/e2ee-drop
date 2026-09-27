// packages/shared/src/codewords.ts
//
// The single derivation of a link's verification phrase ("codewords"), shared
// by the API and the browser. Codewords are a TOFU safety net: the sender and
// the recipient each derive the phrase INDEPENDENTLY from the recipient public
// key they themselves hold (the sender: the exact key it is about to encrypt
// to; the recipient: its own locally held key), then compare out-of-band. If
// the server ever hands the sender a different key than the recipient really
// holds (compromised DB, bug, malicious operator), the two phrases differ.
// That only works if each client computes the words itself — which is why
// this lives here rather than only on the server, and why web code must never
// display the API's `codewords` response field for the comparison.
//
// Runs unchanged in Node and in the browser: no node:crypto, no Buffer. The
// SHA-256 comes from hash-wasm (already used for hashing elsewhere in the web
// app), and base64/UTF-8 decoding is done by hand below, deliberately matching
// Node's Buffer.from(..., "base64") / Buffer.from(..., "utf8") semantics so
// the output is byte-for-byte what the previous server-only implementation
// (node:crypto createHash("sha256") over Buffer.concat of those) produced.
// apps/api/src/lib/codewords.test.ts pins that equivalence against a
// node:crypto reference implementation.
import { createSHA256 } from "hash-wasm";
import { WORDLISTS, DEFAULT_CODEWORD_LOCALE, type CodewordLocale } from "./wordlists";

export { WORDLISTS, DEFAULT_CODEWORD_LOCALE, type CodewordLocale };

// Number of words every CLIENT displays. The sender's page and every
// recipient/owner surface read this same constant, so both sides of the
// comparison always show the same number of words. It is also the API's
// default for env.CODEWORD_WORD_COUNT (apps/api/src/env.ts). Each word is one
// byte of a SHA-256 hash indexed into a 256-word list, so 4 words give 256^4
// (~4.3 billion) possible phrases — see env.ts for why 4 is the floor. The
// derivation is prefix-stable across counts, so if an operator raises the
// server's env value, the server's (now purely informational) `codewords`
// field simply carries extra trailing words beyond what clients show.
export const CODEWORD_WORD_COUNT = 4;

export function resolveLocale(locale: string | undefined | null): CodewordLocale {
  return locale === "en" || locale === "nb" ? locale : DEFAULT_CODEWORD_LOCALE;
}

// `linkId` is folded into the hash alongside the public key so that two links
// belonging to the same owner — who therefore share the same recipientPublicKey
// (see createDefaultLinkForUser / POST /api/links/custom) — get different
// codewords. Without it, every link a given user owns would display the exact
// same phrase forever, since the hash input would never change. This app
// accepts a small, deliberately-chosen probability of two unrelated,
// simultaneously active links coincidentally sharing a phrase (a UX nuisance,
// not a security break — an attacker or typo hitting one SPECIFIC target
// link's phrase is a separate, much smaller 1-in-256^count odds, independent
// of how many other links exist) rather than enforcing global uniqueness with
// a DB constraint and a retry-on-collision loop.
//
// Async only because hash-wasm loads its WASM module asynchronously; the
// output is fully deterministic for a given input.
export async function deriveCodewords(
  publicKeyBase64: string,
  linkId: string,
  locale: CodewordLocale,
  count: number
): Promise<string[]> {
  const wordlist = WORDLISTS[locale];
  const keyBytes = decodeBase64Lenient(publicKeyBase64);
  const linkIdBytes = encodeUtf8(linkId);
  const input = new Uint8Array(keyBytes.length + linkIdBytes.length);
  input.set(keyBytes, 0);
  input.set(linkIdBytes, keyBytes.length);

  const hasher = await createSHA256();
  hasher.init();
  hasher.update(input);
  const hash = hasher.digest("binary");

  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(wordlist[hash[i % hash.length]]);
  }
  return words;
}

const BASE64_VALUES: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) table[alphabet[i]] = i;
  // Node's base64 decoder also accepts the URL-safe alphabet.
  table["-"] = 62;
  table["_"] = 63;
  return table;
})();

// Mirrors Node's Buffer.from(str, "base64"): accepts standard and URL-safe
// alphabets, stops at the first "=", silently skips any other non-alphabet
// character (whitespace etc.), and drops a trailing partial group of a single
// character. For well-formed base64 (what tweetnacl-util's encodeBase64 always
// produces) this is ordinary base64 decoding. It is lenient on purpose, rather
// than using atob (which throws on anything malformed), so the API's output
// for whatever recipientPublicKey string is already stored in the DB stays
// exactly what it was before this module existed.
function decodeBase64Lenient(input: string): Uint8Array {
  const sextets: number[] = [];
  for (const char of input) {
    if (char === "=") break;
    const value = BASE64_VALUES[char];
    if (value !== undefined) sextets.push(value);
  }
  const bytes: number[] = [];
  let i = 0;
  for (; i + 4 <= sextets.length; i += 4) {
    const n = (sextets[i] << 18) | (sextets[i + 1] << 12) | (sextets[i + 2] << 6) | sextets[i + 3];
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const rest = sextets.length - i;
  if (rest === 2) {
    bytes.push(((sextets[i] << 2) | (sextets[i + 1] >> 4)) & 0xff);
  } else if (rest === 3) {
    const n = (sextets[i] << 12) | (sextets[i + 1] << 6) | sextets[i + 2];
    bytes.push((n >> 10) & 0xff, (n >> 2) & 0xff);
  }
  return Uint8Array.from(bytes);
}

// Mirrors Node's Buffer.from(str, "utf8"), including encoding a lone
// surrogate as U+FFFD (EF BF BD). Hand-rolled instead of TextEncoder only so
// this package needs neither DOM nor Node type libraries to typecheck.
function encodeUtf8(input: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of input) {
    let cp = char.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}
