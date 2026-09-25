// apps/api/src/lib/codewords.ts
import { createHash } from "node:crypto";
import { WORDLISTS, DEFAULT_LOCALE, type CodewordLocale } from "./wordlists";

export const CODEWORD_DEFAULT_COUNT = 3;
export const CODEWORD_MAX_COUNT = 5;

export function resolveLocale(locale: string | undefined): CodewordLocale {
  return locale === "en" || locale === "nb" ? locale : DEFAULT_LOCALE;
}

// KNOWN LIMITATION (final Plan 1 review, finding I5), to fix before Plan 2
// builds more on this design: codewords are derived only here, on the server,
// and every client just displays the words the API returns. The comparison
// therefore can't catch a server that swaps recipientPublicKey in the DB (a
// compromised server or DB). The server would simply derive words from the
// swapped key and send the same words to both sides. To make the check
// end-to-end, move deriveCodewords and the wordlists into packages/shared, and
// have CreateLinkPage (from its own freshly generated key), UploadPage (from the
// recipientPublicKey it actually encrypts to) and DownloadPage derive the words
// client-side instead of trusting the `codewords` field in API responses.
export function deriveCodewords(
  publicKeyBase64: string,
  locale: CodewordLocale,
  count: number = CODEWORD_MAX_COUNT
): string[] {
  const wordlist = WORDLISTS[locale];
  const keyBytes = Buffer.from(publicKeyBase64, "base64");
  const hash = createHash("sha256").update(keyBytes).digest();
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(wordlist[hash[i % hash.length]]);
  }
  return words;
}
