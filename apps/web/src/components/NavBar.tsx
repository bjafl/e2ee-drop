// apps/web/src/components/NavBar.tsx
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import navEn from "@/locales/en/nav.json";
import navNb from "@/locales/nb/nav.json";

i18n.addResourceBundle("en", "nav", navEn, true, false);
i18n.addResourceBundle("nb", "nav", navNb, true, false);

export function NavBar() {
  const { t } = useTranslation("nav");
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // logout() itself only clears the cookie and the in-memory user (including
  // the decrypted private key) — it doesn't navigate anywhere. Since the
  // nav bar is mounted on every route, including ones that require a
  // session, send the visitor somewhere unguarded afterward.
  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  return (
    <nav className="flex items-center justify-between border-b px-4 py-2">
      <Link to="/" className="font-semibold">
        {t("brand")}
      </Link>
      <div className="flex items-center gap-2">
        {user ? (
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/">{t("home")}</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/contacts">{t("contacts")}</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/links/new">{t("newLink")}</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/account">{t("account")}</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              {t("logout")}
            </Button>
          </>
        ) : (
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/login">{t("login")}</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/register">{t("register")}</Link>
            </Button>
          </>
        )}
      </div>
    </nav>
  );
}
