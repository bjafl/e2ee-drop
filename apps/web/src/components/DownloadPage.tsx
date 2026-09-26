// apps/web/src/components/DownloadPage.tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { decodeBase64 } from "tweetnacl-util";
import nacl from "tweetnacl";
import type {
  DownloadUrlResponse,
  DropStatus,
  DropSummary,
  LinkStatusResponse,
  ListDropsResponse,
} from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import downloadEn from "@/locales/en/download.json";
import downloadNb from "@/locales/nb/download.json";

i18n.addResourceBundle("en", "download", downloadEn, true, false);
i18n.addResourceBundle("nb", "download", downloadNb, true, false);

// Shape of each SSE message from GET /api/links/:slug/events (apps/api/src/lib/dropEvents.ts).
interface DropEvent {
  type: "drop-created" | "drop-updated";
  drop: DropSummary;
}

// Which experience this page is showing:
// - "anonymous": this browser holds the private key for a Plan 1 anonymous
//   link (useLocalLinks) — the single-drop view, unchanged apart from SSE.
// - "owned": the logged-in user's own link — the multi-drop queue view.
// - "none": neither — the "no private key" message.
// - "checking": a logged-in user without a local key; waiting for
//   GET /api/links/:slug to say whether the link is theirs.
type PageMode = "checking" | "anonymous" | "owned" | "none";

// Mirrors the backend's download-url gate (routes/downloads.ts): once the upload
// has finished, a download URL can be (re-)issued for "uploaded", "downloading" and
// "downloaded" alike. Gating on "uploaded" only would strand a recipient who
// reloads, or whose first attempt failed after the status moved to "downloading",
// on the waiting message forever.
function isReadyForDownload(drop: DropSummary | null | undefined): drop is DropSummary {
  return drop != null && drop.status !== "uploading";
}

// Drop status only ever moves forward. Ranking it lets the page merge the
// one-off snapshot and the SSE stream in whatever order they arrive: a
// snapshot that resolves after a newer event must not regress the drop.
const STATUS_RANK: Record<DropStatus, number> = {
  uploading: 0,
  uploaded: 1,
  downloading: 2,
  downloaded: 3,
};

function newerOf(current: DropSummary, incoming: DropSummary): DropSummary {
  return STATUS_RANK[incoming.status] >= STATUS_RANK[current.status] ? incoming : current;
}

// Merges drops into the list by id. A known drop is updated *in place*, so
// the owned queue keeps its oldest-first order from GET /drops as status
// events arrive. Only a drop not seen before is appended.
function mergeDrops(prev: DropSummary[], incoming: DropSummary[]): DropSummary[] {
  const next = [...prev];
  for (const drop of incoming) {
    const index = next.findIndex((existing) => existing.id === drop.id);
    if (index === -1) next.push(drop);
    else next[index] = newerOf(next[index], drop);
  }
  return next;
}

// Remount the page body per link and per account, so per-link state (drops,
// codewords, download progress, errors) can never carry over from a previous
// slug or a previous logged-in user.
export function DownloadPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  return <DownloadPageForLink key={`${slug ?? ""}|${user?.publicKey ?? ""}`} />;
}

