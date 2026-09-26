// apps/api/src/lib/codewords.ts
import { createHash } from "node:crypto";
import { WORDLISTS, DEFAULT_LOCALE, type CodewordLocale } from "./wordlists";

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
//
// `linkId` is folded into the hash alongside the public key so that two links
// belonging to the same owner — who therefore share the same recipientPublicKey
// (see createDefaultLinkForUser / POST /api/links/custom) — get different
// codewords. Without it, every link a given user owns would display the exact
// same phrase forever, since the hash input would never change. `count` comes
// from env.CODEWORD_WORD_COUNT (see env.ts): this app accepts a small,
// deliberately-chosen probability of two unrelated, simultaneously active
// links coincidentally sharing a phrase (a UX nuisance, not a security
// break — an attacker or typo hitting one SPECIFIC target link's phrase is a
// separate, much smaller 1-in-256^count odds, independent of how many other
// links exist) rather than enforcing global uniqueness with a DB constraint
// and a retry-on-collision loop.
export function deriveCodewords(
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
