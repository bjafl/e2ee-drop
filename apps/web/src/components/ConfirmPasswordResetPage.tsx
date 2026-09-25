// apps/web/src/components/ConfirmPasswordResetPage.tsx
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  deriveAuthKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  deriveRecoveryKey,
  generateRecoveryCode,
} from "@/lib/keyWrapping";
import type { PasswordResetVerifyTokenResponse } from "@e2ee-drop/shared";
import i18n from "@/i18n";
import passwordResetEn from "@/locales/en/passwordReset.json";
import passwordResetNb from "@/locales/nb/passwordReset.json";

i18n.addResourceBundle("en", "passwordReset", passwordResetEn, true, false);
i18n.addResourceBundle("nb", "passwordReset", passwordResetNb, true, false);

type VerifyTokenInfo = Pick<PasswordResetVerifyTokenResponse, "passwordSalt" | "recoveryWrappedPrivateKey" | "totpEnabled">;

export function ConfirmPasswordResetPage() {
  const { t } = useTranslation("passwordReset");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [info, setInfo] = useState<VerifyTokenInfo | null>(null);
  const [invalidToken, setInvalidToken] = useState(false);
  const [noRecovery, setNoRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // 2FA accounts must also supply a current TOTP code (the server rejects
  // /complete and /complete-fresh with 401 requiresTotp otherwise). The field
  // is shown up front when /verify-token reports totpEnabled, and also
  // revealed on a requiresTotp rejection (e.g. 2FA was enabled after the page
  // loaded) — the same prompt-and-resubmit flow as LoginPage. A rejection
  // does not consume the reset token, so the user can simply retry.
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Set once the "start fresh" path has generated (and the server has
  // accepted) a brand-new recovery code, so it can be shown to the user
  // exactly once with an explicit confirmation step — mirroring the pattern
  // RegisterPage uses for the recovery code generated at registration. The
  // reset is not considered `done` until the user has confirmed they saved
  // it; otherwise they'd end up with a new key protected by a code they were
  // never shown, and no way to ever recover it.
  const [freshRecoveryCode, setFreshRecoveryCode] = useState<string | null>(null);
  // Defense in depth against double-submits (the server's atomic token claim
  // is the real guard): the ref blocks a second submit synchronously, before
  // React re-renders; the state disables the buttons visibly.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const runExclusive = async (work: () => Promise<void>) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await work();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  useEffect(() => {
    fetch("/api/auth/password-reset/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body: VerifyTokenInfo) => {
        setInfo(body);
        setNeedsTotp(body.totpEnabled === true);
      })
      .catch(() => setInvalidToken(true));
  }, [token]);

  // Only included when the account needs it, so non-2FA resets send exactly
  // the same body as before.
  const totpField = () => (needsTotp ? { totpCode } : {});

  // Maps a 2FA-related rejection from /complete or /complete-fresh to a
  // message (revealing the code field if needed), or null if the failure
  // was something else.
  const totpErrorFor = async (response: Response): Promise<string | null> => {
    if (response.status === 429) return t("confirm.errors.tooManyTotpAttempts");
    if (response.status !== 401) return null;
    const body = (await response.json().catch(() => ({}))) as { requiresTotp?: boolean };
    if (!body.requiresTotp) return null;
    const hadCode = needsTotp && totpCode !== "";
    setNeedsTotp(true);
    return hadCode ? t("confirm.errors.invalidTotp") : t("confirm.errors.totpRequired");
  };

  const handleRecoverySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    return runExclusive(submitWithRecovery);
  };

  const submitWithRecovery = async () => {
    if (!info) return;
    setError(null);

    // Deriving the recovery key and unwrapping the private key is kept in its
    // own try/catch, separate from the network call below: a failure here
    // means the recovery code itself doesn't match this account (an
    // intentional throw from unwrapPrivateKey, per Task 13), which is a
    // distinct, actionable error from a network/server failure on the
    // /complete call. Conflating the two into a single "wrong recovery code"
    // message would mislead a user who typed the right code but hit a
    // transient server error.
    let privateKey: Uint8Array;
    try {
      const recoveryKey = deriveRecoveryKey(recoveryCode);
      privateKey = unwrapPrivateKey(info.recoveryWrappedPrivateKey, recoveryKey);
    } catch {
      setError(t("confirm.errors.wrongRecoveryCode"));
      return;
    }

    try {
      const newSalt = generateWrappingSalt();
      const newWrappingKey = await deriveWrappingKey(newPassword, newSalt);
      const newPasswordWrappedPrivateKey = wrapPrivateKey(privateKey, newWrappingKey);
      const newAuthKey = await deriveAuthKey(newPassword, newSalt);

      const response = await fetch("/api/auth/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          newAuthKey,
          newPasswordSalt: newSalt,
          newPasswordWrappedPrivateKey,
          ...totpField(),
        }),
      });
      if (!response.ok) {
        const totpError = await totpErrorFor(response);
        if (totpError) return setError(totpError);
        throw new Error("reset failed");
      }
      setDone(true);
    } catch {
      setError(t("confirm.errors.resetFailed"));
    }
  };

  const handleFreshSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    return runExclusive(submitFresh);
  };

  const submitFresh = async () => {
    setError(null);
    const keyPair = nacl.box.keyPair();
    const newSalt = generateWrappingSalt();
    const newWrappingKey = await deriveWrappingKey(newPassword, newSalt);
    const newPasswordWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, newWrappingKey);
    const newAuthKey = await deriveAuthKey(newPassword, newSalt);
    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(newRecoveryCode));

    const response = await fetch("/api/auth/password-reset/complete-fresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        newAuthKey,
        newPasswordSalt: newSalt,
        newPasswordWrappedPrivateKey,
        newRecoveryWrappedPrivateKey,
        newPublicKey: encodeBase64(keyPair.publicKey),
        ...totpField(),
      }),
    });
    if (!response.ok) return setError((await totpErrorFor(response)) ?? t("confirm.errors.invalidToken"));
    // Don't setDone here — show the new recovery code first and wait for
    // explicit confirmation (see handleFreshRecoveryConfirm below).
    setFreshRecoveryCode(newRecoveryCode);
  };

  const handleFreshRecoveryConfirm = () => {
    setDone(true);
  };

  if (invalidToken) return <p role="alert">{t("confirm.errors.invalidToken")}</p>;

  if (freshRecoveryCode && !done) {
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardHeader>
          <CardTitle>{t("confirm.newRecoveryTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{t("confirm.newRecoveryWarning")}</AlertDescription>
          </Alert>
          <p className="break-all rounded bg-muted p-2 font-mono text-sm">{freshRecoveryCode}</p>
          <Button onClick={handleFreshRecoveryConfirm}>{t("confirm.newRecoveryConfirm")}</Button>
        </CardContent>
      </Card>
    );
  }

  if (done) return <p>{t("confirm.success")}</p>;
  if (!info) return <p>…</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("confirm.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {!noRecovery && (
          <form className="space-y-4" onSubmit={handleRecoverySubmit}>
            <p>{t("confirm.recoveryHelp")}</p>
            <div>
              <label htmlFor="recovery-code">{t("confirm.recoveryCode")}</label>
              <input
                id="recovery-code"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                className="w-full rounded border p-2"
              />
            </div>
            <div>
              <label htmlFor="new-password">{t("confirm.newPassword")}</label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded border p-2"
              />
            </div>
            {needsTotp && (
              <div>
                <p>{t("confirm.totpHelp")}</p>
                <label htmlFor="reset-totp">{t("confirm.totpCode")}</label>
                <input
                  id="reset-totp"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  className="w-full rounded border p-2"
                />
              </div>
            )}
            <Button type="submit" disabled={submitting}>
              {t("confirm.submitWithRecovery")}
            </Button>
            <Button type="button" variant="ghost" disabled={submitting} onClick={() => setNoRecovery(true)}>
              {t("confirm.noRecovery")}
            </Button>
          </form>
        )}
        {noRecovery && (
          <form className="space-y-4" onSubmit={handleFreshSubmit}>
            <Alert variant="destructive">
              <AlertDescription>{t("confirm.freshWarning")}</AlertDescription>
            </Alert>
            <div>
              <label htmlFor="fresh-new-password">{t("confirm.newPassword")}</label>
              <input
                id="fresh-new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded border p-2"
              />
            </div>
            {needsTotp && (
              <div>
                <p>{t("confirm.totpHelp")}</p>
                <label htmlFor="fresh-reset-totp">{t("confirm.totpCode")}</label>
                <input
                  id="fresh-reset-totp"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  className="w-full rounded border p-2"
                />
              </div>
            )}
            <Button type="submit" disabled={submitting}>
              {t("confirm.submitFresh")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
