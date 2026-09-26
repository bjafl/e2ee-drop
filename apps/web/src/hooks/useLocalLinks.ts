// apps/web/src/hooks/useLocalLinks.ts
import { useCallback, useEffect, useState } from "react";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
} from "@/lib/keyWrapping";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";

export interface StoredLink {
  // Exactly one of these two is set: `privateKey` for an unprotected key (unchanged from before
  // this task), `wrapped`+`salt` for a PIN-protected one (design spec §3.4, reusing lib/keyWrapping.ts
  // as-is — the same argon2id-then-nacl.secretbox primitives the account password flow already uses).
  privateKey?: string;
  wrapped?: string;
  salt?: string;
  pinProtected: boolean;
  createdAt: number;
  expiresAt: number;
}

type LocalLinks = Record<string, StoredLink>;

const STORAGE_KEY = "e2ee-drop:links";

export function useLocalLinks() {
  const [links, setLinks] = useState<LocalLinks>(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: LocalLinks = JSON.parse(raw);
      const now = Date.now();
      for (const slug of Object.keys(parsed)) {
        if (parsed[slug].expiresAt < now) delete parsed[slug];
      }
      return parsed;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
    } catch {
      // localStorage unavailable (private mode / quota) — link still usable for this tab session
    }
  }, [links]);

  const saveLink = useCallback(
    async (slug: string, privateKey: string, expiresAt: number, pin?: string) => {
      const createdAt = Date.now();
      if (!pin) {
        setLinks((prev) => ({ ...prev, [slug]: { privateKey, pinProtected: false, createdAt, expiresAt } }));
        return;
      }
      const salt = generateWrappingSalt();
      const wrappingKey = await deriveWrappingKey(pin, salt);
      const wrapped = wrapPrivateKey(decodeBase64(privateKey), wrappingKey);
      setLinks((prev) => ({ ...prev, [slug]: { wrapped, salt, pinProtected: true, createdAt, expiresAt } }));
    },
    []
  );

  // Returns the raw base64 private key, prompting-free for an unprotected entry. Throws (from
  // unwrapPrivateKey, unchanged from lib/keyWrapping.ts) on a wrong or missing PIN for a
  // pin-protected entry.
  const unlockLink = useCallback(
    async (slug: string, pin?: string): Promise<string> => {
      const stored = links[slug];
      if (!stored) throw new Error("No local key found for this link");
      if (!stored.pinProtected) return stored.privateKey!;
      if (!pin) throw new Error("This link's key is PIN-protected");
      const wrappingKey = await deriveWrappingKey(pin, stored.salt!);
      const unwrapped = unwrapPrivateKey(stored.wrapped!, wrappingKey);
      return encodeBase64(unwrapped);
    },
    [links]
  );

  const removeLink = useCallback((slug: string) => {
    setLinks((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  return { links, saveLink, unlockLink, removeLink };
}
