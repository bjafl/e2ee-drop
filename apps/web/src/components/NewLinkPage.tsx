import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import newLinkEn from "@/locales/en/newLink.json";
import newLinkNb from "@/locales/nb/newLink.json";

i18n.addResourceBundle("en", "newLink", newLinkEn, true, false);
i18n.addResourceBundle("nb", "newLink", newLinkNb, true, false);

export function NewLinkPage() {
  const { t } = useTranslation("newLink");
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<"permanent" | "one-time">("permanent");
  const [visibility, setVisibility] = useState<"public" | "contacts-only">("public");
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const res = await fetch("/api/links/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, mode, visibility }),
    });
    if (!res.ok) {
      setError(t("errors.createFailed"));
      return;
    }
    const body = await res.json();
    setCreatedSlug(body.slug);
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {createdSlug && (
          <p>
            {t("success")} <code>{createdSlug}</code>
          </p>
        )}
        <div>
          <label htmlFor="slug">{t("slugLabel")}</label>
          <input id="slug" value={slug} onChange={(e) => setSlug(e.target.value)} className="w-full rounded border p-2 text-sm" />
        </div>
        <div>
          <label htmlFor="mode">{t("modeLabel")}</label>
          <select
            id="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as "permanent" | "one-time")}
            className="w-full rounded border p-2 text-sm"
          >
            <option value="permanent">{t("modePermanent")}</option>
            <option value="one-time">{t("modeOneTime")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="visibility">{t("visibilityLabel")}</label>
          <select
            id="visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "public" | "contacts-only")}
            className="w-full rounded border p-2 text-sm"
          >
            <option value="public">{t("visibilityPublic")}</option>
            <option value="contacts-only">{t("visibilityContactsOnly")}</option>
          </select>
        </div>
        <Button onClick={submit}>{t("createButton")}</Button>
      </CardContent>
    </Card>
  );
}
