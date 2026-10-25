// apps/web/src/components/HomePage.tsx
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronRight,
  Download,
  Info,
  KeyRound,
  Link2,
  Plus,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { cn } from "cn";
import type { InboxCounterparty, InboxResponse, LinkMode, ListLinksResponse, LinkSummary } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CodewordsInline } from "@/components/common/Codewords";
import { LifetimeBadge, StorageBadge, type LinkStorage } from "@/components/common/LinkBadges";
import { PageContainer, PageHeader, SectionTitle } from "@/components/common/Page";
import { CopyButton } from "@/components/links/CopyButton";
import { useAuth } from "@/hooks/useAuth";
import { accountPublicKey, useCodewords } from "@/hooks/useCodewords";
import { useLocalLinks, type StoredLink } from "@/hooks/useLocalLinks";
import { formatDate, formatTimeLeft } from "@/lib/format";
import i18n from "@/i18n";
import homeEn from "@/locales/en/home.json";
import homeNb from "@/locales/nb/home.json";

i18n.addResourceBundle("en", "home", homeEn, true, false);
i18n.addResourceBundle("nb", "home", homeNb, true, false);

const SOURCE_URL = "https://github.com/bjafl/e2ee-drop";

// Review finding F1: the owner's own view of a link's verification phrase,
// derived locally from the key pair unwrapped at login (accountPublicKey) —
// never from an API `codewords` field nor the server-reported user.publicKey.
// A restored session has no unwrapped key pair, so the dashboard shows a
// re-login hint instead of any phrase (see accountPublicKey).
//
// GET /api/links lists EVERY link this account owns, including
// sender-initiated request links (POST /api/links/request), whose recipient
// key is null (unclaimed) or belongs to whoever claimed them — never to this
// account. Deriving from the owner's key for such a row would display a
// phrase for the wrong key while looking like a legitimate comparison. So the
// phrase is rendered ONLY for rows the server positively reports as
// `recipientIsOwner` (the owner's default link, or one from POST
// /api/links/custom), and omitted for everything else. A lying server can at
// most hide a phrase here or make it fail to match the sender's — it can't
// fabricate a match, because the words themselves always come from this
// account's own key.
function OwnLinkCodewords({ link, publicKey }: { link: LinkSummary; publicKey: string | null }) {
  const { t } = useTranslation("home");
  const codewords = useCodewords(link.recipientIsOwner ? publicKey : null, link.linkId, link.codewordLocale);
  if (!link.recipientIsOwner) {
    return <span className="text-xs text-muted-foreground">{t("codewordsShownToRecipient")}</span>;
  }
  if (!codewords) return null;
  return <CodewordsInline words={codewords} testId={`codewords-${link.slug}`} />;
}

type Tone = "success" | "info" | "muted" | "destructive";
const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  info: "text-info",
  muted: "text-muted-foreground",
  destructive: "text-destructive",
};
const TONE_DOT: Record<Tone, string> = {
  success: "bg-success",
  info: "bg-info",
  muted: "bg-muted-foreground",
  destructive: "bg-destructive",
};

function StatusLabel({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs leading-4 font-medium whitespace-nowrap", TONE_TEXT[tone])}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
      {children}
    </span>
  );
}

function sendUrl(slug: string) {
  return `${window.location.origin}/send/${slug}`;
}

// One responsive grid row, shared by the column header and every link row: a
// card-like stack on mobile, a table-like row from lg. The two `lg:contents`
// groups (badges, status+expiry) sit on one line each on mobile and dissolve
// into separate columns on desktop.
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 lg:grid-cols-[minmax(0,1.4fr)_9.5rem_5.5rem_minmax(0,1.6fr)_8.5rem_7rem_2.5rem] lg:items-center lg:gap-x-3";

interface RowProps {
  slug: string;
  kind: string;
  storage: LinkStorage;
  mode: LinkMode;
  status: { tone: Tone; label: string };
  expires: string;
  expiresWarn?: boolean;
  revoked?: boolean;
  href?: string;
  codewords?: ReactNode;
}

