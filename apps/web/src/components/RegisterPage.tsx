// apps/web/src/components/RegisterPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/hooks/useAuth";
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
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { recoveryCode: code } = await register({ email, username, name, password });
      setRecoveryCode(code);
    } catch {
      setError(t("register.errors.failed"));
    }
  };

  if (recoveryCode && !confirmed) {
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardHeader>
          <CardTitle>{t("register.recoveryTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{t("register.recoveryWarning")}</AlertDescription>
          </Alert>
          <p className="break-all rounded bg-muted p-2 font-mono text-sm">{recoveryCode}</p>
          <Button onClick={() => setConfirmed(true)}>{t("register.recoveryConfirm")}</Button>
        </CardContent>
      </Card>
    );
  }

  // Once the recovery code is confirmed there's nowhere established to send the
  // user yet: this codebase has no logged-in "my account" landing page (that
  // arrives in Plan 3) and no page here uses useNavigate — CreateLinkPage and
  // UploadPage both end on a bare terminal message after success rather than
  // redirecting. We follow that same pattern deliberately rather than invent a
  // redirect target that doesn't exist yet.
  if (confirmed) return <p>{t("register.title")} ✓</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("register.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && <p role="alert">{error}</p>}
          <div>
            <label htmlFor="email">{t("register.email")}</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          <div>
            <label htmlFor="username">{t("register.username")}</label>
            <input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          <div>
            <label htmlFor="name">{t("register.name")}</label>
            <input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          <div>
            <label htmlFor="password">{t("register.password")}</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          <Button type="submit">{t("register.submit")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
