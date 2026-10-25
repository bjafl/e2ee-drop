// apps/web/src/components/InboxPage.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowLeft, ArrowUp, Download, Inbox as InboxIcon, UserRound } from "lucide-react";
import type { InboxCounterparty, InboxDrop, InboxResponse } from "@e2ee-drop/shared";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageContainer, PageHeader } from "@/components/common/Page";
import { formatDate, formatDateTime } from "@/lib/format";
import i18n from "@/i18n";
import inboxEn from "@/locales/en/inbox.json";
import inboxNb from "@/locales/nb/inbox.json";

i18n.addResourceBundle("en", "inbox", inboxEn, true, false);
i18n.addResourceBundle("nb", "inbox", inboxNb, true, false);

type Filter = "all" | "incoming" | "outgoing";
type DeliveryStatus = InboxDrop["deliveryStatus"];

// How far along the Sent → Opened → Delivered track a drop is, and which
// status colour token its label uses (always paired with the word itself).
const PROGRESS: Record<DeliveryStatus, number> = {
  sender_opened: 0,
  sent: 1,
  receiver_opened: 2,
  partial_delivery: 2,
  delivered: 3,
};
const STATUS_TONE: Record<DeliveryStatus, string> = {
  sender_opened: "text-muted-foreground",
  sent: "text-info",
  receiver_opened: "text-info",
  partial_delivery: "text-warning",
  delivered: "text-success",
};

function CounterpartyAvatar({ counterparty, size = "md" }: { counterparty: InboxCounterparty; size?: "md" | "lg" }) {
  const box = size === "lg" ? "size-12 text-sm" : "size-9 text-xs";
  if (counterparty.kind === "anonymous") {
    return (
      <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", box)}>
        <UserRound className="size-4" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-brand-tint font-semibold uppercase", box)}>
      {counterparty.displayName.slice(0, 2)}
    </span>
  );
}

function DropCard({ drop, direction }: { drop: InboxDrop; direction: InboxCounterparty["direction"] }) {
  const { t } = useTranslation("inbox");
  const status = drop.deliveryStatus;
  const reached = PROGRESS[status];
  const steps = [
    t("steps.sent"),
    direction === "incoming" ? t("steps.openedByYou") : t("steps.openedByThem"),
    t("steps.delivered"),
  ];
  const canOpen = direction === "incoming" && status !== "delivered" && status !== "sender_opened";

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[13px] leading-5 font-medium break-all">{drop.linkSlug}</span>
          <span className="text-xs leading-4 text-muted-foreground">
            {formatDateTime(drop.createdAt)}
            {drop.hasMessage && ` · ${t("withMessage")}`}
          </span>
        </div>
        <span className={cn("inline-flex items-center gap-1.5 text-xs leading-4 font-medium", STATUS_TONE[status])}>
          <span aria-hidden="true" className="size-2 rounded-full bg-current" />
          {direction === "incoming" ? t(`status.${status}`) : t(`outgoingStatus.${status}`)}
        </span>
      </div>
      <ol aria-label={t("progressLabel")} className="grid grid-cols-3 gap-2">
        {steps.map((label, i) => (
          <li key={label} className="flex flex-col gap-1">
            <span aria-hidden="true" className={cn("h-1 rounded-full", i < reached ? "bg-primary" : "bg-muted")} />
            <span className={cn("text-xs leading-4 font-medium", i < reached ? "text-foreground" : "text-muted-foreground")}>
              {label}
              <span className="sr-only">{i < reached ? ` (${t("stepDone")})` : ` (${t("stepPending")})`}</span>
            </span>
          </li>
        ))}
      </ol>
      {canOpen && (
        <Button asChild className="self-stretch sm:self-end">
          <Link to={`/receive/${drop.linkSlug}`}>
            <Download aria-hidden="true" />
            {t("openAndDownload")}
          </Link>
        </Button>
      )}
    </li>
  );
}

