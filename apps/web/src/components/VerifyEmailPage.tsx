import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import verifyEmailEn from "@/locales/en/verifyEmail.json";
import verifyEmailNb from "@/locales/nb/verifyEmail.json";

i18n.addResourceBundle("en", "verifyEmail", verifyEmailEn, true, false);
i18n.addResourceBundle("nb", "verifyEmail", verifyEmailNb, true, false);

export function VerifyEmailPage() {
  const { t } = useTranslation("verifyEmail");
  const { patchUser } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  // Persists across React StrictMode's dev-only double-invoke of this effect
  // (mount -> cleanup -> remount, without actually destroying component
  // state), unlike a `let cancelled` scoped inside the effect body, which
  // only suppressed the *first* mount's own response handling once its
  // cleanup ran — it did not stop that first mount's POST from firing, so it
  // consumed the token, and the second mount's own POST then got a 400 for
  // an already-consumed token, making a real success look like a failure in
  // dev. requestedRef below makes the POST itself fire only once.
  const requestedRef = useRef(false);
  // Tracks whether *some* mount of this effect is currently active, so the
  // one-and-only fetch's resolution still updates state when handled by
  // whichever mount is active when it settles. A plain closure-scoped
  // `cancelled` can't do this once the fetch is only started by the first
  // invocation: that invocation's own cleanup (run when StrictMode
  // simulates unmounting it) would permanently flag the response as stale,
  // even though the component is about to remount and is still mounted by
  // the time the response actually arrives. This ref is instead reset to
  // "active" at the start of every mount (including the remount) and only
  // stays "cancelled" once cleanup runs with no subsequent remount to reset
  // it — i.e. once the component is genuinely gone.
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!requestedRef.current) {
      requestedRef.current = true;
      fetch("/api/auth/verify-email/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then((res) => {
          if (cancelledRef.current) return;
          setStatus(res.ok ? "success" : "error");
          if (res.ok) patchUser({ emailVerified: true });
        })
        .catch(() => {
          if (!cancelledRef.current) setStatus("error");
        });
    }
    return () => {
      cancelledRef.current = true;
    };
  }, [token, patchUser]);

  if (status === "pending") return <p>{t("verifying")}</p>;
  if (status === "error") return <p role="alert">{t("errors.invalidToken")}</p>;
  return <p>{t("success")}</p>;
}
