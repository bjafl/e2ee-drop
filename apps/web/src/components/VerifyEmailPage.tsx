import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import verifyEmailEn from "@/locales/en/verifyEmail.json";
import verifyEmailNb from "@/locales/nb/verifyEmail.json";

i18n.addResourceBundle("en", "verifyEmail", verifyEmailEn, true, false);
i18n.addResourceBundle("nb", "verifyEmail", verifyEmailNb, true, false);

export function VerifyEmailPage() {
  const { t } = useTranslation("verifyEmail");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/verify-email/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (!cancelled) setStatus(res.ok ? "success" : "error");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "pending") return <p>{t("verifying")}</p>;
  if (status === "error") return <p role="alert">{t("errors.invalidToken")}</p>;
  return <p>{t("success")}</p>;
}
