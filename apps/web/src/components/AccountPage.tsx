// apps/web/src/components/AccountPage.tsx
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteAccountDialog } from "@/components/DeleteAccountDialog";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import accountEn from "@/locales/en/account.json";
import accountNb from "@/locales/nb/account.json";

i18n.addResourceBundle("en", "account", accountEn, true, false);
i18n.addResourceBundle("nb", "account", accountNb, true, false);

export function AccountPage() {
  const { t } = useTranslation("account");
  const { user, loading, logout } = useAuth();
  const [deleted, setDeleted] = useState(false);
  // Defaults to true, matching the DB column's default (see
  // packages/db/prisma/schema.prisma) — undefined here just means the
  // initial /api/auth/me restore hasn't populated it yet (see AuthUser).
  const [allowContactRequests, setAllowContactRequests] = useState(user?.allowContactRequests ?? true);

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

  // Optimistic: flips immediately, then persists. On failure the toggle is
  // rolled back rather than left showing a state the server never saved —
  // matching DeleteAccountDialog's approach of trusting the request unless
  // it's known to have failed.
  const toggleAllowContactRequests = async () => {
    const next = !allowContactRequests;
    setAllowContactRequests(next);
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowContactRequests: next }),
      });
      if (!response.ok) setAllowContactRequests(!next);
    } catch {
      setAllowContactRequests(!next);
    }
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
        <div>
          <h2 className="mb-2 font-semibold">{t("privacy")}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowContactRequests}
              onChange={toggleAllowContactRequests}
              aria-label={t("allowContactRequestsLabel")}
            />
            {t("allowContactRequestsLabel")}
          </label>
        </div>
        <div>
          <h2 className="mb-2 font-semibold">{t("dangerZone")}</h2>
          <DeleteAccountDialog onDeleted={handleDeleted} />
        </div>
      </CardContent>
    </Card>
  );
}
