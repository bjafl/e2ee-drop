// apps/web/src/components/NewLinkPage.tsx
//
// /links/new for signed-in users. Storage comes first, because it decides
// where the files can be opened:
//   - "account" (default): POST /api/links/custom, key = the account's own
//     key pair, permanent or one-time.
//   - "browser": a one-time link whose key lives only in this browser — the
//     exact same flow as /create, via the shared useCreateBrowserLink hook.
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Info, Monitor, TriangleAlert, UserRound } from "lucide-react";
import { cn } from "cn";
import type { CreateLinkResponse } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { FieldHint, Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Codewords } from "@/components/common/Codewords";
import { LifetimeBadge, StorageBadge, type LinkStorage } from "@/components/common/LinkBadges";
import { PageContainer, PageHeader } from "@/components/common/Page";
import { BrowserLinkResult } from "@/components/links/BrowserLinkResult";
import { CopyButton } from "@/components/links/CopyButton";
import { useCreateBrowserLink } from "@/components/links/useCreateBrowserLink";
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

type Mode = "permanent" | "one-time";

function ChoiceCard({
  name,
  value,
  checked,
  onSelect,
  children,
  className,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-3 rounded-lg border-2 bg-card p-4 transition-colors duration-150 hover:border-primary has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
        checked ? "border-primary bg-accent" : "border-border",
        className
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 size-5 shrink-0 accent-primary focus-visible:outline-none sm:size-4 sm:mt-1"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-2">{children}</span>
    </label>
  );
}

