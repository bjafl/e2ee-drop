// apps/web/src/components/ConfirmPasswordResetPage.tsx
import { useEffect, useState } from "react";
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
  wrapPrivateKey,
  unwrapPrivateKey,
  deriveRecoveryKey,
  generateRecoveryCode,
} from "@/lib/keyWrapping";
import i18n from "@/i18n";
import passwordResetEn from "@/locales/en/passwordReset.json";
import passwordResetNb from "@/locales/nb/passwordReset.json";

i18n.addResourceBundle("en", "passwordReset", passwordResetEn, true, false);
i18n.addResourceBundle("nb", "passwordReset", passwordResetNb, true, false);

interface VerifyTokenInfo {
  passwordSalt: string;
  recoveryWrappedPrivateKey: string;
}

export function ConfirmPasswordResetPage() {
  const { t } = useTranslation("passwordReset");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [info, setInfo] = useState<VerifyTokenInfo | null>(null);
  const [invalidToken, setInvalidToken] = useState(false);
  const [noRecovery, setNoRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
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

  useEffect(() => {
    fetch("/api/auth/password-reset/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setInfo)
      .catch(() => setInvalidToken(true));
  }, [token]);

  const handleRecoverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

      const response = await fetch("/api/auth/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          newPassword,
          newPasswordSalt: newSalt,
          newPasswordWrappedPrivateKey,
        }),
      });
      if (!response.ok) throw new Error("reset failed");
      setDone(true);
    } catch {
      setError(t("confirm.errors.resetFailed"));
    }
  };

  const handleFreshSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const keyPair = nacl.box.keyPair();
    const newSalt = generateWrappingSalt();
    const newWrappingKey = await deriveWrappingKey(newPassword, newSalt);
    const newPasswordWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, newWrappingKey);
    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(newRecoveryCode));

    const response = await fetch("/api/auth/password-reset/complete-fresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        newPassword,
        newPasswordSalt: newSalt,
        newPasswordWrappedPrivateKey,
        newRecoveryWrappedPrivateKey,
        newPublicKey: encodeBase64(keyPair.publicKey),
      }),
    });
    if (!response.ok) return setError(t("confirm.errors.invalidToken"));
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
            <Button type="submit">{t("confirm.submitWithRecovery")}</Button>
            <Button type="button" variant="ghost" onClick={() => setNoRecovery(true)}>
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
            <Button type="submit">{t("confirm.submitFresh")}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