function DownloadPageForLink() {
  const { t } = useTranslation("download");
  const { slug } = useParams<{ slug: string }>();
  const { links } = useLocalLinks();
  const { user } = useAuth();
  const { setKeyPair, decryptFile } = useFileEncryption();
  const [drops, setDrops] = useState<DropSummary[]>([]);
  const [codewords, setCodewords] = useState<string[]>([]);
  // Result of the ownership check below, tagged with the slug + public key it
  // was computed for, so a result can never leak across a slug or account
  // change (a stale "owned" would otherwise call /drops for the wrong link for
  // one effect pass before the new check resets it).
  const [ownership, setOwnership] = useState<{ key: string; owned: boolean } | null>(null);
  // Drops this tab has finished downloading. In-memory only, and never used to
  // decide whether to show a download button after a reload — only to show the
  // "downloaded" confirmation (anonymous view) or hide the item (queue view).
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  // `linkNotFound` is a fatal, page-replacing condition (the link itself
  // doesn't exist / never existed in this browser). `downloadFailed` is a
  // failure during the download/decrypt action, which must NOT tear down
  // the page — the recipient needs to see it and retry the same button.
  // Both are booleans (translated only at render time) rather than stored
  // strings, so that the async effects below don't need `t` in their
  // dependency arrays.
  const [linkNotFound, setLinkNotFound] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  const stored = slug ? links[slug] : undefined;
  // Depend on primitives, not object references: nothing guarantees a hook
  // consumer (including test doubles) returns referentially-stable objects
  // across renders, and a churning object identity in a dependency array would
  // re-run the effects below — re-fetching and re-subscribing — on every render.
  const storedPrivateKey = stored?.privateKey;
  const userPublicKey = user?.publicKey;
  const userKeyPair = user?.keyPair ?? null;

  // A local anonymous-link key always wins: this browser created that link, and
  // Plan 1's flow for it must not change just because someone is logged in.
  // Otherwise a logged-in user only gets the queue once the server has
  // confirmed the link is theirs.
  const ownershipKey = `${slug ?? ""}|${userPublicKey ?? ""}`;
  const mode: PageMode = storedPrivateKey
    ? "anonymous"
    : !userPublicKey
      ? "none"
      : ownership?.key !== ownershipKey
        ? "checking"
        : ownership.owned
          ? "owned"
          : "none";

  useEffect(() => {
    if (!storedPrivateKey) return;
    try {
      setKeyPair(nacl.box.keyPair.fromSecretKey(decodeBase64(storedPrivateKey)));
    } catch {
      // Malformed local storage data (e.g. corrupted/truncated key). Don't
      // crash the whole page over it — leave the key pair unset, which
      // surfaces later as a normal, retryable "download failed" once the
      // recipient actually tries to decrypt (useFileEncryption.decryptFile
      // throws "No local key pair found" without a valid key), instead of a
      // hard render crash before anything is shown.
    }
  }, [storedPrivateKey, setKeyPair]);

  useEffect(() => {
    if (mode === "owned" && userKeyPair) setKeyPair(userKeyPair);
  }, [mode, userKeyPair, setKeyPair]);

  // Ownership check for a logged-in user with no local key for this slug.
  // Being logged in says nothing about whether *this* link is theirs: they may
  // be visiting an anonymous link or somebody else's link. GET /api/links/:slug
  // (open to anyone) says whether the link is anonymous and which public key it
  // encrypts to. Every owned link encrypts to its owner's account public key
  // (created with owner.publicKey, and all owned links are deleted if the
  // account's keys are ever replaced — see passwordReset.ts), so an owned link
  // whose recipientPublicKey is the current user's public key is theirs. Only
  // then is the owner-only GET /drops route called; the server still enforces
  // ownership there regardless.
  useEffect(() => {
    if (!slug || storedPrivateKey || !userPublicKey) return;
    let cancelled = false;
    const key = `${slug}|${userPublicKey}`;

    (async () => {
      let owned = false;
      try {
        const res = await fetch(`/api/links/${slug}`);
        if (res.ok) {
          const data = (await res.json()) as LinkStatusResponse;
          owned = !data.isAnonymous && data.recipientPublicKey === userPublicKey;
        }
      } catch {
        // Unreachable/unknown link: fall through to "not owned", i.e. exactly
        // what a logged-out visitor without a local key sees.
      }
      if (!cancelled) setOwnership({ key, owned });
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, storedPrivateKey, userPublicKey]);

  // Snapshot + live status. The snapshot is loaded from `onopen`, on every open
  // (the first one and each automatic reconnect), never alongside constructing
  // the EventSource: constructing it doesn't mean the server has subscribed
  // yet, so a snapshot fetched straight away could be answered before the
  // subscription exists and an event emitted in between would reach nobody.
  // The server subscribes in the same synchronous tick as it writes the stream's
  // first bytes (routes/events.ts), so by the time `onopen` fires every later
  // change is either already in the snapshot or will arrive as an event. The
  // monotonic-status merge makes their relative arrival order irrelevant.
  //
  // If the stream can't be opened at all (e.g. the events route answers 404
  // for an expired link, which makes the browser give up with readyState
  // CLOSED instead of retrying), load the snapshot anyway so the page still
  // shows the link's real state — including the "link not found" message.
  useEffect(() => {
    if (!slug || (mode !== "anonymous" && mode !== "owned")) return;
    let cancelled = false;

    async function loadSnapshot() {
      try {
        if (mode === "owned") {
          const res = await fetch(`/api/links/${slug}/drops`);
          if (cancelled) return;
          if (!res.ok) {
            setLinkNotFound(true);
            return;
          }
          const data = (await res.json()) as ListDropsResponse;
          if (cancelled) return;
          setDrops((prev) => mergeDrops(prev, data.drops));
        } else {
          const res = await fetch(`/api/links/${slug}`);
          if (cancelled) return;
          if (!res.ok) {
            // The link itself is gone (expired/never existed) — a genuine dead end.
            setLinkNotFound(true);
            return;
          }
          const data = (await res.json()) as LinkStatusResponse;
          if (cancelled) return;
          if (data.drop) setDrops((prev) => mergeDrops(prev, [data.drop as DropSummary]));
          setCodewords(data.codewords ?? []);
        }
      } catch {
        // Transient network failure — don't strand the recipient on a hard
        // error; the SSE stream (and its re-open snapshot) will catch up.
      }
    }

    const source = new EventSource(`/api/links/${slug}/events`);
    source.onopen = () => {
      loadSnapshot();
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) loadSnapshot();
    };
    source.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as DropEvent;
        if (!parsed?.drop?.id) return;
        setDrops((prev) => mergeDrops(prev, [parsed.drop]));
      } catch {
        // Ignore malformed events; the next snapshot/event will correct state.
      }
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, [slug, mode]);

  const handleDownload = useCallback(
    async (drop: DropSummary) => {
      if (!slug || downloadingIds.has(drop.id)) return;
      setDownloadFailed(false);
      setDownloadingIds((prev) => new Set(prev).add(drop.id));
      try {
        // An owned link can hold several drops, so name the one wanted. The
        // anonymous/one-time request stays exactly as in Plan 1 (the server
        // falls back to the link's single drop).
        const downloadUrlPath =
          mode === "owned"
            ? `/api/links/${slug}/download-url?dropId=${encodeURIComponent(drop.id)}`
            : `/api/links/${slug}/download-url`;
        const res = await fetch(downloadUrlPath);
        if (!res.ok) throw new Error("download-url failed");
        const info = (await res.json()) as DownloadUrlResponse;

        const fileRes = await fetch(info.downloadUrl);
        if (!fileRes.ok) throw new Error("encrypted file fetch failed");
        const blob = await fileRes.blob();

        const file = await decryptFile(blob, {
          nonce: info.nonce,
          senderPublicKey: info.senderPublicKey,
          fileName: info.fileName,
          mimeType: info.mimeType,
        });

        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);

        // The file is already decrypted and saved to disk at this point, which
        // is the part the recipient actually cares about. Marking the drop as
        // "downloaded" server-side is best-effort bookkeeping — a failure here
        // must not roll back the success the recipient already has.
        try {
          await fetch(`/api/links/${slug}/drops/${drop.id}/downloaded`, { method: "POST" });
        } catch {
          // ignore — non-critical status update
        }

        setDownloadedIds((prev) => new Set(prev).add(drop.id));
      } catch {
        setDownloadFailed(true);
      } finally {
        setDownloadingIds((prev) => {
          const next = new Set(prev);
          next.delete(drop.id);
          return next;
        });
      }
    },
    [slug, mode, downloadingIds, decryptFile]
  );

  if (mode === "checking") return null;
  if (mode === "none") return <p>{t("errors.noLocalKey")}</p>;
  if (linkNotFound) return <p role="alert">{t("errors.linkNotFound")}</p>;

  const failureAlert = downloadFailed && (
    <Alert variant="destructive">
      <AlertDescription>{t("errors.downloadFailed")}</AlertDescription>
    </Alert>
  );

  if (mode === "owned") {
    // The queue is "everything not yet downloaded" (GET /drops's own rule), so
    // a drop leaves it once it's downloaded — by this tab, or reported by SSE.
    // A drop that is merely "downloading" (e.g. fetched fresh after a reload,
    // with no in-memory downloadedIds) stays, with a working download button.
    const queued = drops.filter((drop) => drop.status !== "downloaded" && !downloadedIds.has(drop.id));
    // Plan 2 never persists the owner's decryption key pair across a page
    // reload: a bare reload restores `user` from GET /api/auth/me but leaves
    // `user.keyPair` null until the next login() call. Without this check, a
    // reloaded owner would see their queue exactly as before and every
    // download would silently fail with the generic "download failed" alert,
    // giving no indication that logging in again would fix it. File names are
    // harmless metadata (no crypto needed to display them), so the list still
    // renders — only the download affordance is replaced with the prompt.
    const needsRelogin = !userKeyPair;
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardHeader>
          <CardTitle>{t("queueTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {needsRelogin && (
            <Alert>
              <AlertDescription>
                {t("reloginRequired")} <Link to="/login">{t("reloginLink")}</Link>
              </AlertDescription>
            </Alert>
          )}
          {!needsRelogin && failureAlert}
          {queued.length === 0 && <p>{t("queueEmpty")}</p>}
          {queued.map((drop) => (
            <div key={drop.id} className="space-y-2 border-b pb-4 last:border-0">
              <p>{drop.fileName}</p>
              {drop.message && <p className="italic">{drop.message}</p>}
              {needsRelogin ? null : isReadyForDownload(drop) ? (
                <Button onClick={() => handleDownload(drop)} disabled={downloadingIds.has(drop.id)}>
                  {t("downloadButton")}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">{t("waitingForFile")}</p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  // Anonymous/one-time: a single drop, exactly as in Plan 1.
  const drop = drops[0] ?? null;
  const downloaded = drop !== null && downloadedIds.has(drop.id);
  const isDownloading = drop !== null && downloadingIds.has(drop.id);

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {codewords.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
            <p className="font-mono text-lg">{codewords.join(" · ")}</p>
          </div>
        )}
        {failureAlert}
        {!isReadyForDownload(drop) && !downloaded && <p>{t("waitingForFile")}</p>}
        {isReadyForDownload(drop) && !downloaded && (
          <>
            <p>{drop.fileName}</p>
            {drop.message && <p className="italic">{drop.message}</p>}
            <Button onClick={() => handleDownload(drop)} disabled={isDownloading}>
              {t("downloadButton")}
            </Button>
          </>
        )}
        {downloaded && <p>{t("downloadedMessage")}</p>}
      </CardContent>
    </Card>
  );
}
