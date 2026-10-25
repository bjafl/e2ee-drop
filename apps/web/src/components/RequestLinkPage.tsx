import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowRight, Check, Copy, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label, FieldHint } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/auth/AuthLayout";
import { PageContainer } from "@/components/common/Page";
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
  const [copied, setCopied] = useState(false);

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

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the link is still selectable.
    }
  };

  return (
    <PageContainer width="form">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl leading-7 tracking-[-0.01em]">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && <FormError>{error}</FormError>}
          {link && (
            <>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{t("success")}</p>
                <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 py-1 pr-1 pl-3">
                  <code className="min-w-0 flex-1 font-mono text-[13px] leading-5 break-all">{link}</code>
                  <Button type="button" size="sm" onClick={copy}>
                    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {copied ? t("copied") : t("copyLink")}
                  </Button>
                </div>
                <FieldHint>{t("shareHint")}</FieldHint>
              </div>
              {/* I4 (final review): without this, the initiator has no way back
                  to /send/:slug — the page where they'd actually go to send the
                  file once the recipient claims this link (design spec §4.1/§4.2).
                  Mirrors CreateLinkPage's "go to your download page" pattern, just
                  pointing the other direction. */}
              <div className="flex flex-col gap-3 border-t pt-4">
                <p className="flex gap-2 text-sm text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
                  <span>{t("sendPageHint")}</span>
                </p>
                <Button asChild variant="secondary" className="self-start">
                  <Link to={`/send/${createdSlug}`}>
                    {t("goToSendPage")}
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </>
          )}
          {!link && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ownerNote">{t("ownerNoteLabel")}</Label>
                <Textarea
                  id="ownerNote"
                  rows={3}
                  value={ownerNote}
                  onChange={(e) => setOwnerNote(e.target.value)}
                  placeholder={t("ownerNotePlaceholder")}
                  aria-describedby="ownerNote-hint"
                />
                <FieldHint id="ownerNote-hint" className="flex items-center gap-1">
                  <Info className="size-3.5 shrink-0" aria-hidden="true" />
                  {t("ownerNoteWarning")}
                </FieldHint>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="retentionDays">{t("retentionDaysLabel")}</Label>
                <Input
                  id="retentionDays"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className="w-32 tabular-nums"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </div>
              <Button size="lg" className="mt-2 self-end" onClick={submit}>
                {t("createButton")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
