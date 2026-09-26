// apps/web/src/components/CreateLinkPage.tsx
import { useState } from "react";
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

const CODEWORD_DEFAULT_COUNT = 3;

export function CreateLinkPage() {
  const { t, i18n: i18next } = useTranslation("createLink");
  const { saveLink } = useLocalLinks();
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">("");
  const [pin, setPin] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [codewords, setCodewords] = useState<string[]>([]);
  const [showAllCodewords, setShowAllCodewords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);
    setError(null);
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
          retentionDays: retentionDays === "" ? undefined : retentionDays,
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
      setSlug(body.slug);
      setCodewords(body.codewords ?? []);
    } catch {
      setError(t("errors.createFailed"));
    } finally {
      setCreating(false);
    }
  };

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
        {!link && (
          <>
            <div>
              <label htmlFor="ownerNote">{t("ownerNoteLabel")}</label>
              <textarea
                id="ownerNote"
                value={ownerNote}
                onChange={(e) => setOwnerNote(e.target.value)}
                placeholder={t("ownerNotePlaceholder")}
                className="w-full rounded border p-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("ownerNoteWarning")}</p>
            </div>
            <div>
              <label htmlFor="retentionDays">{t("retentionDaysLabel")}</label>
              <input
                id="retentionDays"
                type="number"
                min={1}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full rounded border p-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="pin">{t("pinLabel")}</label>
              <input
                id="pin"
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder={t("pinPlaceholder")}
                className="w-full rounded border p-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("pinWarning")}</p>
            </div>
            <Button onClick={create} disabled={creating}>
              {creating ? t("creating") : t("createButton")}
            </Button>
          </>
        )}
        {link && (
          <>
            <p className="break-all rounded bg-muted p-2 text-sm">{link}</p>
            <Button onClick={copyLink}>{copied ? t("copied") : t("copyLink")}</Button>
            <div>
              <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
              <p className="font-mono text-lg">{visibleCodewords.join(" · ")}</p>
              {codewords.length > CODEWORD_DEFAULT_COUNT && (
                <button type="button" className="text-xs underline" onClick={() => setShowAllCodewords((v) => !v)}>
                  {showAllCodewords ? t("showFewerWords") : t("showMoreWords")}
                </button>
              )}
            </div>
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm text-muted-foreground">{t("downloadPageHint")}</p>
              <Button asChild variant="secondary">
                <Link to={`/receive/${slug}`}>{t("goToDownloadPage")}</Link>
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
