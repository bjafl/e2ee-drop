// apps/web/src/components/HomePage.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ListLinksResponse, LinkSummary } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import i18n from "@/i18n";
import homeEn from "@/locales/en/home.json";
import homeNb from "@/locales/nb/home.json";

i18n.addResourceBundle("en", "home", homeEn, true, false);
i18n.addResourceBundle("nb", "home", homeNb, true, false);

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
          <ul className="mt-2 space-y-1">
            {myLinks?.map((link) => (
              <li key={link.slug} className="text-sm">
                <span className="font-mono">{link.slug}</span>
                {link.revokedAt && <span className="ml-2 text-muted-foreground">{t("revoked")}</span>}
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
