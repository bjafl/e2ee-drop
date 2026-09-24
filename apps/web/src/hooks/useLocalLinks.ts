// apps/web/src/hooks/useLocalLinks.ts
import { useCallback, useEffect, useState } from "react";

export interface StoredLink {
  privateKey: string; // base64
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

  const saveLink = useCallback((slug: string, privateKey: string, expiresAt: number) => {
    setLinks((prev) => ({ ...prev, [slug]: { privateKey, createdAt: Date.now(), expiresAt } }));
  }, []);

  const removeLink = useCallback((slug: string) => {
    setLinks((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  return { links, saveLink, removeLink };
}
