// apps/web/src/components/InboxPage.tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InboxCounterparty, InboxResponse } from "@e2ee-drop/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import i18n from "@/i18n";
import inboxEn from "@/locales/en/inbox.json";
import inboxNb from "@/locales/nb/inbox.json";

i18n.addResourceBundle("en", "inbox", inboxEn, true, false);
i18n.addResourceBundle("nb", "inbox", inboxNb, true, false);

export function InboxPage() {
  const { t } = useTranslation("inbox");
  const [counterparties, setCounterparties] = useState<InboxCounterparty[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const loadInbox = () => {
    fetch("/api/inbox")
      .then((res) => (res.ok ? (res.json() as Promise<InboxResponse>) : Promise.reject()))
      .then((data) => setCounterparties(data.counterparties))
      .catch(() => setCounterparties([]));
  };

  useEffect(() => {
    loadInbox();
    const source = new EventSource("/api/inbox/events");
    // Any event on this channel means a drop under this account changed
    // status — simplest correct behavior is to refetch the whole list
    // (small payload, infrequent events), rather than patching state
    // client-side and risking it drifting from the resolved-drop rules
    // lib/inbox.ts enforces server-side.
    source.onmessage = (_event: MessageEvent) => {
      loadInbox();
    };
    return () => source.close();
  }, []);

  const selected = counterparties?.find((c) => c.key === selectedKey) ?? null;

  return (
    <Card className="mx-auto mt-12 max-w-3xl">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex gap-6">
        <ul className="w-1/3 space-y-1 border-r pr-4">
          {counterparties === null && <li className="text-sm text-muted-foreground">{t("loading")}</li>}
          {counterparties?.length === 0 && <li className="text-sm text-muted-foreground">{t("empty")}</li>}
          {counterparties?.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${selectedKey === c.key ? "bg-muted" : ""}`}
                onClick={() => setSelectedKey(c.key)}
              >
                {c.displayName}
                <span className="ml-2 text-xs text-muted-foreground">
                  {c.direction === "incoming" ? t("incomingBadge") : t("outgoingBadge")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="w-2/3">
          {!selected && <p className="text-sm text-muted-foreground">{t("selectPrompt")}</p>}
          {selected && (
            <ul className="space-y-2">
              {selected.drops.map((drop) => (
                <li key={drop.id} className="border-b pb-2 text-sm last:border-0">
                  <p className="font-mono">{drop.linkSlug}</p>
                  <p className="text-muted-foreground">{t(`status.${drop.deliveryStatus}`)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
