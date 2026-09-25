// apps/web/src/components/HomePage.tsx
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
      {localLinks.length > 0 && (
        <div className="mt-10 text-left">
          <h2 className="text-sm font-semibold">{t("yourLinks")}</h2>
          <ul className="mt-2 space-y-1">
            {localLinks.map(([slug, stored]) => (
              <li key={slug} className="text-sm">
                <Link to={`/download/${slug}`} className="font-mono underline">
                  {slug}
                </Link>{" "}
                <span className="text-muted-foreground">
                  {t("expires", { date: new Date(stored.expiresAt).toLocaleString() })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
