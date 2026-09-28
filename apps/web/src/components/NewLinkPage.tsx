import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CreateLinkResponse } from "@e2ee-drop/shared";
import { useAuth } from "@/hooks/useAuth";
import { accountPublicKey, useCodewords } from "@/hooks/useCodewords";
import i18n from "@/i18n";
import newLinkEn from "@/locales/en/newLink.json";
import newLinkNb from "@/locales/nb/newLink.json";

i18n.addResourceBundle("en", "newLink", newLinkEn, true, false);
i18n.addResourceBundle("nb", "newLink", newLinkNb, true, false);

// I7 (final review): mirrors apps/api/src/env.ts's DROP_RETENTION_DAYS_DEFAULT
// (1) — no frontend-visible response exposes the operator-configured value
// before a link exists (see the same comment in RequestLinkPage.tsx). Update
// if the documented backend default ever changes.
const DEFAULT_RETENTION_DAYS_PLACEHOLDER = 1;

export function NewLinkPage() {
  const { t } = useTranslation("newLink");
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<"permanent" | "one-time">("permanent");
  const [visibility, setVisibility] = useState<"public" | "contacts-only">("public");
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">(DEFAULT_RETENTION_DAYS_PLACEHOLDER);
  const [created, setCreated] = useState<CreateLinkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();
  // Review finding F1: POST /api/links/custom always creates a link whose
  // recipient IS this account (recipientPublicKey = owner.publicKey,
  // server-side) — it never creates a sender-initiated request link — so the
  // phrase the sender will see is derived from this account's own public
  // key. Derived here from the key pair unwrapped at login (accountPublicKey),
  // never from the response's `codewords` field nor the server-reported
  // user.publicKey. Without an unwrapped key pair in this tab (a restored
  // session) there is nothing trustworthy to derive from, so a re-login hint
  // is shown instead.
  const ownPublicKey = accountPublicKey(user);
  const codewords = useCodewords(ownPublicKey, created?.linkId, created?.codewordLocale);

  const submit = async () => {
    setError(null);
    const res = await fetch("/api/links/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        mode,
        visibility,
        ownerNote: ownerNote || undefined,
        retentionDays: retentionDays === "" ? undefined : retentionDays,
      }),
    });
    if (!res.ok) {
      setError(t("errors.createFailed"));
      return;
    }
    const body = (await res.json()) as CreateLinkResponse;
    setCreated(body);
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {created && (
          <p>
            {t("success")} <code>{created.slug}</code>
          </p>
        )}
        {created && !ownPublicKey && (
          <p className="text-sm text-muted-foreground" data-testid="codewords-relogin">
            {t("codewordsReloginRequired")}{" "}
            <Link to="/login" state={{ returnTo: "/" }} className="underline">
              {t("reloginLink")}
            </Link>
          </p>
        )}
        {created && codewords && (
          <div>
            <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
            <p className="font-mono text-lg" data-testid="codewords">
              {codewords.join(" · ")}
            </p>
          </div>
        )}
        <div>
          <label htmlFor="slug">{t("slugLabel")}</label>
          <input id="slug" value={slug} onChange={(e) => setSlug(e.target.value)} className="w-full rounded border p-2 text-sm" />
        </div>
        <div>
          <label htmlFor="mode">{t("modeLabel")}</label>
          <Select value={mode} onValueChange={(value) => setMode(value as "permanent" | "one-time")}>
            <SelectTrigger id="mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="permanent">{t("modePermanent")}</SelectItem>
              <SelectItem value="one-time">{t("modeOneTime")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor="visibility">{t("visibilityLabel")}</label>
          <Select
            value={visibility}
            onValueChange={(value) => setVisibility(value as "public" | "contacts-only")}
          >
            <SelectTrigger id="visibility" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">{t("visibilityPublic")}</SelectItem>
              <SelectItem value="contacts-only">{t("visibilityContactsOnly")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
      </CardContent>
    </Card>
  );
}
