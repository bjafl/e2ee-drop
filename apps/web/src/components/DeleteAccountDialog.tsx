// apps/web/src/components/DeleteAccountDialog.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MeResponse } from "@e2ee-drop/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deriveAuthKey } from "@/lib/keyWrapping";
import i18n from "@/i18n";
import deleteAccountEn from "@/locales/en/deleteAccount.json";
import deleteAccountNb from "@/locales/nb/deleteAccount.json";

i18n.addResourceBundle("en", "deleteAccount", deleteAccountEn, true, false);
i18n.addResourceBundle("nb", "deleteAccount", deleteAccountNb, true, false);

export interface DeleteAccountDialogProps {
  onDeleted: () => void;
}

export function DeleteAccountDialog({ onDeleted }: DeleteAccountDialogProps) {
  const { t } = useTranslation("deleteAccount");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // The DELETE /api/account route requires an authKey re-confirmation,
      // never the plaintext password (that would reopen the zero-knowledge
      // gap Plan 2's finding C1 closed). Deriving authKey needs
      // passwordSalt, which the restored useAuth() user state doesn't carry
      // (AuthUser has no passwordSalt field), so it's fetched fresh here —
      // the same "fetch salt, derive authKey, send it" sequence useAuth's
      // login() and ConfirmPasswordResetPage already use.
      const meResponse = await fetch("/api/auth/me");
      if (!meResponse.ok) {
        setError(t("errors.unknown"));
        return;
      }
      const { passwordSalt } = (await meResponse.json()) as MeResponse;
      const authKey = await deriveAuthKey(password, passwordSalt);

      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authKey }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: t("errors.unknown") }));
        setError(body.error ?? t("errors.unknown"));
        return;
      }
      onDeleted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog>
      {/* This project's alert-dialog.tsx is built on @base-ui/react, which
          composes via a `render` prop rather than radix-style `asChild`
          (see AlertDialogCancel's own `render={<Button .../>}` above) —
          `asChild` isn't a prop base-ui's Trigger accepts. */}
      <AlertDialogTrigger render={<Button variant="destructive">{t("triggerButton")}</Button>} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("warning")}</AlertDialogDescription>
        </AlertDialogHeader>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("passwordPlaceholder")}
          className="w-full rounded border p-2 text-sm"
          data-testid="delete-account-password"
        />
        {error && <p role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={!password || submitting} onClick={handleConfirm}>
            {t("confirmButton")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
