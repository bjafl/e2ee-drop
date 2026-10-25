// apps/web/src/hooks/useLocalLinkStatuses.ts
//
// Issue #2: browser-key links (useLocalLinks) only know their slug, key and
// expiry, so the landing list and dashboard couldn't tell "waiting" from "file
// ready". This reads each link's status from the existing, unauthenticated
// GET /api/links/:slug — the same response ReceivePage's "anonymous" mode
// already reads, where the random slug is the capability (see the API's
// toLinkStatusResponse). Nothing secret is fetched: no key material leaves the
// browser, and only the status fields are kept.
//
// Fetched once per set of slugs and again when the window regains focus (the
// recipient coming back to the tab). No polling: the receive page itself has
// the live SSE view.
import { useCallback, useEffect, useState } from "react";
import type { DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";

export type LocalLinkStatus =
  | "unknown" // not fetched yet, or the response couldn't be read
  | "waiting" // no drop yet
  | "uploading" // a sender is uploading right now
  | "ready" // a file is uploaded and waiting to be fetched
  | "opened" // the recipient has opened it but not fetched everything
  | "partial" // some envelopes fetched
  | "delivered" // fully fetched
  | "gone"; // 404: expired, revoked or deleted server-side

function statusFromDrop(drop: DropSummary | null | undefined): LocalLinkStatus {
  if (!drop) return "waiting";
  if (drop.fileUploadStatus === "uploading") return "uploading";
  switch (drop.deliveryStatus) {
    case "delivered":
      return "delivered";
    case "partial_delivery":
      return "partial";
    case "receiver_opened":
      return "opened";
    default:
      return "ready"; // "sent" / "sender_opened" with a completed upload
  }
}

async function fetchStatus(slug: string): Promise<LocalLinkStatus> {
  try {
    const res = await fetch(`/api/links/${encodeURIComponent(slug)}`);
    if (res.status === 404) return "gone";
    if (!res.ok) return "unknown";
    const body = (await res.json()) as Partial<LinkStatusResponse> | null;
    if (!body || typeof body !== "object") return "unknown";
    // A claimed request link's claimant gets the plural `drops`; prefer the
    // most actionable one (anything not yet delivered), else the singular drop.
    const drops = Array.isArray(body.drops) ? body.drops : [];
    const pending = drops.find((d) => d.deliveryStatus !== "delivered");
    return statusFromDrop(pending ?? body.drop);
  } catch {
    return "unknown";
  }
}

export function useLocalLinkStatuses(slugs: string[]): Record<string, LocalLinkStatus> {
  const [statuses, setStatuses] = useState<Record<string, LocalLinkStatus>>({});
  // A stable key so a re-render with the same slugs doesn't refetch.
  const key = slugs.join("\n");

  const load = useCallback(async () => {
    const list = key ? key.split("\n") : [];
    if (list.length === 0) return;
    const results = await Promise.all(list.map(async (slug) => [slug, await fetchStatus(slug)] as const));
    setStatuses(Object.fromEntries(results));
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let active = true;
    const run = () => {
      void load().catch(() => {});
    };
    // Defer to a microtask so the initial fetch doesn't set state synchronously
    // inside the effect body.
    queueMicrotask(() => {
      if (active) run();
    });
    const onFocus = () => run();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [key, load]);

  return statuses;
}
