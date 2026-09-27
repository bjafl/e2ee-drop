// apps/web/src/hooks/useCodewords.ts
import { useEffect, useState } from "react";
import { encodeBase64 } from "tweetnacl-util";
import { CODEWORD_WORD_COUNT, deriveCodewords, resolveLocale, type CodewordLocale } from "@e2ee-drop/shared";
import type { AuthUser } from "@/hooks/useAuth";

// Review finding F1: every verification-phrase display in this app derives
// the words HERE, in the browser, from a recipient public key the caller
// passes in — never from an API response's `codewords` field. That is the
// whole point of the phrase: the sender derives it from the exact key it is
// about to encrypt to, the recipient from the key it actually holds, and if a
// compromised server handed the sender a different key the two phrases
// differ. Callers are responsible for passing key material they genuinely
// hold (see each call site's comment for why its source is the right one).
//
// Returns null while the (async, WASM-backed) hash is being computed, or when
// any input is missing — callers render nothing in that case rather than a
// placeholder that could be mistaken for a phrase.
export function useCodewords(
  publicKeyBase64: string | null | undefined,
  linkId: string | null | undefined,
  locale: CodewordLocale | string | null | undefined
): string[] | null {
  const resolvedLocale = resolveLocale(locale);
  const inputKey = publicKeyBase64 && linkId ? `${publicKeyBase64}|${linkId}|${resolvedLocale}` : null;
  const [result, setResult] = useState<{ inputKey: string; words: string[] } | null>(null);

  useEffect(() => {
    if (!publicKeyBase64 || !linkId || !inputKey) return;
    let cancelled = false;
    deriveCodewords(publicKeyBase64, linkId, resolvedLocale, CODEWORD_WORD_COUNT)
      .then((words) => {
        if (!cancelled) setResult({ inputKey, words });
      })
      .catch(() => {
        // Nothing to show rather than something wrong.
      });
    return () => {
      cancelled = true;
    };
  }, [publicKeyBase64, linkId, resolvedLocale, inputKey]);

  // Only ever return words computed for the CURRENT inputs — never a stale
  // phrase from a previous key/link while the new one is still hashing.
  return result && inputKey && result.inputKey === inputKey ? result.words : null;
}

// The logged-in account's own public key, for surfaces where the account IS
// the recipient (its own normal links). Prefers the key derived from the
// private key unwrapped locally at login/register (`user.keyPair`) — genuinely
// local key material the server cannot substitute. Falls back to
// `user.publicKey` only when this tab has no unlocked key pair (a session
// restored from a cookie); that value comes from /api/auth/me, i.e. from the
// server, which is weaker: an attacker who rewrote BOTH the account's stored
// publicKey and the link's recipientPublicKey consistently would go unnoticed
// on this fallback until the user next logs in (after which the local key is
// used again and the phrases stop matching).
export function accountPublicKey(user: AuthUser | null | undefined): string | null {
  if (!user) return null;
  if (user.keyPair) return encodeBase64(user.keyPair.publicKey);
  return user.publicKey || null;
}
