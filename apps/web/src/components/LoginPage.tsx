// apps/web/src/components/LoginPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import authEn from "@/locales/en/auth.json";
import authNb from "@/locales/nb/auth.json";

i18n.addResourceBundle("en", "auth", authEn, true, false);
i18n.addResourceBundle("nb", "auth", authNb, true, false);

export function LoginPage() {
  const { t } = useTranslation("auth");
  const { login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // I8 (final review): the various "log in" links elsewhere (UploadPage's
  // anonymous-consent dialog and reauth gate, ReceivePage's reauth gate and
  // claim view) pass `state: { returnTo }` when navigating here, so a
  // successful login can send the visitor back to where they actually meant
  // to go instead of leaving them on this page's own terminal message.
  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await login(email, password, needsTotp ? totpCode : undefined);
      if (result.requiresTotp) {
        setNeedsTotp(true);
        return;
      }
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      setDone(true);
    } catch {
      setError(needsTotp ? t("login.errors.invalidTotp") : t("login.errors.invalid"));
    }
  };

  // Same terminal-message pattern as RegisterPage/UploadPage/CreateLinkPage:
  // no logged-in landing page exists yet in this codebase (Plan 3), so
  // without a `returnTo` there's no established redirect target to navigate
  // to after a successful login.
  if (done) return <p>{t("login.title")} ✓</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("login.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && <p role="alert">{error}</p>}
          <div>
            <label htmlFor="login-email">{t("login.email")}</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          <div>
            <label htmlFor="login-password">{t("login.password")}</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          {needsTotp && (
            <div>
              <label htmlFor="login-totp">{t("login.totpCode")}</label>
              <input
                id="login-totp"
                autoComplete="one-time-code"
                autoCapitalize="off"
                spellCheck={false}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="w-full rounded border p-2"
              />
            </div>
          )}
          <Button type="submit">{t("login.submit")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
