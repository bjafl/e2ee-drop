// apps/web/src/components/AccountPage.tsx
import { Navigate, useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();

  // Wait for the initial session restore before deciding the visitor is
  // logged out, so a hard refresh of /account doesn't bounce to /login.
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  // The server has already deleted the account and its session row, but
  // logout() still matters: it clears the cookie and — more importantly —
  // drops the in-memory user, including the decrypted private key.
  const handleDeleted = async () => {
    try {
      await logout();
    } finally {
      navigate("/", { replace: true });
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
          <h2 className="mb-2 font-semibold">{t("dangerZone")}</h2>
          <DeleteAccountDialog onDeleted={handleDeleted} />
        </div>
      </CardContent>
    </Card>
  );
}
