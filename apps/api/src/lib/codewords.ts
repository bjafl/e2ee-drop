// apps/api/src/lib/codewords.ts
import { createHash } from "node:crypto";
import { WORDLISTS, DEFAULT_LOCALE, type CodewordLocale } from "./wordlists";

export const CODEWORD_DEFAULT_COUNT = 3;
export const CODEWORD_MAX_COUNT = 5;

export function resolveLocale(locale: string | undefined): CodewordLocale {
  return locale === "en" || locale === "nb" ? locale : DEFAULT_LOCALE;
}

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