function LinkRow({ slug, kind, storage, mode, status, expires, expiresWarn, revoked, href, codewords }: RowProps) {
  const { t } = useTranslation("home");
  const slugText = (
    <span className={cn("font-mono text-[13px] leading-5 break-all", revoked && "text-muted-foreground line-through")}>
      {slug}
    </span>
  );
  return (
    <li className={cn(ROW_GRID, "border-t px-4 py-3 transition-colors duration-150 hover:bg-accent/60 lg:px-6")}>
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col lg:col-auto lg:row-auto">
        {href ? (
          <Link to={href} className="self-start text-foreground no-underline hover:text-primary">
            {slugText}
          </Link>
        ) : (
          slugText
        )}
        <span className="text-xs leading-4 text-muted-foreground">{kind}</span>
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-1.5 lg:contents">
        <div>
          <StorageBadge storage={storage} />
        </div>
        <div>
          <LifetimeBadge mode={mode} />
        </div>
      </div>
      <div className={cn("col-span-2 min-w-0 lg:col-span-1", !codewords && "hidden lg:block")}>{codewords}</div>
      <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 lg:contents">
        <div>
          <StatusLabel tone={status.tone}>{status.label}</StatusLabel>
        </div>
        <div
          className={cn(
            "text-xs leading-4 tabular-nums lg:text-sm lg:leading-5",
            expiresWarn ? "text-warning" : "text-muted-foreground lg:text-foreground"
          )}
        >
          <span className="lg:hidden" aria-hidden="true">
            ·{" "}
          </span>
          {expires}
        </div>
      </div>
      <div className="col-start-2 row-start-1 -mt-1 -mr-2 justify-self-end lg:col-auto lg:row-auto lg:m-0">
        {!revoked && (
          <CopyButton
            value={sendUrl(slug)}
            label={t("copyLink", { slug })}
            copiedLabel={t("copied")}
            iconOnly
            variant="ghost"
            size="icon"
            className="size-11 text-muted-foreground lg:size-8"
          />
        )}
      </div>
    </li>
  );
}

type Filter = "all" | LinkStorage;

