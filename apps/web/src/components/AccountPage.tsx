// apps/web/src/components/AccountPage.tsx
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import QRCode from "react-qr-code";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DeleteAccountDialog } from "@/components/DeleteAccountDialog";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import accountEn from "@/locales/en/account.json";
import accountNb from "@/locales/nb/account.json";

i18n.addResourceBundle("en", "account", accountEn, true, false);
i18n.addResourceBundle("nb", "account", accountNb, true, false);

// One flow handles both "enable from scratch" and "replace" (disable-then-
// setup chained as one user-facing action, per the design spec) — "replace"
// just starts at the disable step instead of directly at setup.
type TwoFactorFlow =
  | { step: "idle" }
  | { step: "disabling-for-replace" }
  | { step: "setup"; secretBase32: string; otpauthUrl: string }
  | { step: "confirming"; secretBase32: string; otpauthUrl: string }
  | { step: "backup-codes"; codes: string[] }
  | { step: "disabling" }
  | { step: "regenerating" };

export function AccountPage() {
  const { t } = useTranslation("account");
  const { user, loading, logout } = useAuth();
  const [deleted, setDeleted] = useState(false);
  const [flow, setFlow] = useState<TwoFactorFlow>({ step: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Checked before the logged-out guard: logout() below sets user to null,
  // and without this the re-render would hit `!user` and land on /login.
  if (deleted) return <Navigate to="/" replace />;
  // Wait for the initial session restore before deciding the visitor is
  // logged out, so a hard refresh of /account doesn't bounce to /login.
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  // The server has already deleted the account and its session row, but
  // logout() still matters: it clears the cookie and — more importantly —
  // drops the in-memory user, including the decrypted private key (logout()
  // clears local state even if its request fails, so the error is ignored).
  const handleDeleted = () => {
    setDeleted(true);
    void logout().catch(() => undefined);
  };

  const startSetup = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/setup", { method: "POST" });
    if (!res.ok) return setError(t("twoFactor.currentCodeLabel"));
    const { secretBase32, otpauthUrl } = await res.json();
    setFlow({ step: "setup", secretBase32, otpauthUrl });
  };

  const confirmEnable = async () => {
    setError(null);
    if (flow.step !== "setup" && flow.step !== "confirming") return;
    const res = await fetch("/api/auth/2fa/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      setFlow({ step: "confirming", secretBase32: flow.secretBase32, otpauthUrl: flow.otpauthUrl });
      return setError("invalid code");
    }
    const { backupCodes } = await res.json();
    setCode("");
    // Known gap: useAuth() exposes no refresh()/re-fetch of /api/auth/me, so
    // user.totpEnabled here stays stale until the next full reload or login
    // — see the note on the "idle" branches below. The 2FA state itself is
    // correct server-side regardless.
    setFlow({ step: "backup-codes", codes: backupCodes });
  };

  const startReplace = () => setFlow({ step: "disabling-for-replace" });

  const confirmDisableForReplace = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setCode("");
    if (!res.ok) return setError("invalid code");
    await startSetup();
  };

  const startDisable = () => setFlow({ step: "disabling" });

  const confirmDisable = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setCode("");
    if (!res.ok) return setError("invalid code");
    setFlow({ step: "idle" });
  };

  const startRegenerate = () => setFlow({ step: "regenerating" });

  const confirmRegenerate = async () => {
    setError(null);
    const res = await fetch("/api/auth/2fa/backup-codes/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setCode("");
    if (!res.ok) return setError("invalid code");
    const { backupCodes } = await res.json();
    setFlow({ step: "backup-codes", codes: backupCodes });
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <p>{t("signedInAs", { username: user.username })}</p>
          <p className="text-sm text-muted-foreground">{t("email", { email: user.email })}</p>
        </div>

        <div className="space-y-3 border-t pt-4">
          <h2 className="font-semibold">{t("twoFactor.heading")}</h2>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {flow.step === "idle" && !user.totpEnabled && (
            <Button data-testid="enable-2fa-button" onClick={startSetup}>
              {t("twoFactor.enable")}
            </Button>
          )}

          {flow.step === "idle" && user.totpEnabled && (
            <div className="flex flex-wrap gap-2">
              <Button data-testid="replace-2fa-button" variant="outline" onClick={startReplace}>
                {t("twoFactor.replace")}
              </Button>
              <Button data-testid="disable-2fa-button" variant="destructive" onClick={startDisable}>
                {t("twoFactor.disable")}
              </Button>
              <Button data-testid="regenerate-backup-codes-button" variant="outline" onClick={startRegenerate}>
                {t("twoFactor.regenerateBackupCodes")}
              </Button>
            </div>
          )}

          {(flow.step === "setup" || flow.step === "confirming") && (
            <div className="space-y-3">
              <p>{t("twoFactor.scanQr")}</p>
              <div className="w-40 bg-white p-2">
                <QRCode value={flow.otpauthUrl} size={144} />
              </div>
              <p className="break-all font-mono text-sm">{flow.secretBase32}</p>
              <label htmlFor="totp-confirm-code">{t("twoFactor.codeLabel")}</label>
              <input
                id="totp-confirm-code"
                data-testid="totp-code-input"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded border p-2"
              />
              <Button data-testid="confirm-2fa-code-button" onClick={confirmEnable}>
                {t("twoFactor.confirm")}
              </Button>
            </div>
          )}

          {(flow.step === "disabling" || flow.step === "disabling-for-replace" || flow.step === "regenerating") && (
            <div className="space-y-3">
              <label htmlFor="totp-action-code">{t("twoFactor.currentCodeLabel")}</label>
              <input
                id="totp-action-code"
                data-testid="totp-action-code-input"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded border p-2"
              />
              <Button
                data-testid="confirm-totp-action-button"
                onClick={
                  flow.step === "disabling-for-replace"
                    ? confirmDisableForReplace
                    : flow.step === "disabling"
                      ? confirmDisable
                      : confirmRegenerate
                }
              >
                {t("twoFactor.confirm")}
              </Button>
            </div>
          )}

          {flow.step === "backup-codes" && (
            <div className="space-y-3">
              <Alert variant="destructive" data-testid="backup-codes-warning">
                <AlertDescription>{t("twoFactor.backupCodesWarning")}</AlertDescription>
              </Alert>
              <pre className="rounded bg-muted p-2 font-mono text-sm">{flow.codes.join("\n")}</pre>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => navigator.clipboard.writeText(flow.codes.join("\n"))}>
                  {t("twoFactor.backupCodesCopy")}
                </Button>
                <Button onClick={() => setFlow({ step: "idle" })}>{t("twoFactor.backupCodesDone")}</Button>
              </div>
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 font-semibold">{t("dangerZone")}</h2>
          <DeleteAccountDialog onDeleted={handleDeleted} />
        </div>
      </CardContent>
    </Card>
  );
}
