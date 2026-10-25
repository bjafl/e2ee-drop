// apps/web/src/components/RequestPasswordResetPage.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PasswordResetRequestResponse } from "@e2ee-drop/shared";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthCard, StatusCard } from "@/components/auth/AuthLayout";
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

  if (outcome === "sent") {
    return (
      <StatusCard tone="success" role="status" title={t("request.sentTitle")}>
        <p>{t("request.sent")}</p>
      </StatusCard>
    );
  }
  if (outcome === "unavailable") {
    return (
      <StatusCard tone="error" role="status" title={t("request.unavailableTitle")}>
        <p>{t("request.unavailable")}</p>
      </StatusCard>
    );
  }

  return (
    <AuthCard
      title={t("request.title")}
      description={t("request.description")}
      footer={<Link to="/login" className="font-medium">{t("request.backToLogin")}</Link>}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reset-email">{t("request.email")}</Label>
          <Input
            id="reset-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" size="lg" className="mt-2 w-full">
          {t("request.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
