// apps/web/src/components/ReceivePage.tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import nacl from "tweetnacl";
import type {
  DownloadUrlResponse,
  DropSummary,
  LinkStatusResponse,
  ListDropsResponse,
  RevealMessageResponse,
} from "@e2ee-drop/shared";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  File as FileIcon,
  Info,
  Inbox,
  KeyRound,
  Lock,
  Monitor,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label, FieldHint } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Codewords } from "@/components/common/Codewords";
import { LifetimeBadge, StorageBadge, type LinkStorage } from "@/components/common/LinkBadges";
import { EmptyState, PageContainer, PageHeader } from "@/components/common/Page";
import { formatBytes, formatDateTime, formatTimeLeft } from "@/lib/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import { isLocalStorageWritable } from "@/lib/storageProbe";
import { useFileEncryption, type DecryptedMetadata } from "@/hooks/useFileEncryption";
import { downloadWithProgress } from "@/hooks/useStreamedDownload";
import { useAuth } from "@/hooks/useAuth";
import { useCodewords } from "@/hooks/useCodewords";
import i18n from "@/i18n";
import receiveEn from "@/locales/en/receive.json";
import receiveNb from "@/locales/nb/receive.json";

i18n.addResourceBundle("en", "receive", receiveEn, true, false);
i18n.addResourceBundle("nb", "receive", receiveNb, true, false);

const AUTO_SAVE_STORAGE_KEY = "e2ee-drop:auto-save-zip";

// I2 (final review): how often to re-poll the plain status endpoint once the
// per-link SSE channel has closed for good (readyState CLOSED) and isn't
// coming back on its own — see the onerror handler below. 10-15s per the
// review; a claimant who just claimed and is waiting for the sender to
// upload has no other way to find out short of a manual reload otherwise.
// Exported for the I2 regression test only (ReceivePage.test.tsx uses fake
// timers pinned to this exact value instead of a duplicated magic number).
export const STATUS_POLL_INTERVAL_MS = 12_000;

// Shape of a drop-shaped message from GET /api/links/:slug/events
// (apps/api/src/lib/dropEvents.ts). The channel can also carry a
// "link-claimed" event (for the sender-initiated flow's own page — Task 13);
// this page only ever cares about drop-created/drop-updated, so anything
// else is ignored rather than typed here.
interface DropEvent {
  type: "drop-created" | "drop-updated";
  drop: DropSummary;
}

// Which experience this page is showing:
// - "anonymous": this browser holds the private key for this slug
//   (useLocalLinks) — the single-drop view. Always wins over "owned": this
//   browser created (or claimed) this link, and that must not change just
//   because someone is also logged in.
// - "owned": the logged-in user's own claimed/normal link — the queue view.
// - "claim": the link exists but has no recipientPublicKey yet (design spec
//   §4.2's sender-initiated flow) — shown independently of anonymous/owned,
//   since claiming is a precondition for either of those, not a third mode
//   of the same kind.
// - "none": neither of the above (not logged in, or logged in but this link
//   isn't theirs).
// - "loading": the initial GET /api/links/:slug hasn't resolved yet, so
//   there isn't enough information to pick one of the above.
type PageMode = "loading" | "anonymous" | "owned" | "none" | "claim";

// fileUploadStatus only ever moves forward (uploading -> complete — see
// routes/uploads.ts's transitionFileUploadStatus), and it's the only field a
// drop-created/drop-updated SSE event ever actually changes: fileEnvelopeStatus
// and deliveryStatus are driven entirely by this same client's own receive-side
// actions (download-url/complete-download/download-failed in routes/downloads.ts
// never call emitDropEvent), so there is nothing else here for a race between
// the snapshot and the stream to regress. Ranking fileUploadStatus lets the page
// merge the one-off snapshot and the SSE stream in whatever order they arrive: a
// snapshot that resolves after a newer event must not un-finish an upload the
// recipient is already looking at.
const UPLOAD_RANK: Record<DropSummary["fileUploadStatus"], number> = {
  uploading: 0,
  complete: 1,
};

function newerOf(current: DropSummary, incoming: DropSummary): DropSummary {
  return UPLOAD_RANK[incoming.fileUploadStatus] >= UPLOAD_RANK[current.fileUploadStatus] ? incoming : current;
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
// key pair, decrypted content, download progress, errors) can never carry
// over from a previous slug or a previous logged-in user.
export function ReceivePage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  return <ReceivePageForLink key={`${slug ?? ""}|${user?.publicKey ?? ""}`} />;
}

