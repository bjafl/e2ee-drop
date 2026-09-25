// apps/web/src/components/HomePage.tsx
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";
import homeEn from "@/locales/en/home.json";
import homeNb from "@/locales/nb/home.json";

i18n.addResourceBundle("en", "home", homeEn, true, false);
i18n.addResourceBundle("nb", "home", homeNb, true, false);

export function HomePage() {
  const { t } = useTranslation("home");
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-muted-foreground">{t("tagline")}</p>
      <Button asChild className="mt-6">
        <Link to="/create">{t("receiveButton")}</Link>
      </Button>
    </div>
  );
}
