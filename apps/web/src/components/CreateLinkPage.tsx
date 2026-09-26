// apps/web/src/components/CreateLinkPage.tsx
import { useEffect, useState } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { CreateLinkResponse } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import i18n from "@/i18n";
import createLinkEn from "@/locales/en/createLink.json";
import createLinkNb from "@/locales/nb/createLink.json";

i18n.addResourceBundle("en", "createLink", createLinkEn, true, false);
i18n.addResourceBundle("nb", "createLink", createLinkNb, true, false);

export function CreateLinkPage() {
  const { t, i18n: i18next } = useTranslation("createLink");
  const { saveLink } = useLocalLinks();
  const [slug, setSlug] = useState<string | null>(null);
  const [codewords, setCodewords] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (slug) return;
    let cancelled = false;
    async function create() {
      try {
        const keyPair = nacl.box.keyPair();
        const locale = i18next.language?.startsWith("nb") ? "nb" : "en";
        const response = await fetch("/api/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipientPublicKey: encodeBase64(keyPair.publicKey), locale }),
        });
        if (!response.ok) throw new Error("create failed");
        const body = (await response.json()) as CreateLinkResponse;
        if (cancelled) return;
        // POST /api/links (one-time, anonymous links only) always sets expiresAt
        // server-side — CreateLinkResponse.expiresAt is only optional because the
        // same response type is reused by POST /api/links/custom, whose permanent
        // links have none. Treat a missing one here as a malformed response.
        if (body.expiresAt === undefined) throw new Error("create failed: missing expiresAt");
        // Keep the private key exactly as long as the server keeps the link
        // (operator-configurable LINK_EXPIRY_HOURS) — forgetting it earlier would
        // make a later drop on a still-valid link undecryptable.
        saveLink(body.slug, encodeBase64(keyPair.secretKey), body.expiresAt);
        setSlug(body.slug);
        setCodewords(body.codewords ?? []);
      } catch {
        if (!cancelled) setError(t("errors.createFailed"));
      }
    }
    create();
    return () => {
      cancelled = true;
    };
  }, [slug, saveLink, t, i18next]);

  const link = slug ? `${window.location.origin}/send/${slug}` : null;

  const copyLink = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {link && (
          <>
            <p className="break-all rounded bg-muted p-2 text-sm">{link}</p>
            <Button onClick={copyLink}>{copied ? t("copied") : t("copyLink")}</Button>
            <div>
              <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
              <p className="font-mono text-lg">{codewords.join(" · ")}</p>
            </div>
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm text-muted-foreground">{t("downloadPageHint")}</p>
              <Button asChild variant="secondary">
                <Link to={`/download/${slug}`}>{t("goToDownloadPage")}</Link>
              </Button>
            </div>
          </>
        )}
        {!link && !error && <p>{t("creating")}</p>}
      </CardContent>
    </Card>
  );
}
