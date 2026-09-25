// apps/web/src/components/RequestPasswordResetPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import passwordResetEn from "@/locales/en/passwordReset.json";
import passwordResetNb from "@/locales/nb/passwordReset.json";

i18n.addResourceBundle("en", "passwordReset", passwordResetEn, true, false);
i18n.addResourceBundle("nb", "passwordReset", passwordResetNb, true, false);

export function RequestPasswordResetPage() {
  const { t } = useTranslation("passwordReset");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSent(true);
  };

  if (sent) return <p>{t("request.sent")}</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("request.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="reset-email">{t("request.email")}</label>
            <input
              id="reset-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          <Button type="submit">{t("request.submit")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
