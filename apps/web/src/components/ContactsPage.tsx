// apps/web/src/components/ContactsPage.tsx
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import contactsEn from "@/locales/en/contacts.json";
import contactsNb from "@/locales/nb/contacts.json";

i18n.addResourceBundle("en", "contacts", contactsEn, true, false);
i18n.addResourceBundle("nb", "contacts", contactsNb, true, false);

interface ContactSummary {
  id: string;
  userId: string;
  username: string;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing";
}

export function ContactsPage() {
  const { t } = useTranslation("contacts");
  const [pending, setPending] = useState<ContactSummary[]>([]);
  const [accepted, setAccepted] = useState<ContactSummary[]>([]);
  const [usernameInput, setUsernameInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/contacts");
    if (!res.ok) return;
    const data = await res.json();
    setPending(data.pending);
    setAccepted(data.accepted);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const sendRequest = async () => {
    setError(null);
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usernameInput }),
    });
    if (!res.ok) {
      setError(t("errors.addFailed"));
      return;
    }
    setUsernameInput("");
    await reload();
  };

  const accept = async (id: string) => {
    await fetch(`/api/contacts/${id}/accept`, { method: "POST" });
    await reload();
  };

  // Either party to a still-pending request may end it: the recipient rejects
  // an incoming request, and the sender cancels a request they sent. Both hit
  // the same reject endpoint (see apps/api/src/lib/contacts.ts rejectContactRequest,
  // which checks membership in the relationship, not a specific role).
  const reject = async (id: string) => {
    await fetch(`/api/contacts/${id}/reject`, { method: "POST" });
    await reload();
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex gap-2">
          <input
            value={usernameInput}
            onChange={(e) => setUsernameInput(e.target.value)}
            placeholder={t("addPlaceholder")}
            className="flex-1 rounded border p-2 text-sm"
          />
          <Button onClick={sendRequest}>{t("addButton")}</Button>
        </div>
        {error && <p role="alert">{error}</p>}

        <div>
          <h2 className="font-semibold">{t("pendingHeading")}</h2>
          {pending.map((contact) => (
            <div key={contact.id} className="flex items-center justify-between py-1">
              <span>
                <span>{contact.username}</span>{" "}
                <span className="text-muted-foreground text-xs">
                  ({contact.direction === "incoming" ? t("incoming") : t("outgoing")})
                </span>
              </span>
              {contact.direction === "incoming" ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => accept(contact.id)}>
                    {t("acceptButton")}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => reject(contact.id)}>
                    {t("rejectButton")}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="destructive" onClick={() => reject(contact.id)}>
                  {t("cancelButton")}
                </Button>
              )}
            </div>
          ))}
        </div>

        <div>
          <h2 className="font-semibold">{t("acceptedHeading")}</h2>
          {accepted.map((contact) => (
            <div key={contact.id} className="flex items-center justify-between py-1">
              <span>{contact.username}</span>
              <Button asChild size="sm">
                <Link to={`/send/${contact.username}`}>{t("sendFileButton")}</Link>
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
