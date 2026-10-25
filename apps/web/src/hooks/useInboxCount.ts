// apps/web/src/hooks/useInboxCount.ts
//
// Issue #3: how many people have sent this account something it hasn't fully
// fetched yet, for the nav's Inbox badge. One GET /api/inbox when enabled,
// then event-driven: the existing /api/inbox/events stream fires whenever a
// drop under this account changes, and only then is the count refetched — no
// polling, no fetch per page navigation (NavBar stays mounted across routes).
import { useEffect, useState } from "react";
import type { InboxResponse } from "@e2ee-drop/shared";

export function countPendingIncoming(data: Partial<InboxResponse> | null | undefined): number {
  const counterparties = Array.isArray(data?.counterparties) ? data.counterparties : [];
  return counterparties.filter(
    (c) =>
      c.direction === "incoming" &&
      Array.isArray(c.drops) &&
      c.drops.some((d) => d.deliveryStatus !== "delivered")
  ).length;
}

export function useInboxCount(enabled: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/inbox");
        if (!res.ok) return;
        const body = (await res.json()) as Partial<InboxResponse>;
        if (active) setCount(countPendingIncoming(body));
      } catch {
        // Network error or no fetch: keep the last known count.
      }
    };
    void load();

    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      source = new EventSource("/api/inbox/events");
      source.onmessage = () => void load();
    }
    return () => {
      active = false;
      source?.close();
    };
  }, [enabled]);

  return enabled ? count : 0;
}