export function NewLinkPage() {
  const { t } = useTranslation("newLink");
  const { t: tc } = useTranslation("common");
  const [storage, setStorage] = useState<LinkStorage>("account");
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<Mode>("permanent");
  const [visibility, setVisibility] = useState<"public" | "contacts-only">("public");
  const [ownerNote, setOwnerNote] = useState("");
  const [retentionDays, setRetentionDays] = useState<number | "">(DEFAULT_RETENTION_DAYS_PLACEHOLDER);
  const [pin, setPin] = useState("");
  const [created, setCreated] = useState<CreateLinkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const browserLink = useCreateBrowserLink();
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

  const isAccount = storage === "account";
  const retention = retentionDays === "" ? undefined : retentionDays;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isAccount) {
      await browserLink.create({ ownerNote, retentionDays: retention, pin: pin || undefined });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/links/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          mode,
          visibility,
          ownerNote: ownerNote || undefined,
          retentionDays: retention,
        }),
      });
      if (!res.ok) {
        setError(t("errors.createFailed"));
        return;
      }
      setCreated((await res.json()) as CreateLinkResponse);
    } catch {
      setError(t("errors.createFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  if (browserLink.created) {
    return (
      <PageContainer>
        <BrowserLinkResult created={browserLink.created} showAccountUpsell={false} />
      </PageContainer>
    );
  }

  if (created) {
    const url = `${window.location.origin}/send/${created.slug}`;
    return (
      <PageContainer width="narrow">
        <PageHeader title={t("successTitle")}>
          <div className="mt-2 flex flex-wrap gap-2">
            <StorageBadge storage="account" />
            <LifetimeBadge mode={mode} />
          </div>
        </PageHeader>
        <div className="flex flex-col gap-6 rounded-lg border bg-card p-4 md:p-6">
          <div className="flex flex-col gap-2">
            <span className="text-sm leading-5 font-medium">{t("success")}</span>
            <p className="rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-[13px] leading-5 break-all select-all">
              {url}
            </p>
            <CopyButton
              value={url}
              label={t("copyLink")}
              copiedLabel={t("copied")}
              className="h-11 self-start sm:h-9"
            />
          </div>
          {!ownPublicKey && (
            <p className="flex gap-2 text-muted-foreground" data-testid="codewords-relogin">
              <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
              <span>
                {t("codewordsReloginRequired")}{" "}
                <Link to="/login" state={{ returnTo: "/" }} className="font-medium text-primary-text hover:text-primary-text hover:underline">
                  {t("reloginLink")}
                </Link>
              </span>
            </p>
          )}
          {codewords && (
            <div className="flex flex-col gap-3 border-t pt-6">
              <p className="text-muted-foreground">{t("codewordsLabel")}</p>
              <Codewords words={codewords} />
            </div>
          )}
          <Button asChild variant="secondary" className="h-11 self-start sm:h-9">
            <Link to="/">{t("toDashboard")}</Link>
          </Button>
        </div>
      </PageContainer>
    );
  }

  const shownError = error ?? browserLink.error;
  const busy = submitting || browserLink.creating;

  return (
    <PageContainer>
      <PageHeader
        title={t("title")}
        description={t("intro")}
        eyebrow={
          <Link
            to="/"
            className="inline-flex min-h-11 items-center gap-1 self-start text-xs leading-4 font-medium text-primary-text no-underline hover:text-primary-text hover:underline sm:min-h-0"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {t("back")}
          </Link>
        }
      />

      <div className="flex flex-wrap items-start gap-6">
        <form onSubmit={submit} className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          {shownError && (
            <Alert variant="destructive">
              <AlertDescription>{shownError}</AlertDescription>
            </Alert>
          )}

          <div className="rounded-lg border bg-card p-4 md:p-6">
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-3 p-0 text-base leading-6 font-semibold">{t("storageLegend")}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <ChoiceCard name="storage" value="account" checked={isAccount} onSelect={() => setStorage("account")}>
                <span className="flex items-center gap-2">
                  <UserRound className="size-5" aria-hidden="true" />
                  <span className="flex-1 text-base leading-6 font-semibold">{tc("storage.account")}</span>
                  <Badge variant="outline" className="bg-card">
                    {t("recommended")}
                  </Badge>
                </span>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
                  <li>{t("storageAccountBullets.devices")}</li>
                  <li>{t("storageAccountBullets.lifetime")}</li>
                  <li>{t("storageAccountBullets.password")}</li>
                </ul>
              </ChoiceCard>
              <ChoiceCard name="storage" value="browser" checked={!isAccount} onSelect={() => setStorage("browser")}>
                <span className="flex items-center gap-2">
                  <Monitor className="size-5" aria-hidden="true" />
                  <span className="flex-1 text-base leading-6 font-semibold">{tc("storage.browser")}</span>
                </span>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
                  <li>{t("storageBrowserBullets.devices")}</li>
                  <li>{t("storageBrowserBullets.lifetime")}</li>
                  <li>{t("storageBrowserBullets.lost")}</li>
                </ul>
              </ChoiceCard>
            </div>
          </fieldset>
          </div>

          <div className="rounded-lg border bg-card p-4 md:p-6">
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-3 p-0 text-base leading-6 font-semibold">{t("lifetimeLegend")}</legend>
            <div>
              {isAccount ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <ChoiceCard name="mode" value="permanent" checked={mode === "permanent"} onSelect={() => setMode("permanent")} className="p-3">
                    <span className="font-medium">{tc("lifetime.permanent")}</span>
                    <span className="-mt-1 text-xs leading-4 text-muted-foreground">{t("modePermanentHint")}</span>
                  </ChoiceCard>
                  <ChoiceCard name="mode" value="one-time" checked={mode === "one-time"} onSelect={() => setMode("one-time")} className="p-3">
                    <span className="font-medium">{tc("lifetime.oneTime")}</span>
                    <span className="-mt-1 text-xs leading-4 text-muted-foreground">{t("modeOneTimeHint")}</span>
                  </ChoiceCard>
                </div>
              ) : (
                <p className="flex flex-wrap items-center gap-2">
                  <LifetimeBadge mode="one-time" />
                  <span className="text-muted-foreground">{t("browserLifetimeNote")}</span>
                </p>
              )}
            </div>
          </fieldset>
          </div>

          <div className="rounded-lg border bg-card p-4 md:p-6">
          <fieldset className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
            <legend className="mb-3 p-0 text-base leading-6 font-semibold">{t("detailsLegend")}</legend>
            {isAccount && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="slug">{t("slugLabel")}</Label>
                <div className="flex max-w-md items-stretch overflow-hidden rounded-md border border-input bg-background shadow-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
                  <span className="flex items-center border-r bg-muted px-3 font-mono text-[13px] text-muted-foreground" aria-hidden="true">
                    /send/
                  </span>
                  <input
                    id="slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="slug-hint"
                    className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-base outline-none sm:h-[34px] sm:text-[13px]"
                  />
                </div>
                <FieldHint id="slug-hint">{t("slugHint")}</FieldHint>
              </div>
            )}

            {isAccount && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="visibility">{t("visibilityLabel")}</Label>
                <Select
                  value={visibility}
                  items={{ public: t("visibilityPublic"), "contacts-only": t("visibilityContactsOnly") }}
                  onValueChange={(value) => setVisibility(value as "public" | "contacts-only")}
                >
                  <SelectTrigger id="visibility" className="h-11 w-full max-w-md sm:h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">{t("visibilityPublic")}</SelectItem>
                    <SelectItem value="contacts-only">{t("visibilityContactsOnly")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {!isAccount && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="pin">
                  {t("pinLabel")} <span className="font-normal text-muted-foreground">{t("optional")}</span>
                </Label>
                <Input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder={i18n.t("createLink:pinPlaceholder")}
                  className="h-11 max-w-48 sm:h-9"
                />
                <FieldHint className="max-w-prose">{i18n.t("createLink:pinWarning")}</FieldHint>
              </div>
            )}

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
              <FieldHint className="flex items-center gap-1">
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
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))}
                className="h-11 max-w-32 tabular-nums sm:h-9"
              />
            </div>
          </fieldset>
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button asChild variant="ghost" size="lg" className="h-12 sm:h-10">
              <Link to="/">{t("cancel")}</Link>
            </Button>
            <Button type="submit" size="lg" disabled={busy} className="h-12 sm:h-10">
              {busy ? t("creating") : isAccount ? t("createButton") : t("createBrowserButton")}
            </Button>
          </div>
        </form>

        <aside aria-labelledby="summary-heading" className="flex min-w-0 flex-[1_1_280px] flex-col lg:sticky lg:top-6">
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 md:p-6">
            <h2 id="summary-heading" className="text-base leading-6 font-semibold">
              {t("summaryTitle")}
            </h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">{t("summaryKey")}</dt>
              <dd className="font-medium">{isAccount ? tc("storage.account") : tc("storage.browser")}</dd>
              <dt className="text-muted-foreground">{t("summaryLifetime")}</dt>
              <dd>
                {isAccount && mode === "permanent" ? tc("lifetime.permanent") : tc("lifetime.oneTime")}
              </dd>
              <dt className="text-muted-foreground">{t("summaryExpires")}</dt>
              <dd>
                {!isAccount
                  ? t("summaryExpiresBrowser")
                  : mode === "permanent"
                    ? t("summaryExpiresPermanent")
                    : t("summaryExpiresOneTime")}
              </dd>
              <dt className="text-muted-foreground">{t("summaryWhere")}</dt>
              <dd>{isAccount ? t("summaryWhereAccount") : t("summaryWhereBrowser")}</dd>
            </dl>
            {!isAccount && user && (
              <p className="flex gap-2 border-t pt-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span>{t("summaryBrowserWarning")}</span>
              </p>
            )}
          </div>
        </aside>
      </div>
    </PageContainer>
  );
}
