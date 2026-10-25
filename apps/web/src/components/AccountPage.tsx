// apps/web/src/components/AccountPage.tsx
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import QRCode from "react-qr-code";
import { Check, Copy, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageContainer, PageHeader } from "@/components/common/Page";
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
  const { user, loading, logout, patchUser } = useAuth();
  const [deleted, setDeleted] = useState(false);
  const [flow, setFlow] = useState<TwoFactorFlow>({ step: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Finding 4 (final review): a plain `useState(user?.allowContactRequests ??
  // true)` only reads its seed once, at mount. On a hard refresh of /account,
  // `user` is still null on that first render (loading=true), so the
  // checkbox locked in `true` and never updated once /me resolved with the
  // real (possibly false) value — same problem right after login()/
  // register(), where the field is undefined until the next /me fetch
  // (Task 8's disclosed gap).
  //
  // Fix: the displayed value is always DERIVED from user.allowContactRequests
  // (never frozen), with a local override only while an optimistic toggle
  // (below) is in flight. The override is cleared whenever
  // user.allowContactRequests itself changes, so it can never mask a real,
  // later value from /me.
  // Issue #7: the override remembers which server value it was made against;
  // as soon as user.allowContactRequests changes it no longer applies — the
  // same "cleared on change" rule as before, derived instead of reset in an
  // effect.
  const [override, setOverride] = useState<{ value: boolean; base: boolean | undefined } | null>(null);
  const pendingOverride = override && override.base === user?.allowContactRequests ? override.value : null;
  const setPendingOverride = (value: boolean) => setOverride({ value, base: user?.allowContactRequests });
  // Defaults to true, matching the DB column's default (see
  // packages/db/prisma/schema.prisma) — undefined here just means the
  // initial /api/auth/me restore hasn't populated it yet (see AuthUser).
  const allowContactRequests = pendingOverride ?? user?.allowContactRequests ?? true;

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
    patchUser({ totpEnabled: true });
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
    patchUser({ totpEnabled: false });
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
    patchUser({ totpEnabled: false });
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

  // Optimistic: flips immediately, then persists. On failure the toggle is
  // rolled back rather than left showing a state the server never saved —
  // matching DeleteAccountDialog's approach of trusting the request unless
  // it's known to have failed.
  const toggleAllowContactRequests = async () => {
    const next = !allowContactRequests;
    setPendingOverride(next);
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowContactRequests: next }),
      });
      if (!response.ok) setPendingOverride(!next);
    } catch {
      setPendingOverride(!next);
    }
  };

  const initials = (user.username ?? "?").slice(0, 2).toUpperCase();
  const codeInputClass = "max-w-48 font-mono tabular-nums";

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-col gap-6">
        <Card>
          <CardContent className="flex items-center gap-4">
            <span
              aria-hidden="true"
              className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-tint text-base font-semibold"
            >
              {initials}
            </span>
            <div className="flex min-w-0 flex-col">
              <p className="font-semibold">{t("signedInAs", { username: user.username })}</p>
              <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span className="break-all">{t("email", { email: user.email })}</span>
                {user.emailVerified ? (
                  <Badge variant="accent">
                    <Check aria-hidden="true" />
                    {t("emailVerified")}
                  </Badge>
                ) : (
                  <Badge variant="muted">{t("emailUnverified")}</Badge>
                )}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{t("twoFactor.heading")}</CardTitle>
              {user.totpEnabled ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  {t("twoFactor.statusOn")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
                  <ShieldOff className="size-4" aria-hidden="true" />
                  {t("twoFactor.statusOff")}
                </span>
              )}
            </div>
            <CardDescription>{t("twoFactor.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {flow.step === "idle" && !user.totpEnabled && (
              <Button data-testid="enable-2fa-button" className="self-start" onClick={startSetup}>
                {t("twoFactor.enable")}
              </Button>
            )}

            {flow.step === "idle" && user.totpEnabled && (
              <div className="flex flex-wrap gap-2">
                <Button data-testid="replace-2fa-button" variant="outline" onClick={startReplace}>
                  {t("twoFactor.replace")}
                </Button>
                <Button data-testid="regenerate-backup-codes-button" variant="outline" onClick={startRegenerate}>
                  {t("twoFactor.regenerateBackupCodes")}
                </Button>
                <Button data-testid="disable-2fa-button" variant="ghost" className="text-destructive" onClick={startDisable}>
                  {t("twoFactor.disable")}
                </Button>
              </div>
            )}

            {(flow.step === "setup" || flow.step === "confirming") && (
              <div className="flex flex-col gap-4">
                <p>{t("twoFactor.scanQr")}</p>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="rounded-md border bg-white p-3">
                    <QRCode value={flow.otpauthUrl} size={144} />
                  </div>
                  <p className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-[13px] leading-5 break-all">
                    {flow.secretBase32}
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="totp-confirm-code">{t("twoFactor.codeLabel")}</Label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="totp-confirm-code"
                      data-testid="totp-code-input"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className={codeInputClass}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <Button data-testid="confirm-2fa-code-button" onClick={confirmEnable}>
                      {t("twoFactor.confirm")}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {(flow.step === "disabling" || flow.step === "disabling-for-replace" || flow.step === "regenerating") && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="totp-action-code">{t("twoFactor.currentCodeLabel")}</Label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="totp-action-code"
                    data-testid="totp-action-code-input"
                    inputMode="numeric"
                    autoCapitalize="off"
                    spellCheck={false}
                    className={codeInputClass}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
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
                  <Button variant="ghost" onClick={() => setFlow({ step: "idle" })}>
                    {t("twoFactor.cancel")}
                  </Button>
                </div>
              </div>
            )}

            {flow.step === "backup-codes" && (
              <div className="flex flex-col gap-4">
                <Alert variant="warning" data-testid="backup-codes-warning">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription className="text-foreground">{t("twoFactor.backupCodesWarning")}</AlertDescription>
                </Alert>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {flow.codes.map((c) => (
                    <li key={c} className="rounded-md bg-muted px-3 py-2 text-center font-mono text-[13px] leading-5">
                      {c}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => navigator.clipboard.writeText(flow.codes.join("\n"))}>
                    <Copy aria-hidden="true" />
                    {t("twoFactor.backupCodesCopy")}
                  </Button>
                  <Button onClick={() => setFlow({ step: "idle" })}>{t("twoFactor.backupCodesDone")}</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("privacy")}</CardTitle>
          </CardHeader>
          <CardContent>
            <label className="flex min-h-11 cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={allowContactRequests}
                onChange={toggleAllowContactRequests}
                aria-label={t("allowContactRequestsLabel")}
                aria-describedby="allow-contact-requests-hint"
              />
              <span className="flex flex-col">
                <span className="font-medium">{t("allowContactRequestsLabel")}</span>
                <span id="allow-contact-requests-hint" className="text-xs leading-4 text-muted-foreground">
                  {t("allowContactRequestsHint")}
                </span>
              </span>
            </label>
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">{t("dangerZone")}</CardTitle>
            <CardDescription>{t("dangerZoneHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteAccountDialog onDeleted={handleDeleted} />
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
