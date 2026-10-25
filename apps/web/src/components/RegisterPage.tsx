// apps/web/src/components/RegisterPage.tsx
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label, FieldHint } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AuthCard, FormError, StatusCard } from "@/components/auth/AuthLayout";
import { useAuth, RegisterError } from "@/hooks/useAuth";
import { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from "@/lib/passwordPolicy";
import i18n from "@/i18n";
import authEn from "@/locales/en/auth.json";
import authNb from "@/locales/nb/auth.json";

i18n.addResourceBundle("en", "auth", authEn, true, false);
i18n.addResourceBundle("nb", "auth", authNb, true, false);

export function RegisterPage() {
  const { t } = useTranslation("auth");
  const { register } = useAuth();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<ReactNode | null>(null);

  // Maps a rejected register() call to a specific, translated message for
  // each status the server can actually return (see apps/api/src/routes/
  // auth.ts's /register handler) rather than the single generic fallback
  // this used to show for every failure. The 409 case is deliberately
  // field-agnostic — it must not say whether the email or the username was
  // the one already in use, since that distinction is exactly the
  // enumeration signal the server's SEC11 trade-off comment says is
  // accepted, not something to sharpen further — but it does link to
  // /login, since a real user re-registering their own email is the whole
  // justification for accepting that trade-off in the first place.
  const errorMessageFor = (err: unknown): ReactNode => {
    if (err instanceof RegisterError) {
      switch (err.status) {
        case 409:
          return (
            <>
              {t("register.errors.inUse")} <Link to="/login">{t("register.errors.inUseLink")}</Link>
            </>
          );
        case 400:
          return t("register.errors.invalidUsername");
        case 403:
          return t("register.errors.registrationDisabled");
        case 429:
          return t("register.errors.rateLimited");
      }
    }
    return t("register.errors.failed");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Client-side only by necessity — the server never sees the password
    // (see lib/passwordPolicy.ts). Checked before register() so a too-short
    // password never pays the Argon2id derivations.
    if (!isPasswordLongEnough(password)) {
      setError(t("register.errors.passwordTooShort", { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    try {
      const { recoveryCode: code } = await register({ email, username, name, password });
      setRecoveryCode(code);
    } catch (err) {
      setError(errorMessageFor(err));
    }
  };

  if (recoveryCode && !confirmed) {
    return (
      <AuthCard title={t("register.recoveryTitle")}>
        <div className="flex flex-col gap-4">
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="text-foreground">{t("register.recoveryWarning")}</AlertDescription>
          </Alert>
          <p className="rounded-md bg-muted px-4 py-3 text-center font-mono text-lg leading-6 font-medium break-all">
            {recoveryCode}
          </p>
          <Button size="lg" onClick={() => setConfirmed(true)}>
            {t("register.recoveryConfirm")}
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (confirmed) {
    return (
      <StatusCard tone="success" role="status" title={t("register.done")}>
        <p>{t("register.doneHint")}</p>
        <Button asChild>
          <Link to="/">{t("register.goToOverview")}</Link>
        </Button>
      </StatusCard>
    );
  }

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    extra: React.ComponentProps<"input"> = {}
  ) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...extra} />
    </div>
  );

  return (
    <AuthCard
      title={t("register.title")}
      description={t("register.description")}
      footer={
        <>
          {t("register.haveAccount")} <Link to="/login" className="font-medium">{t("register.loginLink")}</Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && <FormError>{error}</FormError>}
        {field("email", t("register.email"), email, setEmail, { type: "email", autoComplete: "email" })}
        {field("username", t("register.username"), username, setUsername, {
          autoComplete: "username",
          autoCapitalize: "off",
          spellCheck: false,
        })}
        {field("name", t("register.name"), name, setName, { autoComplete: "name" })}
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">{t("register.password")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-describedby="password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FieldHint id="password-hint">{t("register.passwordHint", { min: MIN_PASSWORD_LENGTH })}</FieldHint>
        </div>
        <Button type="submit" size="lg" className="mt-2 w-full">
          {t("register.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
