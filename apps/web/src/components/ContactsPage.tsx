// apps/web/src/components/ContactsPage.tsx
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Send, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/auth/AuthLayout";
import { PageContainer, PageHeader } from "@/components/common/Page";
import i18n from "@/i18n";
import contactsEn from "@/locales/en/contacts.json";
import contactsNb from "@/locales/nb/contacts.json";

i18n.addResourceBundle("en", "contacts", contactsEn, true, false);
i18n.addResourceBundle("nb", "contacts", contactsNb, true, false);

interface ContactSummary {
  id: string;
  userId: string;
  username: string;
  status: "pending" | "accepted" | "blocked";
  direction: "incoming" | "outgoing";
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold uppercase"
    >
      {name.slice(0, 2)}
    </span>
  );
}

function Row({ name, meta, children }: { name: string; meta?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <Avatar name={name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{name}</span>
        {meta}
      </span>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </li>
  );
}

export function ContactsPage() {
  const { t } = useTranslation("contacts");
  const [pending, setPending] = useState<ContactSummary[]>([]);
  const [accepted, setAccepted] = useState<ContactSummary[]>([]);
  const [blocked, setBlocked] = useState<ContactSummary[]>([]);
  const [usernameInput, setUsernameInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((data: { pending: ContactSummary[]; accepted: ContactSummary[]; blocked?: ContactSummary[] }) => {
    setPending(data.pending);
    setAccepted(data.accepted);
    // `blocked` holds only rows the caller themselves blocked (see
    // apps/api/src/lib/contacts.ts listContacts) — a row blocked against the
    // caller by the other party never appears in this response at all.
    setBlocked(data.blocked ?? []);
  }, []);

  const reload = useCallback(async () => {
    const res = await fetch("/api/contacts");
    if (!res.ok) return;
    apply(await res.json());
  }, [apply]);

  // Initial load: state is only set once the response arrives (issue #7), and
  // not at all if the page unmounted meanwhile.
  useEffect(() => {
    let active = true;
    fetch("/api/contacts")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data) apply(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [apply]);

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

  const block = async (id: string) => {
    await fetch(`/api/contacts/${id}/block`, { method: "POST" });
    await reload();
  };

  const unblock = async (id: string) => {
    await fetch(`/api/contacts/${id}/unblock`, { method: "POST" });
    await reload();
  };

  const sectionList = (items: ContactSummary[], empty: string, render: (c: ContactSummary) => React.ReactNode) =>
    items.length === 0 ? (
      <p className="text-muted-foreground">{empty}</p>
    ) : (
      <ul className="divide-y divide-border">{items.map(render)}</ul>
    );

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-col gap-6">
        <Card>
          <CardContent>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void sendRequest();
              }}
            >
              <Label htmlFor="contact-username">{t("addLabel")}</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="contact-username"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder={t("addPlaceholder")}
                  autoCapitalize="off"
                  spellCheck={false}
                  className="min-w-48 flex-1"
                />
                <Button type="submit">
                  <UserPlus aria-hidden="true" />
                  {t("addButton")}
                </Button>
              </div>
            </form>
            {error && (
              <div className="mt-3">
                <FormError>{error}</FormError>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("pendingHeading")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sectionList(pending, t("emptyPending"), (contact) => (
              <Row
                key={contact.id}
                name={contact.username}
                meta={
                  <span className="text-xs leading-4 text-muted-foreground">
                    {contact.direction === "incoming" ? t("incoming") : t("outgoing")}
                  </span>
                }
              >
                {contact.direction === "incoming" ? (
                  <>
                    <Button size="sm" onClick={() => accept(contact.id)}>
                      {t("acceptButton")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => reject(contact.id)}>
                      {t("rejectButton")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => reject(contact.id)}>
                    {t("cancelButton")}
                  </Button>
                )}
              </Row>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("acceptedHeading")}</h2>
            </CardTitle>
            <CardDescription>{t("acceptedHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            {sectionList(accepted, t("emptyAccepted"), (contact) => (
              <Row key={contact.id} name={contact.username}>
                <Button asChild size="sm" variant="secondary">
                  <Link to={`/send/${contact.username}`}>
                    <Send aria-hidden="true" />
                    {t("sendFileButton")}
                  </Link>
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => block(contact.id)}>
                  {t("blockButton")}
                </Button>
              </Row>
            ))}
          </CardContent>
        </Card>

        {blocked.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("blockedHeading")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {blocked.map((contact) => (
                  <Row key={contact.id} name={contact.username} meta={<Badge variant="muted">{t("blockedBadge")}</Badge>}>
                    <Button size="sm" variant="outline" onClick={() => unblock(contact.id)}>
                      {t("unblockButton")}
                    </Button>
                  </Row>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </PageContainer>
  );
}
