// apps/web/src/components/links/BrowserLinkResult.tsx
//
// "Your link is ready" for a browser-key, one-time link: share (copy / native
// share / QR), compare verification words, then wait on the download page.
// The storage badge and the key banner make it explicit that the private key
// exists only in this browser.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import QRCode from "react-qr-code";
import { ChevronDown, Download, Share2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Codewords } from "@/components/common/Codewords";
import { LifetimeBadge, StorageBadge } from "@/components/common/LinkBadges";
import { PageHeader } from "@/components/common/Page";
import { useCodewords } from "@/hooks/useCodewords";
import { formatDateTime, formatTimeLeft } from "@/lib/format";
import { CopyButton } from "./CopyButton";
import type { CreatedBrowserLink } from "./useCreateBrowserLink";

export function BrowserLinkResult({
  created,
  showAccountUpsell = true,
}: {
  created: CreatedBrowserLink;
  showAccountUpsell?: boolean;
}) {
  const { t } = useTranslation("createLink");
  const { t: tc } = useTranslation("common");
  const [showQr, setShowQr] = useState(false);
  const link = `${window.location.origin}/send/${created.slug}`;
  const codewords = useCodewords(created.publicKey, created.linkId, created.locale);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const share = async () => {
    try {
      await navigator.share({ url: link });
    } catch {
      // Dismissed share sheet — nothing to do.
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0 md:mb-0"
        title={t("readyTitle")}
        description={t("readyDescription")}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StorageBadge storage="browser" />
          <LifetimeBadge mode="one-time" />
        </div>
      </PageHeader>

      <Alert variant="warning" role="note">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{t("keyBannerTitle")}</AlertTitle>
        <AlertDescription>
          {t("keyBannerBody")}{" "}
          <span className="font-medium whitespace-nowrap text-foreground tabular-nums">
            {t("expiresIn", { timeLeft: formatTimeLeft(created.expiresAt) })}
          </span>
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <section aria-labelledby="share-heading" className="flex flex-col gap-4 rounded-lg border bg-card p-4 md:p-6">
            <h2 id="share-heading" className="text-base leading-6 font-semibold">
              {t("stepShare")}
            </h2>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="text-sm leading-5 font-medium">{t("linkLabel")}</span>
                <p className="rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-[13px] leading-5 break-all select-all">
                  {link}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <CopyButton
                    value={link}
                    label={t("copyLink")}
                    copiedLabel={t("copied")}
                    className="h-11 sm:h-9"
                  />
                  {canShare && (
                    <Button type="button" variant="secondary" onClick={share} className="h-11 sm:h-9">
                      <Share2 />
                      {t("share")}
                    </Button>
                  )}
                </div>
                <p className="text-xs leading-4 text-muted-foreground">{t("linkHint")}</p>
              </div>
              <div className="flex flex-col items-start gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 px-0 text-primary sm:hidden"
                  aria-expanded={showQr}
                  onClick={() => setShowQr((v) => !v)}
                >
                  {showQr ? t("hideQr") : t("showQr")}
                  <ChevronDown className={showQr ? "rotate-180 transition-transform" : "transition-transform"} />
                </Button>
                <div
                  role="img"
                  aria-label={t("qrLabel")}
                  className={`${showQr ? "flex" : "hidden"} rounded-md border bg-white p-2 sm:flex`}
                >
                  <QRCode value={link} size={112} />
                </div>
              </div>
            </div>
          </section>

          {codewords && (
            <section aria-labelledby="verify-heading" className="flex flex-col gap-3 rounded-lg border bg-card p-4 md:p-6">
              <h2 id="verify-heading" className="text-base leading-6 font-semibold">
                {t("stepVerify")}
              </h2>
              <p className="text-muted-foreground">{t("codewordsLabel")}</p>
              {/* All CODEWORD_WORD_COUNT words, the same count the sender's
                  page shows (finding F1, Step 3) — no truncated preview. */}
              <Codewords words={codewords} />
            </section>
          )}

          <section aria-labelledby="incoming-heading" className="flex flex-col gap-3 rounded-lg border bg-card p-4 md:p-6">
            <h2 id="incoming-heading" className="text-base leading-6 font-semibold">
              {t("stepIncoming")}
            </h2>
            <p className="text-muted-foreground">{t("downloadPageHint")}</p>
            <Button asChild className="h-11 self-start sm:h-9">
              <Link to={`/receive/${created.slug}`}>
                <Download />
                {t("goToDownloadPage")}
              </Link>
            </Button>
          </section>
        </div>

        <aside aria-labelledby="details-heading" className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 md:p-6">
            <h2 id="details-heading" className="text-base leading-6 font-semibold">
              {t("detailsTitle")}
            </h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">{t("detailKey")}</dt>
              <dd>{tc("storage.browser")}</dd>
              <dt className="text-muted-foreground">{t("detailLifetime")}</dt>
              <dd>{tc("lifetime.oneTime")}</dd>
              <dt className="text-muted-foreground">{t("detailExpires")}</dt>
              <dd className="font-medium tabular-nums">{formatDateTime(created.expiresAt)}</dd>
              <dt className="text-muted-foreground">{t("detailRetention")}</dt>
              <dd>
                {created.retentionDays
                  ? t("detailRetentionValue", { count: created.retentionDays })
                  : t("detailRetentionDefault")}
              </dd>
              <dt className="text-muted-foreground">{t("detailPin")}</dt>
              <dd>{created.pinProtected ? t("pinSet") : t("pinNotSet")}</dd>
              <dt className="text-muted-foreground">{t("detailNote")}</dt>
              <dd className="break-words">{created.ownerNote ?? t("noteNone")}</dd>
            </dl>
          </div>
          {showAccountUpsell && (
            <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
              <p className="font-semibold">{t("upsellTitle")}</p>
              <p className="text-muted-foreground">{t("upsellBody")}</p>
              <Link to="/register" className="inline-flex min-h-11 items-center font-medium text-primary hover:text-primary-hover sm:min-h-0">
                {t("createAccount")}
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
