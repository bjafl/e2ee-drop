import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import requestLinkEn from "@/locales/en/requestLink.json";
import requestLinkNb from "@/locales/nb/requestLink.json";

i18n.addResourceBundle("en", "requestLink", requestLinkEn, true, false);
i18n.addResourceBundle("nb", "requestLink", requestLinkNb, true, false);

// I7 (final review): apps/api's env.ts defaults DROP_RETENTION_DAYS_DEFAULT to
// 1, but no frontend-visible response currently exposes the operator's
// configured value before a link exists (see packages/shared/src/api.ts —
// LinkStatusResponse.retentionDays only describes an *existing* link). Per
// the review, hardcoding the documented default as a UI prefill is an
// accepted stand-in until a real "create defaults" response exists; update
// this if the documented backend default ever changes.
const DEFAULT_RETENTION_DAYS_PLACEHOLDER = 1;

export function RequestLinkPage() {
  const { t } = useTranslation("requestLink");
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">(DEFAULT_RETENTION_DAYS_PLACEHOLDER);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const res = await fetch("/api/links/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerNote: ownerNote || undefined,
        retentionDays: retentionDays === "" ? undefined : retentionDays,
      }),
    });
    if (!res.ok) {
      setError(t("errors.createFailed"));
      return;
    }
    const body = await res.json();
    setCreatedSlug(body.slug);
  };

  const link = createdSlug ? `${window.location.origin}/receive/${createdSlug}` : null;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {link && (
          <>
            <p>
              {t("success")} <code className="break-all">{link}</code>
            </p>
            {/* I4 (final review): without this, the initiator has no way back
                to /send/:slug — the page where they'd actually go to send the
                file once the recipient claims this link (design spec §4.1/§4.2).
                Mirrors CreateLinkPage's "go to your download page" pattern, just
                pointing the other direction. */}
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm text-muted-foreground">{t("sendPageHint")}</p>
              <Button asChild variant="secondary">
                <Link to={`/send/${createdSlug}`}>{t("goToSendPage")}</Link>
              </Button>
            </div>
          </>
        )}
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
            <Button onClick={submit}>{t("createButton")}</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
