// apps/web/src/components/links/useCreateBrowserLink.ts
//
// Creates a one-time link whose private key lives only in this browser
// (POST /api/links + useLocalLinks). Shared by CreateLinkPage (/create) and
// NewLinkPage's "This browser" option, so the key-handling logic exists once.
import { useState } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { useTranslation } from "react-i18next";
import type { CreateLinkResponse } from "@e2ee-drop/shared";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import { isLocalStorageWritable } from "@/lib/storageProbe";
import i18n from "@/i18n";
import createLinkEn from "@/locales/en/createLink.json";
import createLinkNb from "@/locales/nb/createLink.json";

i18n.addResourceBundle("en", "createLink", createLinkEn, true, false);
i18n.addResourceBundle("nb", "createLink", createLinkNb, true, false);

export interface BrowserLinkOptions {
  ownerNote?: string;
  retentionDays?: number;
  pin?: string;
}

export interface CreatedBrowserLink {
  slug: string;
  // Review finding F1: the phrase is derived locally from the public half of
  // the key pair generated here (the only copy of its private key goes into
  // this browser's storage, never to the server), plus the new link's id and
  // wordlist locale — never from the response's `codewords` field.
  publicKey: string;
  linkId: string;
  locale: string;
  expiresAt: number;
  pinProtected: boolean;
  ownerNote?: string;
  retentionDays?: number;
}

export function useCreateBrowserLink() {
  const { t, i18n: i18next } = useTranslation("createLink");
  const { saveLink } = useLocalLinks();
  const [created, setCreated] = useState<CreatedBrowserLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const create = async ({ ownerNote, retentionDays, pin }: BrowserLinkOptions) => {
    setError(null);
    // Task 9 / F9 (step 1, strategy a): the create call below persists its
    // private key the same way ReceivePage.tsx's anonymous claim does — via
    // saveLink -> useLocalLinks' localStorage write, whose actual
    // localStorage.setItem happens later, decoupled, inside that hook's own
    // useEffect (try/catch, no re-throw). Awaiting saveLink can't surface a
    // storage failure, so probe storage directly first, same as ClaimView.
    // Milder consequence than the claim flow (an unused link just expires
    // server-side), but still worth refusing rather than silently leaving the
    // key in memory only.
    if (!isLocalStorageWritable()) {
      setError(t("errors.storageUnavailable"));
      return;
    }
    setCreating(true);
    try {
      const keyPair = nacl.box.keyPair();
      const locale = i18next.language?.startsWith("nb") ? "nb" : "en";
      const response = await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientPublicKey: encodeBase64(keyPair.publicKey),
          locale,
          ownerNote: ownerNote || undefined,
          retentionDays,
        }),
      });
      if (!response.ok) throw new Error("create failed");
      const body = (await response.json()) as CreateLinkResponse;
      // POST /api/links (one-time, anonymous links only) always sets expiresAt
      // server-side — CreateLinkResponse.expiresAt is only optional because the
      // same response type is reused by POST /api/links/custom, whose permanent
      // links have none. Treat a missing one here as a malformed response.
      if (body.expiresAt === undefined) throw new Error("create failed: missing expiresAt");
      // Keep the private key exactly as long as the server keeps the link
      // (operator-configurable LINK_EXPIRY_HOURS) — forgetting it earlier would
      // make a later drop on a still-valid link undecryptable. Optionally wrapped
      // with the owner's PIN (design spec §3.4) before being written to storage.
      await saveLink(body.slug, encodeBase64(keyPair.secretKey), body.expiresAt, pin || undefined);
      // The server's codewordLocale is harmless to use (it only picks the
      // wordlist; the hash comes from our own key) and keeps this phrase on
      // the same wordlist the sender's page will use for this link.
      setCreated({
        slug: body.slug,
        publicKey: encodeBase64(keyPair.publicKey),
        linkId: body.linkId,
        locale: body.codewordLocale ?? locale,
        expiresAt: body.expiresAt,
        pinProtected: Boolean(pin),
        ownerNote: ownerNote || undefined,
        retentionDays,
      });
    } catch {
      setError(t("errors.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  return { create, created, creating, error };
}