function Dashboard({
  localLinks,
  needsReloginForCodewords,
}: {
  localLinks: [string, StoredLink][];
  needsReloginForCodewords: (links: LinkSummary[] | null) => boolean;
}) {
  const { t } = useTranslation("home");
  const { t: tc } = useTranslation("common");
  const { user } = useAuth();
  const ownPublicKey = accountPublicKey(user);
  const [filter, setFilter] = useState<Filter>("all");

  // GET /api/links: every server-side link this account owns (Task 3).
  const [myLinks, setMyLinks] = useState<LinkSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/links")
      .then((res) => (res.ok ? (res.json() as Promise<ListLinksResponse>) : Promise.reject()))
      .then((data) => {
        if (!cancelled) setMyLinks(data.links);
      })
      .catch(() => {
        if (!cancelled) setMyLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Spec §5's "pending receipts" dashboard section (drops on the caller's own links not yet
  // delivered). Reuses GET /api/inbox (Task 5) rather than re-deriving the same aggregation
  // client-side — filtering its "incoming" counterparties is exactly that data.
  const [myInboxCounterparties, setMyInboxCounterparties] = useState<InboxCounterparty[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/inbox")
      .then((res) => (res.ok ? (res.json() as Promise<InboxResponse>) : Promise.reject()))
      .then((data) => {
        if (!cancelled) setMyInboxCounterparties(data.counterparties);
      })
      .catch(() => {
        if (!cancelled) setMyInboxCounterparties([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingReceipts = myInboxCounterparties?.filter((c) => c.direction === "incoming") ?? null;
  const showAccount = filter !== "browser";
  const showBrowser = filter !== "account";
  const accountCount = myLinks?.length ?? 0;
  const visibleCount = (showAccount ? accountCount : 0) + (showBrowser ? localLinks.length : 0);
  const now = Date.now();

  const accountRow = (link: LinkSummary): RowProps => {
    const kind = link.isDefault ? t("kindDefault") : link.recipientIsOwner ? t("kindCustom") : t("kindRequest");
    const expired = link.expiresAt !== undefined && link.expiresAt < now;
    const status = link.revokedAt
      ? { tone: "destructive" as const, label: t("statusRevoked") }
      : expired
        ? { tone: "muted" as const, label: t("statusExpired") }
        : { tone: "success" as const, label: t("statusActive") };
    return {
      slug: link.slug,
      kind,
      storage: "account",
      mode: link.mode,
      status,
      expires: link.revokedAt ? "–" : link.expiresAt ? formatDate(link.expiresAt) : tc("never"),
      revoked: Boolean(link.revokedAt),
      // The owner's queue view lives on /receive/:slug for links whose
      // recipient is this account; request links belong to their claimant.
      href: link.recipientIsOwner && !link.revokedAt ? `/receive/${link.slug}` : undefined,
      codewords: <OwnLinkCodewords link={link} publicKey={ownPublicKey} />,
    };
  };

  const browserRow = ([slug, stored]: [string, StoredLink]): RowProps => {
    const msLeft = stored.expiresAt - now;
    return {
      slug,
      kind: t("kindBrowser"),
      storage: "browser",
      mode: "one-time",
      status: { tone: "muted", label: t("statusWaiting") },
      expires: formatTimeLeft(stored.expiresAt, now),
      expiresWarn: msLeft < 6 * 60 * 60 * 1000,
      href: `/receive/${slug}`,
    };
  };

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: t("filterAll") },
    { id: "account", label: tc("storage.account") },
    { id: "browser", label: tc("storage.browser") },
  ];

  return (
    <PageContainer>
      <PageHeader title={t("dashboardTitle")} description={t("dashboardDescription")} />

      <section data-testid="dashboard-pending-receipts" aria-labelledby="pending-heading" className="mb-8 flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <SectionTitle id="pending-heading">{t("pendingReceiptsHeading")}</SectionTitle>
          <Link to="/inbox" className="inline-flex min-h-11 items-center font-medium text-primary hover:text-primary-hover sm:min-h-0">
            {t("toInbox")}
          </Link>
        </div>
        {pendingReceipts === null && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-[74px] rounded-lg" />
            <Skeleton className="h-[74px] rounded-lg" />
            <span className="sr-only">{t("loading")}</span>
          </div>
        )}
        {pendingReceipts?.length === 0 && (
          <p className="rounded-lg border border-dashed px-4 py-4 text-muted-foreground md:px-6">{t("noPendingReceipts")}</p>
        )}
        {pendingReceipts && pendingReceipts.length > 0 && (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pendingReceipts.map((c) => {
              const latest = c.drops.reduce((max, d) => Math.max(max, d.createdAt), 0);
              return (
                <li key={c.key}>
                  <Link
                    to="/inbox"
                    className="flex min-h-[74px] items-center gap-3 rounded-lg border bg-card p-4 text-foreground no-underline transition-colors duration-150 hover:bg-accent"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                        c.kind === "account" ? "bg-brand-tint text-foreground" : "bg-muted text-muted-foreground"
                      )}
                    >
                      {c.kind === "account" ? c.displayName.slice(0, 2).toUpperCase() : <UserRound className="size-5" />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-semibold">{c.displayName}</span>
                      <span className="text-xs leading-4 text-muted-foreground">
                        {t("filesCount", { count: c.drops.length })}
                        {latest > 0 && ` · ${formatDate(latest)}`}
                      </span>
                    </span>
                    <Badge variant="accent">
                      <Download aria-hidden="true" />
                    </Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section data-testid="dashboard-active-links" aria-labelledby="links-heading" className="flex flex-col rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 lg:px-6">
          <div className="flex items-baseline gap-3">
            <h2 id="links-heading" className="text-base leading-6 font-semibold">
              {t("linksHeading")}
            </h2>
            {myLinks !== null && (
              <span className="text-xs leading-4 font-medium text-muted-foreground tabular-nums">
                {t("linksCount", { count: visibleCount })}
              </span>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div
              role="group"
              aria-label={t("filterLabel")}
              className="grid flex-1 grid-cols-3 gap-1 rounded-md bg-muted p-1 sm:flex sm:flex-none"
            >
              {filters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "h-9 rounded-sm px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 sm:h-8",
                    filter === f.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <Button asChild variant="secondary" className="h-11 sm:h-9">
              <Link to="/links/new">
                <Plus />
                {t("newLink")}
              </Link>
            </Button>
          </div>
        </div>

        {needsReloginForCodewords(myLinks) && (
          <p className="flex gap-2 border-t px-4 py-3 lg:px-6" data-testid="codewords-relogin">
            <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
            <span>
              {t("codewordsReloginRequired")}{" "}
              <Link to="/login" state={{ returnTo: "/" }} className="font-medium text-primary hover:text-primary-hover">
                {t("reloginLink")}
              </Link>
            </span>
          </p>
        )}

        <div
          aria-hidden="true"
          className={cn(
            ROW_GRID,
            "hidden border-t bg-muted px-6 py-2 text-xs leading-4 font-medium tracking-[0.01em] text-muted-foreground lg:grid"
          )}
        >
          <span>{t("colLink")}</span>
          <span>{t("colKey")}</span>
          <span>{t("colLifetime")}</span>
          <span>{t("colCodewords")}</span>
          <span>{t("colStatus")}</span>
          <span>{t("colExpires")}</span>
          <span />
        </div>

        {myLinks === null && showAccount && (
          <div className="flex flex-col gap-2 border-t px-4 py-4 lg:px-6">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <span className="sr-only">{t("loading")}</span>
          </div>
        )}

        {showAccount && myLinks && myLinks.length > 0 && (
          <ul aria-label={tc("storage.account")}>
            {myLinks.map((link) => (
              <LinkRow key={link.slug} {...accountRow(link)} />
            ))}
          </ul>
        )}

        {showBrowser && localLinks.length > 0 && (
          <div data-testid="anonymous-links-section">
            <ul aria-label={tc("storage.browser")}>
              {localLinks.map((entry) => (
                <LinkRow key={entry[0]} {...browserRow(entry)} />
              ))}
            </ul>
          </div>
        )}

        {myLinks !== null && visibleCount === 0 && (
          <p className="border-t px-4 py-6 text-muted-foreground lg:px-6">
            {accountCount + localLinks.length === 0 ? t("noActiveLinks") : t("noLinksInFilter")}
          </p>
        )}

        <p className="flex items-start gap-2 border-t px-4 py-3 text-xs leading-4 text-muted-foreground lg:px-6">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {t("browserLinksFootnote")}
        </p>
      </section>
    </PageContainer>
  );
}

function Landing({ localLinks }: { localLinks: [string, StoredLink][] }) {
  const { t } = useTranslation("home");
  const { user } = useAuth();
  const illustrationWords = t("illustrationWords").split(" ");
  const steps = [
    { icon: KeyRound, title: t("step1Title"), body: t("step1Body") },
    { icon: ShieldCheck, title: t("step2Title"), body: t("step2Body") },
    { icon: Download, title: t("step3Title"), body: t("step3Body") },
  ];

  return (
    <>
      <PageContainer className="flex flex-col gap-10 md:gap-12">
        <section className="flex flex-wrap items-center gap-8 md:gap-12">
          <div className="flex min-w-0 flex-[1_1_440px] flex-col gap-4">
            <Badge variant="accent">
              <ShieldCheck aria-hidden="true" />
              {t("eyebrow")}
            </Badge>
            <h1 className="text-[32px] leading-[38px] font-semibold tracking-[-0.025em] md:text-[40px] md:leading-[44px]">
              {t("headline")}
            </h1>
            <p className="max-w-[520px] text-base leading-[26px] text-muted-foreground">{t("lead")}</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button asChild size="lg" className="h-12 text-base sm:h-10 sm:text-sm">
                <Link to="/create">
                  <Link2 />
                  {t("receiveButton")}
                </Link>
              </Button>
              <Button asChild variant="ghost" size="lg" className="hidden sm:inline-flex">
                <a href="#how-it-works">{t("howItWorksLink")}</a>
              </Button>
            </div>
            <p className="text-center text-xs leading-4 font-medium text-muted-foreground sm:text-left">
              {t("noAccountNeeded")}
            </p>
            {user && (
              <p>
                <Link to="/account" className="inline-flex min-h-11 items-center font-medium text-primary hover:text-primary-hover sm:min-h-0">
                  {t("accountLink")}
                </Link>
              </p>
            )}
          </div>

          <div aria-hidden="true" className="flex min-w-0 flex-[1_1_380px] items-center justify-center rounded-lg bg-brand-tint p-5 md:p-8">
            <div className="flex w-full max-w-[380px] flex-col gap-4 rounded-lg border bg-card p-4 shadow-lg md:p-6">
              <div className="flex items-center justify-between">
                <span className="text-base leading-6 font-semibold">{t("illustrationTitle")}</span>
                <span className="inline-flex items-center gap-1 text-xs leading-4 font-medium text-success">
                  <Check className="size-3.5" strokeWidth={2} />
                  {t("illustrationMatch")}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {illustrationWords.map((word, i) => (
                  <span key={word} className="flex items-baseline gap-2 rounded-md bg-muted px-3 py-2 font-mono text-base leading-6">
                    <span className="font-sans text-xs text-muted-foreground">{i + 1}</span>
                    {word}
                  </span>
                ))}
              </div>
              <p className="text-xs leading-4 text-muted-foreground">{t("illustrationCaption")}</p>
            </div>
          </div>
        </section>

        <section id="how-it-works" aria-labelledby="how-heading" className="flex scroll-mt-6 flex-col gap-4">
          <SectionTitle id="how-heading">{t("howItWorksTitle")}</SectionTitle>
          <ol className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3 md:gap-4 md:overflow-visible md:border-0 md:bg-transparent">
            {steps.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3 bg-card p-4 md:flex-col md:gap-2 md:rounded-lg md:border md:p-6">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-base leading-6 font-semibold">{title}</h3>
                  <p className="text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {localLinks.length > 0 && (
          <section data-testid="anonymous-links-section" aria-labelledby="browser-links-heading" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="browser-links-heading" className="text-base leading-6 font-semibold">
                {t("browserLinksTitle")}
              </h2>
              <StorageBadge storage="browser" />
            </div>
            <ul className="overflow-hidden rounded-lg border bg-card">
              {localLinks.map(([slug, stored]) => (
                <li key={slug} className="border-t first:border-t-0">
                  <Link
                    to={`/receive/${slug}`}
                    className="flex min-h-16 items-center gap-3 px-4 py-3 text-foreground no-underline transition-colors duration-150 hover:bg-accent md:px-6"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-mono text-[13px] leading-5 break-all">{slug}</span>
                      <span className="text-xs leading-4 text-muted-foreground tabular-nums">
                        {t("expiresIn", { timeLeft: formatTimeLeft(stored.expiresAt) })}
                      </span>
                    </span>
                    {stored.pinProtected && <Badge variant="muted">{t("pinProtected")}</Badge>}
                    <span className="hidden text-sm font-medium text-primary sm:inline">{t("open")}</span>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-4 text-muted-foreground">{t("browserLinksHint")}</p>
          </section>
        )}
      </PageContainer>
      <footer className="border-t">
        <div className="mx-auto flex max-w-[1168px] flex-wrap justify-between gap-4 px-4 py-4 text-xs leading-4 text-muted-foreground md:px-6">
          <span>{t("footerSelfHosted")}</span>
          <a href={SOURCE_URL} className="text-primary hover:text-primary-hover" target="_blank" rel="noreferrer">
            {t("footerSource")}
          </a>
        </div>
      </footer>
    </>
  );
}

export function HomePage() {
  const { user } = useAuth();
  // Links created in this browser (useLocalLinks already drops expired ones), so a
  // recipient who closed the create-link tab can still find their download page.
  const { links } = useLocalLinks();
  const localLinks = useMemo(
    () => Object.entries(links).sort(([, a], [, b]) => b.createdAt - a.createdAt),
    [links]
  );

  // A verified account gets a dashboard of their own server-side links (Task 3's
  // GET /api/links) merged with this browser's links instead of the generic
  // landing content; an unverified logged-in user still sees the landing content
  // (with its account link).
  const isDashboard = Boolean(user?.emailVerified);
  const ownPublicKey = accountPublicKey(user);
  const needsReloginForCodewords = (myLinks: LinkSummary[] | null) =>
    !ownPublicKey && Boolean(myLinks?.some((link) => link.recipientIsOwner));

  if (isDashboard) {
    return <Dashboard localLinks={localLinks} needsReloginForCodewords={needsReloginForCodewords} />;
  }
  return <Landing localLinks={localLinks} />;
}
