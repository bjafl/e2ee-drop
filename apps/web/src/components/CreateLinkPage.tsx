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

const LINK_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CODEWORD_DEFAULT_COUNT = 3;

export function CreateLinkPage() {
  const { t, i18n: i18next } = useTranslation("createLink");
  const { saveLink } = useLocalLinks();
  const [slug, setSlug] = useState<string | null>(null);
  const [codewords, setCodewords] = useState<string[]>([]);
  const [showAllCodewords, setShowAllCodewords] = useState(false);
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
        saveLink(body.slug, encodeBase64(keyPair.secretKey), Date.now() + LINK_EXPIRY_MS);
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
  const visibleCodewords = showAllCodewords ? codewords : codewords.slice(0, CODEWORD_DEFAULT_COUNT);

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
              <p className="font-mono text-lg">{visibleCodewords.join(" · ")}</p>
              {codewords.length > CODEWORD_DEFAULT_COUNT && (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setShowAllCodewords((v) => !v)}
                >
                  {showAllCodewords ? t("showFewerWords") : t("showMoreWords")}
                </button>
              )}
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
