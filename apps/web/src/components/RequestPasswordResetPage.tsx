// apps/web/src/components/RequestPasswordResetPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PasswordResetRequestResponse } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import passwordResetEn from "@/locales/en/passwordReset.json";
import passwordResetNb from "@/locales/nb/passwordReset.json";

i18n.addResourceBundle("en", "passwordReset", passwordResetEn, true, false);
i18n.addResourceBundle("nb", "passwordReset", passwordResetNb, true, false);

type Outcome = "sent" | "unavailable";

export function RequestPasswordResetPage() {
  const { t } = useTranslation("passwordReset");
  const [email, setEmail] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const response = await fetch("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    // emailDeliveryAvailable reflects only whether this server instance has a
    // mailer configured (same answer for every email), so it's safe to act on.
    // Anything but an explicit false keeps the original "sent" message.
    const body = (await response.json().catch(() => null)) as PasswordResetRequestResponse | null;
    setOutcome(body?.emailDeliveryAvailable === false ? "unavailable" : "sent");
  };

  if (outcome === "sent") return <p>{t("request.sent")}</p>;
  if (outcome === "unavailable") return <p>{t("request.unavailable")}</p>;

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