export function InboxPage() {
  const { t } = useTranslation("inbox");
  const [counterparties, setCounterparties] = useState<InboxCounterparty[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

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

  const visible = counterparties?.filter((c) => filter === "all" || c.direction === filter) ?? null;
  const selected = visible?.find((c) => c.key === selectedKey) ?? null;

  const filters: [Filter, string][] = [
    ["all", t("filterAll")],
    ["incoming", t("filterIncoming")],
    ["outgoing", t("filterOutgoing")],
  ];

  const latest = (c: InboxCounterparty) => (c.drops.length ? Math.max(...c.drops.map((d) => d.createdAt)) : null);

  return (
    <PageContainer>
      <PageHeader
        title={t("title")}
        description={t("description")}
        eyebrow={null}
        actions={
          <div role="group" aria-label={t("filterLabel")} className="inline-flex gap-1 rounded-md bg-muted p-1">
            {filters.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "h-8 rounded-sm px-3 text-sm font-medium transition-colors duration-150",
                  filter === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        <span className="mt-1 inline-flex items-center gap-1.5 text-xs leading-4 font-medium text-muted-foreground">
          <span aria-hidden="true" className="size-2 rounded-full bg-success" />
          {t("liveHint")}
        </span>
      </PageHeader>

      {visible?.length === 0 ? (
        <EmptyState icon={<InboxIcon />} title={t("empty")}>
          {t("emptyHint")}
        </EmptyState>
      ) : (
        <div className="flex flex-wrap overflow-hidden rounded-lg border bg-card">
          <ul
            aria-label={t("peopleLabel")}
            className={cn(
              "flex min-w-0 flex-[1_1_280px] flex-col gap-1 p-2 md:border-r",
              selected && "hidden md:flex"
            )}
          >
            {visible === null &&
              [0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2" aria-hidden="true">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </li>
              ))}
            {visible === null && <li className="sr-only">{t("loading")}</li>}
            {visible?.map((c) => {
              const last = latest(c);
              const isSelected = selectedKey === c.key;
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    aria-current={isSelected ? "true" : undefined}
                    className={cn(
                      "flex min-h-14 w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors duration-150 hover:bg-accent",
                      isSelected && "bg-accent"
                    )}
                    onClick={() => setSelectedKey(c.key)}
                  >
                    <CounterpartyAvatar counterparty={c} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{c.displayName}</span>
                      <span className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
                        {c.direction === "incoming" ? (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        )}
                        {c.direction === "incoming" ? t("incomingBadge") : t("outgoingBadge")}
                        {last !== null && ` · ${formatDate(last)}`}
                      </span>
                    </span>
                    {c.drops.length > 0 && (
                      <Badge variant="muted" className="tabular-nums" aria-label={t("dropCount", { count: c.drops.length })}>
                        {c.drops.length}
                      </Badge>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <section
            aria-label={t("dropsLabel")}
            className={cn("flex min-w-0 flex-[999_1_520px] flex-col gap-4 p-4 md:p-6", !selected && "hidden md:flex")}
          >
            {!selected && (
              <p className="m-auto max-w-xs py-8 text-center text-muted-foreground">{t("selectPrompt")}</p>
            )}
            {selected && (
              <>
                <Button variant="ghost" className="-ml-2 self-start md:hidden" onClick={() => setSelectedKey(null)}>
                  <ArrowLeft aria-hidden="true" />
                  {t("backToList")}
                </Button>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <CounterpartyAvatar counterparty={selected} size="lg" />
                    <div className="flex min-w-0 flex-col">
                      <h2 className="truncate text-xl leading-7 font-semibold tracking-[-0.01em]">{selected.displayName}</h2>
                      {selected.kind === "anonymous" && (
                        <span className="text-xs leading-4 text-muted-foreground">{t("anonymousHint")}</span>
                      )}
                    </div>
                  </div>
                  <Badge variant="default">
                    {selected.direction === "incoming" ? t("incomingBadge") : t("outgoingBadge")}
                  </Badge>
                </div>
                {selected.drops.length === 0 ? (
                  <p className="text-muted-foreground">{t("noDrops")}</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {selected.drops.map((drop) => (
                      <DropCard key={drop.id} drop={drop} direction={selected.direction} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </PageContainer>
  );
}
