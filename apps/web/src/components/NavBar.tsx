// apps/web/src/components/NavBar.tsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import navEn from "@/locales/en/nav.json";
import navNb from "@/locales/nb/nav.json";

i18n.addResourceBundle("en", "nav", navEn, true, false);
i18n.addResourceBundle("nb", "nav", navNb, true, false);

// Client-side display only; the server enforces the real resend rate limit
// (15 min window, 3 requests) regardless of what this cooldown shows.
const RESEND_COOLDOWN_SECONDS = 60;

export function NavBar() {
  const { t } = useTranslation("nav");
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!cooldownUntil) return;
    const interval = setInterval(() => {
      const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        setCooldownUntil(null);
        setSecondsLeft(0);
        clearInterval(interval);
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownUntil]);

  // logout() itself only clears the cookie and the in-memory user (including
  // the decrypted private key) — it doesn't navigate anywhere. Since the
  // nav bar is mounted on every route, including ones that require a
  // session, send the visitor somewhere unguarded afterward.
  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  const handleResend = async () => {
    setResendMessage(null);
    try {
      const res = await fetch("/api/auth/verify-email/resend", { method: "POST" });
      if (res.status === 429) {
        // The user IS presently rate-limited server-side, so the cooldown
        // display is accurate here — just make clear why, rather than
        // implying this click itself queued a send.
        setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
        setSecondsLeft(RESEND_COOLDOWN_SECONDS);
        setResendMessage(t("resendFailed"));
        return;
      }
      if (!res.ok) {
        setResendMessage(t("resendFailed"));
        return;
      }
      const body = await res.json().catch(() => null);
      if (body && body.emailDeliveryAvailable === false) {
        // No point rate-limiting a client that can never succeed.
        setResendMessage(t("resendUnavailable"));
        return;
      }
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      setSecondsLeft(RESEND_COOLDOWN_SECONDS);
    } catch {
      setResendMessage(t("resendFailed"));
    }
  };

  return (
    <>
      <nav className="flex items-center justify-between border-b px-4 py-2">
        <Link to="/" className="font-semibold">
          {t("brand")}
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
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
              {user?.emailVerified && (
                <Button asChild variant="ghost" size="sm">
                  <Link to="/inbox">{t("inbox")}</Link>
                </Button>
              )}
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
      {user && !user.emailVerified && (
        <div
          data-testid="verify-email-banner"
          className="flex items-center justify-between gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <span>{resendMessage ? <span data-testid="resend-message">{resendMessage}</span> : t("verifyEmailBanner")}</span>
          <Button
            data-testid="resend-verification-button"
            size="sm"
            variant="outline"
            disabled={cooldownUntil !== null}
            onClick={handleResend}
          >
            {cooldownUntil !== null
              ? t("resendVerificationCooldown", { seconds: secondsLeft })
              : t("resendVerification")}
          </Button>
        </div>
      )}
    </>
  );
}
