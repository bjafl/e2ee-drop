// apps/web/src/components/LoginPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthCard, FormError, StatusCard } from "@/components/auth/AuthLayout";
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
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
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
    } finally {
      setSubmitting(false);
    }
  };

  // Without a `returnTo` there's no established redirect target, so end on a
  // terminal confirmation with a way onward.
  if (done) {
    return (
      <StatusCard tone="success" role="status" title={t("login.done")}>
        <Button asChild>
          <Link to="/">{t("login.goToOverview")}</Link>
        </Button>
      </StatusCard>
    );
  }

  return (
    <AuthCard
      title={t("login.title")}
      footer={
        <>
          {t("login.noAccount")} <Link to="/register" className="font-medium">{t("login.registerLink")}</Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && <FormError>{error}</FormError>}
        <div className="flex flex-col gap-2">
          <Label htmlFor="login-email">{t("login.email")}</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="login-password">{t("login.password")}</Label>
            <Link to="/reset-password" className="text-xs font-medium">
              {t("login.forgot")}
            </Link>
          </div>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {needsTotp && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-totp">{t("login.totpCode")}</Label>
            <Input
              id="login-totp"
              autoComplete="one-time-code"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="text"
              className="font-mono tabular-nums"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
            />
          </div>
        )}
        <Button type="submit" size="lg" className="mt-2 w-full" disabled={submitting}>
          {t("login.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
