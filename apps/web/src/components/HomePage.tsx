// apps/web/src/components/HomePage.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { InboxCounterparty, InboxResponse, ListLinksResponse, LinkSummary } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { accountPublicKey, useCodewords } from "@/hooks/useCodewords";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import i18n from "@/i18n";
import homeEn from "@/locales/en/home.json";
import homeNb from "@/locales/nb/home.json";

i18n.addResourceBundle("en", "home", homeEn, true, false);
i18n.addResourceBundle("nb", "home", homeNb, true, false);

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
  if (!link.recipientIsOwner || !codewords) return null;
  return (
    <span className="ml-2 text-muted-foreground" data-testid={`codewords-${link.slug}`}>
      {t("codewordsLabel")}: <span className="font-mono">{codewords.join(" · ")}</span>
    </span>
  );
}

export function HomePage() {
  const { t } = useTranslation("home");
  const { user } = useAuth();
  // Links created in this browser (useLocalLinks already drops expired ones), so a
  // recipient who closed the create-link tab can still find their download page.
  const { links } = useLocalLinks();
  const localLinks = Object.entries(links).sort(([, a], [, b]) => b.createdAt - a.createdAt);

  // A verified account gets a dashboard of their own server-side links (Task 3's
  // GET /api/links) instead of the generic landing content below; an unverified
  // logged-in user still sees the generic landing content (with its account link).
  const [myLinks, setMyLinks] = useState<LinkSummary[] | null>(null);
  const isDashboard = Boolean(user?.emailVerified);
  const ownPublicKey = accountPublicKey(user);
  const needsReloginForCodewords = !ownPublicKey && Boolean(myLinks?.some((link) => link.recipientIsOwner));

  useEffect(() => {
    if (!isDashboard) return;
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
  }, [isDashboard]);

  // Spec §5's "pending receipts" dashboard section (drops on the caller's own links not yet
  // delivered). Reuses GET /api/inbox (Task 5) rather than re-deriving the same aggregation
  // client-side — filtering its "incoming" counterparties is exactly that data.
  const [myInboxCounterparties, setMyInboxCounterparties] = useState<InboxCounterparty[] | null>(null);

  useEffect(() => {
    if (!isDashboard) return;
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
  }, [isDashboard]);

  const pendingReceipts = myInboxCounterparties?.filter((c) => c.direction === "incoming") ?? null;

  const anonymousSection = localLinks.length > 0 && (
    <div data-testid="anonymous-links-section" className="mt-10 text-left">
      <h2 className="text-sm font-semibold">{t("yourLinks")}</h2>
      <ul className="mt-2 space-y-1">
        {localLinks.map(([slug, stored]) => (
          <li key={slug} className="text-sm">
            <Link to={`/receive/${slug}`} className="font-mono underline">
              {slug}
            </Link>{" "}
            <span className="text-muted-foreground">
              {t("expires", { date: new Date(stored.expiresAt).toLocaleString() })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  if (isDashboard) {
    return (
      <div className="mx-auto mt-12 max-w-2xl">
        <h1 className="text-2xl font-bold">{t("dashboardTitle")}</h1>
        <section data-testid="dashboard-active-links" className="mt-6">
          <h2 className="text-sm font-semibold">{t("activeLinksHeading")}</h2>
          {myLinks === null && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
          {myLinks?.length === 0 && <p className="text-sm text-muted-foreground">{t("noActiveLinks")}</p>}
          {needsReloginForCodewords && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="codewords-relogin">
              {t("codewordsReloginRequired")}{" "}
              <Link to="/login" state={{ returnTo: "/" }} className="underline">
                {t("reloginLink")}
              </Link>
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {myLinks?.map((link) => (
              <li key={link.slug} className="text-sm">
                <span className="font-mono">{link.slug}</span>
                {link.revokedAt && <span className="ml-2 text-muted-foreground">{t("revoked")}</span>}
                <OwnLinkCodewords link={link} publicKey={ownPublicKey} />
              </li>
            ))}
          </ul>
        </section>
        <section data-testid="dashboard-pending-receipts" className="mt-8 border-t pt-6">
          <h2 className="text-sm font-semibold">{t("pendingReceiptsHeading")}</h2>
          {pendingReceipts === null && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
          {pendingReceipts?.length === 0 && <p className="text-sm text-muted-foreground">{t("noPendingReceipts")}</p>}
          <ul className="mt-2 space-y-1">
            {pendingReceipts?.map((c) => (
              <li key={c.key} className="text-sm">
                <Link to="/inbox" className="underline">
                  {c.displayName}
                </Link>{" "}
                <span className="text-muted-foreground">({c.drops.length})</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="mt-8 border-t pt-6">{anonymousSection}</section>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-muted-foreground">{t("tagline")}</p>
      <Button asChild className="mt-6">
        <Link to="/create">{t("receiveButton")}</Link>
      </Button>
      {user && (
        <p className="mt-3 text-sm">
          <Link to="/account" className="underline">
            {t("accountLink")}
          </Link>
        </p>
      )}
      {anonymousSection}
    </div>
  );
}