function ReceivePageForLink() {
  const { t } = useTranslation("receive");
  const { slug } = useParams<{ slug: string }>();
  const { links, saveLink, unlockLink } = useLocalLinks();
  const { user } = useAuth();
  const { setKeyPair, decryptMetadata, decryptMessage, decryptArchive, progress: decryptPercent } =
    useFileEncryption();

  const [link, setLink] = useState<LinkStatusResponse | null>(null);
  const [linkNotFound, setLinkNotFound] = useState(false);
  // Issue #7: whether the PIN prompt shows is derived (a PIN-protected local
  // key that hasn't been unlocked yet), not set from an effect.
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);
  const [drops, setDrops] = useState<DropSummary[]>([]);
  // Drops this tab has finished downloading, for the owned queue view only.
  // In-memory only: on reload, GET /drops itself no longer lists a
  // downloaded (fileEnvelopeStatus "delivered"/"shredded") drop, so this is
  // just what removes it from the list *within this session*, before the
  // next snapshot/SSE event would otherwise do the same.
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [autoSave, setAutoSave] = useState(() => {
    // Task 9 / F9 (step 2): not routed through useLocalLinks.ts, so it needs
    // its own try/catch — same discipline as that hook's own storage
    // reads/writes. A throw here (private browsing, blocked storage) would
    // otherwise happen during render with no error boundary in place,
    // blank-screening the whole page. Falls back to the same default as an
    // absent key (auto-save on) when storage can't be read at all.
    try {
      return window.localStorage.getItem(AUTO_SAVE_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // C1 (final review): a sender-initiated request link's real claimant is
  // never `link.ownerId` (that's always the initiator who created the
  // request link — see design spec §4.1/§4.2), even after they claim it with
  // `recipientPublicKey: user.publicKey`. So the owner-gated GET /drops below
  // 403s for them despite `mode` reading "owned" (recipientPublicKey does
  // match their account). Once that happens, this flips true and the render
  // logic below falls back to the single-drop claimant view instead of
  // treating the 403 as "link not found" and permanently stranding the drop.
  const [ownedAccessDenied, setOwnedAccessDenied] = useState(false);
  // Public half of the locally stored anonymous key for this slug, once
  // unlocked (below) — the source of this browser's verification phrase in
  // "anonymous" mode.
  const [localPublicKey, setLocalPublicKey] = useState<string | null>(null);

  const stored = slug ? links[slug] : undefined;
  // A stored entry (PIN-protected or not — see useLocalLinks.ts's StoredLink)
  // means this browser holds a usable local key for this slug. Depending on
  // its mere presence, not on `.privateKey` specifically, matters: a
  // PIN-protected entry has no `.privateKey` at all (only `wrapped`+`salt`)
  // until the PIN is submitted below, but this browser still created/claimed
  // that link and must still get the anonymous single-drop view, never
  // "none" or a queue.
  const hasStoredKey = !!stored;
  const pinPrompt = Boolean(stored?.pinProtected) && !pinUnlocked;
  const userPublicKey = user?.publicKey;
  const userKeyPair = user?.keyPair ?? null;

  const mode: PageMode = hasStoredKey
    ? "anonymous"
    : !link
      ? "loading"
      : link.recipientPublicKey === null
        ? "claim"
        : userPublicKey && link.recipientPublicKey === userPublicKey && !link.isAnonymous
          ? "owned"
          : "none";

  // Load key: an unprotected local key loads immediately; a PIN-protected
  // one prompts first.
  useEffect(() => {
    if (!stored) return;
    if (!stored.pinProtected) {
      unlockLink(slug!)
        .then((raw) => {
          const keyPair = nacl.box.keyPair.fromSecretKey(decodeBase64(raw));
          setKeyPair(keyPair);
          setLocalPublicKey(encodeBase64(keyPair.publicKey));
        })
        .catch(() => {
          // I6 (final review): a corrupted/malformed local key (bad storage
          // format, tampering, etc.) must not crash the whole page over it —
          // leave the key pair unset and let the rest of the page render
          // normally, same as any other missing-key state here.
        });
    }
    // A PIN-protected key waits for submitPin below; `pinPrompt` derives that.
  }, [stored, slug, unlockLink, setKeyPair]);

  // SECURITY: only ever set the account key pair once this link is
  // confirmed to be this account's own ("owned") — never unconditionally.
  // `user.keyPair` is only non-null right after a fresh, same-tab
  // login()/register() call (see useAuth.tsx); a session restored from just
  // a cookie (a hard reload) always has `user` truthy but `user.keyPair`
  // null. Setting it here regardless of mode would also let a logged-in
  // user's account key silently clobber a legitimate local anonymous key for
  // a *different* link this same browser created/claimed, the moment
  // `useAuth`'s effect resolves — "anonymous" must keep using the local key
  // it already loaded above, not the account's. The render logic below shows
  // a distinct "please log in again" state when mode is "owned" but
  // `user.keyPair` is null, instead of ever falling back to a substitute key.
  useEffect(() => {
    if (mode === "owned" && userKeyPair) setKeyPair(userKeyPair);
  }, [mode, userKeyPair, setKeyPair]);

  const submitPin = async () => {
    try {
      const raw = await unlockLink(slug!, pinInput);
      const keyPair = nacl.box.keyPair.fromSecretKey(decodeBase64(raw));
      setKeyPair(keyPair);
      setLocalPublicKey(encodeBase64(keyPair.publicKey));
      setPinUnlocked(true);
      setPinError(false);
    } catch {
      setPinError(true);
    }
  };

  // Plain status fetch — this same GET also serves the sender's page, so it
  // has no side effect of its own. It runs regardless of mode: it's the only
  // source of the claim gate (recipientPublicKey === null) and of
  // ownerNote/linkId/codewordLocale, and every mode needs linkNotFound to come from
  // somewhere. Advancing deliveryStatus to receiver_opened is a separate,
  // dedicated action (a shared query param on this GET was spoofable — a
  // sender could pass ?role=receiver on their own request — so it was
  // replaced with this single-purpose endpoint). The endpoint no-ops for an
  // owned link or a link with no drop yet, so it's safe to call
  // unconditionally rather than gating it on the status fetch resolving
  // first, or on mode.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/links/${slug}`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json() as Promise<LinkStatusResponse>;
      })
      .then((data) => {
        if (!cancelled) setLink(data);
      })
      .catch(() => {
        if (!cancelled) setLinkNotFound(true);
      });
    fetch(`/api/links/${slug}/mark-receiver-opened`, { method: "POST" }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Snapshot + live status, ported from the pre-rewrite queue view. The
  // snapshot is (re-)loaded from `onopen`, on every open (the first one and
  // each automatic reconnect), never alongside constructing the
  // EventSource: constructing it doesn't mean the server has subscribed yet,
  // so a snapshot fetched straight away could be answered before the
  // subscription exists and an event emitted in between would reach nobody.
  // The monotonic-status merge (mergeDrops/newerOf above) makes the
  // snapshot's and the stream's relative arrival order irrelevant.
  useEffect(() => {
    if (!slug || (mode !== "anonymous" && mode !== "owned")) return;
    let cancelled = false;
    // Local to this effect run rather than the `ownedAccessDenied` state: once
    // GET /drops 403s once (see the C1 comment on that state), every later
    // snapshot within this same effect instance should go straight to the
    // plain status fetch instead of hitting the owner-gated route again — no
    // need to round-trip through a re-render to know that.
    let deniedOwner = false;
    let pollId: ReturnType<typeof setInterval> | null = null;

    function stopPolling() {
      if (pollId !== null) {
        clearInterval(pollId);
        pollId = null;
      }
    }

    async function loadSnapshot() {
      try {
        if (mode === "owned" && !deniedOwner) {
          const res = await fetch(`/api/links/${slug}/drops`);
          if (cancelled) return;
          if (res.status === 403) {
            // C1 (final review): this "owned" link is actually a
            // sender-initiated request link this account merely claimed —
            // never its real `ownerId` (the initiator). Fall back to the
            // single-drop claimant view below instead of "link not found".
            deniedOwner = true;
            setOwnedAccessDenied(true);
          } else if (!res.ok) {
            setLinkNotFound(true);
            return;
          } else {
            const data = (await res.json()) as ListDropsResponse;
            if (cancelled) return;
            setDrops((prev) => mergeDrops(prev, data.drops));
            return;
          }
        }
        // Anonymous, or an "owned" link whose /drops just came back 403
        // above: both are single-drop claimant views driven by the same
        // plain status fetch (also used by the sender's page).
        const res = await fetch(`/api/links/${slug}`);
        if (cancelled) return;
        if (!res.ok) {
          setLinkNotFound(true);
          return;
        }
        const data = (await res.json()) as LinkStatusResponse;
        if (cancelled) return;
        // Keep ownerNote (and the rest of the link) fresh from the same response the live
        // drop comes from, in addition to the one-off fetch above.
        setLink(data);
        // Fix 3 (docs/STATUS.md gap 3): a claimed sender-initiated link's
        // claimant gets a plural `drops` array here (every currently-
        // outstanding file, not just an arbitrary first one) — merge all of
        // them the same way the owned queue merges its own GET /drops
        // response. Every other link shape (anonymous, or an "owned" link
        // whose /drops call above succeeded, handled in the branch before
        // this one) never has `data.drops`, so this falls back to exactly
        // today's singular-only merge.
        if (data.drops) {
          setDrops((prev) => mergeDrops(prev, data.drops!));
        } else if (data.drop) {
          // Narrowed into a local const: TS doesn't carry the `if (data.drop)`
          // narrowing into the setDrops callback closure below.
          const drop = data.drop;
          setDrops((prev) => mergeDrops(prev, [drop]));
        }
      } catch {
        // Transient network failure — don't strand the recipient on a hard
        // error; the SSE stream (and its re-open snapshot) will catch up.
      }
    }

    const source = new EventSource(`/api/links/${slug}/events`);
    source.onopen = () => {
      // A real connection came back — stop any status-poll fallback that was
      // running while it was down.
      stopPolling();
      loadSnapshot();
    };
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      // I2 (final review): a CLOSED readyState never reconnects on its own
      // (e.g. the events route 403s for a claimed sender-initiated link's
      // real claimant — a known, out-of-scope backend gap). A claimant always
      // claims before the sender sends, so this path is hit on essentially
      // every claim; without a repeating fallback they'd be stuck on
      // "waiting for the file" until a manual reload. Poll the plain status
      // endpoint instead of a one-shot reload.
      loadSnapshot();
      if (pollId === null) {
        pollId = setInterval(loadSnapshot, STATUS_POLL_INTERVAL_MS);
      }
    };
    source.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as DropEvent | { type: string };
        if (parsed.type !== "drop-created" && parsed.type !== "drop-updated") return;
        const drop = (parsed as DropEvent).drop;
        if (!drop?.id) return;
        setDrops((prev) => mergeDrops(prev, [drop]));
      } catch {
        // Ignore malformed events; the next snapshot/event will correct state.
      }
    };

    return () => {
      cancelled = true;
      stopPolling();
      source.close();
    };
  }, [slug, mode]);

  // Review finding F1: this page's verification phrase is derived locally
  // from the private key THIS recipient actually holds — never from the
  // status response's `codewords` field (server-derived from whatever key the
  // DB holds, so a swapped key would produce matching words on both sides):
  // - "anonymous": the public half of this browser's own stored key for this
  //   slug (localPublicKey, set once it's unlocked above).
  // - "owned" (both the owner's queue view and a request link's
  //   account-claimant view, after GET /drops 403s): the public half of the
  //   account key pair unwrapped at login (userKeyPair) — genuinely local
  //   key material, not the server-reported user.publicKey. Both views only
  //   render the phrase when !needsRelogin, i.e. exactly when userKeyPair is
  //   present. In either "owned" case the account IS this link's recipient:
  //   "owned" requires link.recipientPublicKey === user.publicKey, and the
  //   queue view additionally requires GET /drops to have succeeded (true
  //   ownerId only), so it is never a request link's initiator.
  // If the server handed the sender a different key than the one held here,
  // the sender's phrase (derived from that key) won't match this one.
  const codewordPublicKey =
    mode === "anonymous"
      ? localPublicKey
      : mode === "owned" && userKeyPair
        ? encodeBase64(userKeyPair.publicKey)
        : null;
  const codewords = useCodewords(codewordPublicKey, link?.linkId, link?.codewordLocale);
  const codewordsBlock = codewords && (
    <Card aria-labelledby="receive-words-heading">
      <CardContent className="flex flex-col gap-3">
        <h2 id="receive-words-heading" className="text-base leading-6 font-semibold">
          {t("codewordsHeading")}
        </h2>
        <p className="text-muted-foreground">{t("codewordsLabel")}</p>
        <Codewords words={codewords} />
      </CardContent>
    </Card>
  );

  const handleDropDownloaded = useCallback((dropId: string) => {
    setDownloadedIds((prev) => new Set(prev).add(dropId));
  }, []);

  if (linkNotFound) {
    return (
      <PageContainer width="form">
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>{t("errors.linkNotFound")}</AlertDescription>
        </Alert>
      </PageContainer>
    );
  }
  if (!link) {
    return (
      <PageContainer width="narrow" aria-busy="true">
        <p className="sr-only">{t("loading")}</p>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <Skeleton className="mt-4 h-40" />
          <Skeleton className="h-32" />
        </div>
      </PageContainer>
    );
  }

  if (pinPrompt) {
    return (
      <PageContainer width="form">
        <Card>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                submitPin();
              }}
            >
              <div className="flex gap-3">
                <KeyRound aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
                <div className="flex flex-col gap-1">
                  <h1 className="text-base leading-6 font-semibold">{t("unlockTitle")}</h1>
                  <p className="text-muted-foreground">{t("enterPin")}</p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="receive-pin" className="sr-only">
                  {t("unlockTitle")}
                </Label>
                <Input
                  id="receive-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  aria-invalid={pinError || undefined}
                  className="max-w-48 tabular-nums"
                />
              </div>
              {pinError && (
                <Alert variant="destructive">
                  <AlertTriangle aria-hidden="true" />
                  <AlertDescription>{t("wrongPin")}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="self-start">
                {t("unlock")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }

  if (mode === "claim") {
    return <ClaimView slug={slug!} saveLink={saveLink} onClaimed={setLink} t={t} />;
  }

  if (mode === "none") {
    return (
      <PageContainer width="form">
        <Card>
          <CardContent className="flex gap-3">
            <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="flex flex-col gap-1">
              <h1 className="text-base leading-6 font-semibold">{t("noKeyTitle")}</h1>
              <p className="text-muted-foreground">{t("errors.noLocalKey")}</p>
            </div>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }

  // Same server-side rule as GET /drops (which already excludes
  // delivered/shredded drops on the next reload) — plus anything this tab
  // has just finished downloading itself, before the next snapshot/SSE
  // event catches up. Shared by the owned queue view below and the
  // claimed-request-link multi-file claimant view (Fix 3) — both are the
  // same "list of outstanding drops" shape, just fed by different endpoints.
  const queued = drops.filter(
    (drop) =>
      drop.fileEnvelopeStatus !== "delivered" &&
      drop.fileEnvelopeStatus !== "shredded" &&
      !downloadedIds.has(drop.id)
  );

  // Where this view's private key lives — the one fact a recipient must not
  // miss, shown as a badge in the header and (for a browser-held key) a
  // persistent banner: "anonymous" mode means the key is in this browser's
  // localStorage only; every "owned" variant uses the account key.
  const storage: LinkStorage = mode === "anonymous" ? "browser" : "account";
  const header = (title: string, description: string) => (
    <PageHeader title={title} description={description}>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StorageBadge storage={storage} />
        <LifetimeBadge mode={link.mode} />
        {link.expiresAt !== undefined && (
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {t("linkExpiresIn", { time: formatTimeLeft(link.expiresAt) })}
          </span>
        )}
      </div>
    </PageHeader>
  );
  const browserKeyBanner = storage === "browser" && (
    <Alert variant="warning" role="note" data-testid="browser-key-banner" className="mb-6">
      <Monitor aria-hidden="true" />
      <AlertTitle>{t("browserKeyTitle")}</AlertTitle>
      <AlertDescription>{t("browserKeyBody")}</AlertDescription>
    </Alert>
  );
  const reloginAlert = (
    <Alert variant="warning" role="note">
      <KeyRound aria-hidden="true" />
      <AlertDescription className="text-foreground">
        {t("reloginRequired")}{" "}
        <Link to="/login" state={{ returnTo: `/receive/${slug}` }} className="font-medium text-primary-text">
          {t("reloginLink")}
        </Link>
      </AlertDescription>
    </Alert>
  );
  const ownerNoteBlock = link.ownerNote && (
    <Alert variant="info" role="note">
      <Info aria-hidden="true" />
      <AlertTitle>{t("ownerNoteTitle")}</AlertTitle>
      <AlertDescription>
        <p className="whitespace-pre-line text-foreground">{link.ownerNote}</p>
        <span className="text-xs">{t("ownerNoteWarning")}</span>
      </AlertDescription>
    </Alert>
  );
  const waitingState = (
    <EmptyState icon={<Inbox aria-hidden="true" />} title={t("waitingForFile")}>
      <p>{storage === "browser" ? t("waitingHintBrowser") : t("waitingHintAccount")}</p>
    </EmptyState>
  );
  const renderDrop = (drop: DropSummary, extra?: { onAutoSaveChange?: (value: boolean) => void; onDownloaded?: (id: string) => void }) => (
    <DropDetail
      key={drop.id}
      slug={slug!}
      drop={drop}
      decryptMetadata={decryptMetadata}
      decryptMessage={decryptMessage}
      decryptArchive={decryptArchive}
      decryptPercent={decryptPercent}
      autoSave={autoSave}
      onAutoSaveChange={extra?.onAutoSaveChange}
      onDownloaded={extra?.onDownloaded}
      t={t}
    />
  );

  if (mode === "owned" && !ownedAccessDenied) {
    const needsRelogin = !userKeyPair;
    return (
      <PageContainer width="narrow">
        {header(t("queueTitle"), t("queueSubtitle"))}
        <div className="flex flex-col gap-6">
          {needsRelogin && reloginAlert}
          {!needsRelogin && codewordsBlock}
          {!needsRelogin && queued.length === 0 && (
            <EmptyState icon={<Inbox aria-hidden="true" />} title={t("queueEmpty")}>
              <p>{t("waitingHintAccount")}</p>
            </EmptyState>
          )}
          {!needsRelogin && queued.length > 0 && (
            <ul className="flex flex-col gap-4">
              {queued.map((drop) => (
                <li key={drop.id}>{renderDrop(drop, { onDownloaded: handleDropDownloaded })}</li>
              ))}
            </ul>
          )}
        </div>
      </PageContainer>
    );
  }

  // Single-drop / multi-drop claimant view: either a locally-held anonymous
  // key (mode "anonymous"), or an "owned" link whose GET /drops came back 403
  // (a request link's real claimant, using their account key pair instead —
  // see the C1 comment on `ownedAccessDenied` above). Only the latter can
  // ever need a relogin gate here: an "anonymous" local key is always usable
  // the moment it's loaded, so `needsRelogin` is trivially false for it.
  //
  // Fix 3 (docs/STATUS.md gap 3): `link.drops` (plural) is present ONLY for a
  // claimed sender-initiated link's claimant — GET /api/links/:slug never
  // sets it for a plain anonymous one-time link (at most one drop ever) or a
  // normal owned link's recipient (who reads GET .../drops instead). When
  // present, render the same list-of-DropDetail style the owned queue view
  // uses above (reusing `queued`, the same filtered/downloaded-aware list,
  // and the same SSE-driven mergeDrops/newerOf update path — see the
  // snapshot effect above) instead of the legacy single-drop rendering.
  const needsRelogin = mode === "owned" && !userKeyPair;
  const isMultiDrop = link.drops !== undefined;
  const singleDrop: DropSummary | null = drops[0] ?? link.drop ?? null;

  return (
    <PageContainer width="narrow">
      {header(t("title"), storage === "browser" ? t("subtitleBrowser") : t("subtitleAccount"))}
      {browserKeyBanner}
      <div className="flex flex-col gap-6">
        {needsRelogin && reloginAlert}
        {!needsRelogin && (
          <>
            {codewordsBlock}
            {ownerNoteBlock}
            {isMultiDrop ? (
              <>
                {queued.length === 0 && waitingState}
                {queued.length > 0 && (
                  <ul className="flex flex-col gap-4">
                    {queued.map((drop) => (
                      <li key={drop.id}>{renderDrop(drop, { onDownloaded: handleDropDownloaded })}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <>
                {!singleDrop && waitingState}
                {singleDrop &&
                  renderDrop(singleDrop, {
                    onAutoSaveChange: (value) => {
                      setAutoSave(value);
                      // Task 9 / F9 (step 2): same rationale as the useState
                      // initializer above — this write isn't routed through
                      // useLocalLinks.ts either, so it needs its own
                      // try/catch. The toggle still works for this tab
                      // (setAutoSave above already updated it); only the
                      // cross-reload persistence is lost on failure.
                      try {
                        window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, String(value));
                      } catch {
                        // localStorage unavailable — the preference just won't survive a reload.
                      }
                    },
                  })}
              </>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

// Design spec §4.2: claim view, shown when the link has no recipientPublicKey
// yet. Extracted as its own small component since it's a fully separate UI
// state from everything else (no drop, no metadata, no key pair needed to
// render it).
function ClaimView({
  slug,
  saveLink,
  onClaimed,
  t,
}: {
  slug: string;
  saveLink: (slug: string, privateKey: string, expiresAt: number, pin?: string) => Promise<void>;
  onClaimed: (link: LinkStatusResponse) => void;
  t: (key: string) => string;
}) {
  const { user } = useAuth();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const claimAnonymously = async () => {
    setError(null);
    // Task 9 / F9 (step 1, strategy a): the claim below is irreversible
    // (there's no unclaim route) and its whole point is a private key that
    // only survives via saveLink -> useLocalLinks' localStorage write.
    // Awaiting saveLink can't itself surface a storage failure — its actual
    // localStorage.setItem happens later, decoupled, inside useLocalLinks'
    // own useEffect (wrapped in a try/catch with no re-throw) — so probe
    // storage directly first and refuse to claim rather than leave the user
    // with a permanently claimed link whose key exists only in this tab's
    // memory.
    if (!isLocalStorageWritable()) {
      setError(t("errors.storageUnavailable"));
      return;
    }
    const keyPair = nacl.box.keyPair();
    const res = await fetch(`/api/links/${slug}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: encodeBase64(keyPair.publicKey) }),
    });
    if (!res.ok) {
      setError(t("errors.claimFailed"));
      return;
    }
    // Permanent by default (the request-link flow has no fixed expiry) — a
    // far-future expiry keeps useLocalLinks' own pruning from dropping it
    // prematurely.
    await saveLink(slug, encodeBase64(keyPair.secretKey), Date.now() + 365 * 24 * 60 * 60 * 1000, pin || undefined);
    const statusRes = await fetch(`/api/links/${slug}`);
    // No drop exists yet immediately after claiming, so this is a harmless
    // no-op today — called anyway for consistency with the main status-fetch
    // effect, rather than special-casing the claim path.
    fetch(`/api/links/${slug}/mark-receiver-opened`, { method: "POST" }).catch(() => {});
    onClaimed(await statusRes.json());
  };

  const claimWithAccount = async () => {
    // `user.publicKey` (unlike `user.keyPair`) is always present for a
    // logged-in user regardless of whether this tab currently has the
    // account's private key unlocked — claiming only registers the account's
    // already-known public key with the link, it performs no local crypto
    // and needs no secret material. The moment this link becomes "owned",
    // the queue view's own `needsRelogin` gate (ReceivePageForLink) is what
    // decides whether this tab can actually decrypt anything on it yet.
    if (!user?.publicKey) return;
    setError(null);
    const res = await fetch(`/api/links/${slug}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: user.publicKey }),
    });
    if (!res.ok) {
      setError(t("errors.claimFailed"));
      return;
    }
    const statusRes = await fetch(`/api/links/${slug}`);
    fetch(`/api/links/${slug}/mark-receiver-opened`, { method: "POST" }).catch(() => {});
    onClaimed(await statusRes.json());
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("claimTitle")} description={t("claimSubtitle")} />
      <div className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <ChoiceCard
            icon={<UserRound aria-hidden="true" />}
            title={t("claimAccountTitle")}
            badge={<Badge variant="outline">{t("recommended")}</Badge>}
            points={[t("claimAccountPoint1"), t("claimAccountPoint2")]}
          >
            {user ? (
              <Button className="h-11 w-full sm:h-9" onClick={claimWithAccount}>
                {t("claimWithAccount")}
              </Button>
            ) : (
              <Link
                to="/login"
                state={{ returnTo: `/receive/${slug}` }}
                className="inline-flex min-h-11 items-center font-medium text-primary-text hover:text-primary-text hover:underline sm:min-h-0"
              >
                {t("logInToClaimWithAccount")}
              </Link>
            )}
          </ChoiceCard>
          <ChoiceCard
            icon={<Monitor aria-hidden="true" />}
            title={t("claimBrowserTitle")}
            points={[t("claimBrowserPoint1"), t("claimBrowserPoint2")]}
          >
            <p className="text-xs leading-4 text-muted-foreground">{t("anonymousClaimWarning")}</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="claim-pin">
                {t("pinLabel")}
                <span className="font-normal text-muted-foreground">{t("optional")}</span>
              </Label>
              <Input
                id="claim-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder={t("pinPlaceholder")}
                className="max-w-48 tabular-nums"
              />
              <FieldHint>{t("pinWarning")}</FieldHint>
            </div>
            <Button variant="secondary" className="h-11 w-full sm:h-9" onClick={claimAnonymously}>
              {t("claimAnonymously")}
            </Button>
          </ChoiceCard>
        </div>
      </div>
    </PageContainer>
  );
}

function ChoiceCard({
  icon,
  title,
  badge,
  points,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  points: string[];
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-8 items-center justify-center rounded-md bg-accent text-accent-foreground [&_svg]:size-4">
            {icon}
          </span>
          <h2 className="flex-1 text-base leading-6 font-semibold">{title}</h2>
          {badge}
        </div>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <div className="mt-auto flex flex-col gap-3">{children}</div>
      </CardContent>
    </Card>
  );
}

// Task 12 Step 2a: the per-drop metadata-decrypt / message-reveal / download
// UI, shared by both the single-drop anonymous view and the owned queue view
// so the two never duplicate this logic — each queued drop gets its own
// instance (keyed by drop.id by the caller), so its local state (metadata,
// revealed message, download progress) can never mix across drops.
//
// `decryptMetadata`/`decryptMessage`/`decryptArchive` close over whichever
// key pair useFileEncryption currently holds (the caller sets it once for
// the whole page — see ReceivePageForLink); this component never touches key
// material directly, so it has nothing new to get wrong on that front.
function DropDetail({
  slug,
  drop,
  decryptMetadata,
  decryptMessage,
  decryptArchive,
  decryptPercent,
  autoSave,
  onAutoSaveChange,
  onDownloaded,
  t,
}: {
  slug: string;
  drop: DropSummary;
  decryptMetadata: (encryptedMetadata: string, metadataNonce: string, senderPublicKey: string) => Promise<DecryptedMetadata>;
  decryptMessage: (encryptedMessage: string, messageNonce: string, senderPublicKey: string) => Promise<string>;
  decryptArchive: (archiveBytes: Uint8Array, archiveNonce: string, senderPublicKey: string) => Promise<Uint8Array>;
  decryptPercent: number;
  autoSave: boolean;
  // Present only for the single-drop anonymous view, which owns the toggle's
  // checkbox UI; the owned queue view doesn't render a per-item toggle.
  onAutoSaveChange?: (value: boolean) => void;
  // Present only for the owned queue view, so it can drop this item from its
  // list once downloaded (GET /drops itself would also stop listing it on
  // the next fetch, but not before then).
  onDownloaded?: (dropId: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [metadata, setMetadata] = useState<DecryptedMetadata | null>(null);
  const [revealedMessage, setRevealedMessage] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<"alreadyRevealed" | "decryptFailed" | "failed" | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [savedBlobUrl, setSavedBlobUrl] = useState<string | null>(null);

  // Decrypt metadata automatically — no gate (this never counts as a secure
  // envelope "leaving the server"). Re-runs on its own once a key pair
  // becomes available: decryptMetadata's identity changes whenever
  // useFileEncryption's key pair does (see useFileEncryption.ts), so a PIN
  // submitted after this effect's first, failed attempt retries it for free.
  useEffect(() => {
    decryptMetadata(drop.encryptedMetadata, drop.metadataNonce, drop.senderPublicKey)
      .then(setMetadata)
      .catch(() => {});
  }, [drop.encryptedMetadata, drop.metadataNonce, drop.senderPublicKey, decryptMetadata]);

  // I6 (final review): the server permanently deletes the message ciphertext
  // the moment reveal-message succeeds, so a decrypt failure *after* that
  // point means the message is genuinely, permanently gone — not something to
  // silently swallow via an unhandled promise rejection. Distinguishes
  // "someone already revealed this" (404/409 — the drop or its message
  // envelope no longer exists) from a generic server failure, and either of
  // those from a post-success decrypt failure, so the recipient always sees
  // an honest, specific reason instead of nothing happening.
  const revealMessage = async () => {
    setRevealError(null);
    try {
      const res = await fetch(`/api/links/${slug}/drops/${drop.id}/reveal-message`, { method: "POST" });
      if (!res.ok) {
        setRevealError(res.status === 404 || res.status === 409 ? "alreadyRevealed" : "failed");
        return;
      }
      const { encryptedMessage, messageNonce } = (await res.json()) as RevealMessageResponse;
      try {
        const plaintext = await decryptMessage(encryptedMessage, messageNonce, drop.senderPublicKey);
        setRevealedMessage(plaintext);
      } catch {
        setRevealError("decryptFailed");
      }
    } catch {
      setRevealError("failed");
    }
  };

  const download = useCallback(async () => {
    setDownloadFailed(false);
    setDownloadPercent(0);
    try {
      const urlRes = await fetch(`/api/links/${slug}/download-url?dropId=${encodeURIComponent(drop.id)}`);
      if (!urlRes.ok) throw new Error("download-url failed");
      const info = (await urlRes.json()) as DownloadUrlResponse;

      const { bytes, integrityOk } = await downloadWithProgress(info.downloadUrl, info.contentMD5, setDownloadPercent);
      if (!integrityOk) {
        await fetch(`/api/links/${slug}/drops/${drop.id}/download-failed`, { method: "POST" });
        setDownloadFailed(true);
        return;
      }

      const decrypted = await decryptArchive(bytes, info.archiveNonce, info.senderPublicKey);
      await fetch(`/api/links/${slug}/drops/${drop.id}/complete-download`, { method: "POST" });

      const blob = new Blob([decrypted as BlobPart], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      if (autoSave) {
        const a = document.createElement("a");
        a.href = url;
        a.download = "download.zip";
        a.click();
        URL.revokeObjectURL(url);
      } else {
        setSavedBlobUrl(url);
      }
      setDownloaded(true);
      onDownloaded?.(drop.id);
    } catch {
      await fetch(`/api/links/${slug}/drops/${drop.id}/download-failed`, { method: "POST" }).catch(() => {});
      setDownloadFailed(true);
    }
  }, [slug, drop, decryptArchive, autoSave, onDownloaded]);

  const uploading = drop.fileUploadStatus !== "complete";
  const totalSize = metadata?.files.reduce((sum, f) => sum + f.size, 0) ?? 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-base leading-6 font-semibold">
              {metadata ? t("filesCount", { count: metadata.files.length }) : t("deliveryTitle")}
              {metadata && metadata.files.length > 1 && (
                <span className="font-normal text-muted-foreground"> · {formatBytes(totalSize)}</span>
              )}
            </h2>
            <p className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
              <Clock aria-hidden="true" className="size-3.5" />
              {t("contentExpiresAt", { date: formatDateTime(drop.contentExpiresAt) })}
            </p>
          </div>
          {downloaded ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {t("statusDownloaded")}
            </span>
          ) : (
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium ${uploading ? "text-muted-foreground" : "text-info"}`}
            >
              <span aria-hidden="true" className={`size-2 rounded-full ${uploading ? "bg-muted-foreground" : "bg-info"}`} />
              {uploading ? t("statusUploading") : t("statusReady")}
            </span>
          )}
        </div>

        {metadata && (
          <ul className="divide-y rounded-md border">
            {metadata.files.map((f) => (
              <li key={f.name} className="flex items-center gap-3 px-3 py-2">
                <FileIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs font-medium text-muted-foreground tabular-nums">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        )}

        {drop.hasMessage && revealedMessage === null && metadata !== null && (
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2">
            <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-xs leading-4 text-muted-foreground">{t("messageSealedHint")}</span>
            <Button variant="outline" size="sm" className="h-11 sm:h-8" onClick={() => setConfirmReveal(true)}>
              {t("decryptMessageButton")}
            </Button>
          </div>
        )}
        {revealedMessage !== null && (
          <blockquote className="rounded-md border-l-0 bg-muted px-4 py-3 text-base leading-[26px] whitespace-pre-line">
            {revealedMessage}
          </blockquote>
        )}
        {revealError && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertDescription>
              {revealError === "alreadyRevealed"
                ? t("errors.messageAlreadyRevealed")
                : revealError === "decryptFailed"
                  ? t("errors.messageDecryptFailed")
                  : t("errors.revealFailed")}
            </AlertDescription>
          </Alert>
        )}

        {uploading && <p className="text-muted-foreground">{t("waitingForFile")}</p>}
        {(downloadPercent > 0 || decryptPercent > 0) && !downloaded && (
          <div className="flex flex-col gap-3" aria-live="polite">
            <Progress value={downloadPercent}>
              <div className="flex w-full justify-between text-xs font-medium">
                <span>{t("downloading")}</span>
                <span className="text-muted-foreground tabular-nums">{Math.round(downloadPercent)} %</span>
              </div>
            </Progress>
            <Progress value={decryptPercent}>
              <div className="flex w-full justify-between text-xs font-medium">
                <span>{t("decrypting")}</span>
                <span className="text-muted-foreground tabular-nums">{Math.round(decryptPercent)} %</span>
              </div>
            </Progress>
          </div>
        )}
        {downloadFailed && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertDescription>{t("errors.downloadFailed")}</AlertDescription>
          </Alert>
        )}
        {downloaded && (
          <p className="flex items-center gap-2 text-success">
            <CheckCircle2 aria-hidden="true" className="size-4" />
            <span className="text-foreground">{t("downloadedMessage")}</span>
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {onAutoSaveChange ? (
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs sm:min-h-0">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={autoSave}
                onChange={(e) => onAutoSaveChange(e.target.checked)}
              />
              {t("autoSaveToggle")}
            </label>
          ) : (
            <span />
          )}
          {!uploading && !downloaded && !downloadFailed && (
            <Button
              size="lg"
              className="h-12 w-full sm:h-10 sm:w-auto"
              onClick={download}
              disabled={downloadPercent > 0 && downloadPercent < 100}
            >
              <Download aria-hidden="true" />
              {t("downloadButton")}
            </Button>
          )}
          {downloadFailed && (
            <Button size="lg" className="h-12 w-full sm:h-10 sm:w-auto" onClick={download}>
              {t("retryButton")}
            </Button>
          )}
          {downloaded && !autoSave && savedBlobUrl && (
            <Button asChild size="lg" className="h-12 w-full sm:h-10 sm:w-auto">
              <a href={savedBlobUrl} download="download.zip">
                <Download aria-hidden="true" />
                {t("saveFileLink")}
              </a>
            </Button>
          )}
        </div>
      </CardContent>
      <AlertDialog open={confirmReveal} onOpenChange={setConfirmReveal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revealWarningTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("revealWarningBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReveal(false);
                revealMessage();
              }}
            >
              {t("revealConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
