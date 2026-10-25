// apps/web/src/components/CreateLinkPage.tsx
//
// /create: a one-time receive link whose private key lives only in this
// browser. Key generation and storage live in useCreateBrowserLink (shared
// with NewLinkPage's "This browser" option); this page is the form and the
// "Your link is ready" result.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldHint, Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageContainer, PageHeader } from "@/components/common/Page";
import { BrowserLinkResult } from "@/components/links/BrowserLinkResult";
import { useCreateBrowserLink } from "@/components/links/useCreateBrowserLink";

// I7 (final review): mirrors apps/api/src/env.ts's DROP_RETENTION_DAYS_DEFAULT
// (1) — no frontend-visible response exposes the operator-configured value
// before a link exists (see the same comment in RequestLinkPage.tsx). Update
// if the documented backend default ever changes.
const DEFAULT_RETENTION_DAYS_PLACEHOLDER = 1;

export function CreateLinkPage() {
  const { t } = useTranslation("createLink");
  const { create, created, creating, error } = useCreateBrowserLink();
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">(DEFAULT_RETENTION_DAYS_PLACEHOLDER);
  const [pin, setPin] = useState("");

  if (created) {
    return (
      <PageContainer>
        <BrowserLinkResult created={created} />
      </PageContainer>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create({
      ownerNote,
      retentionDays: retentionDays === "" ? undefined : retentionDays,
      pin: pin || undefined,
    });
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("title")} description={t("intro")} />
      <form onSubmit={submit} className="flex flex-col gap-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Alert variant="info" role="note">
          <Monitor aria-hidden="true" />
          <AlertTitle>{t("browserNoteTitle")}</AlertTitle>
          <AlertDescription>
            {t("browserNoteBody")} {t("accountNudge")}{" "}
            <Link to="/register" className="font-medium text-primary-text no-underline hover:text-primary-text hover:underline">
              {t("createAccount")}
            </Link>
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-5 rounded-lg border bg-card p-4 md:p-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ownerNote">
              {t("ownerNoteLabel")} <span className="font-normal text-muted-foreground">{t("optional")}</span>
            </Label>
            <Textarea
              id="ownerNote"
              rows={2}
              value={ownerNote}
              onChange={(e) => setOwnerNote(e.target.value)}
              placeholder={t("ownerNotePlaceholder")}
            />
            <FieldHint>{t("ownerNoteWarning")}</FieldHint>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="retentionDays">{t("retentionDaysLabel")}</Label>
            <Input
              id="retentionDays"
              type="number"
              min={1}
              inputMode="numeric"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))}
              className="max-w-32 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pin">{t("pinLabel")}</Label>
            <Input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder={t("pinPlaceholder")}
              className="max-w-48"
            />
            <FieldHint className="max-w-prose">{t("pinWarning")}</FieldHint>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={creating} className="h-12 w-full sm:h-10 sm:w-auto">
            {creating ? t("creating") : t("createButton")}
          </Button>
        </div>
      </form>
    </PageContainer>
  );
}
