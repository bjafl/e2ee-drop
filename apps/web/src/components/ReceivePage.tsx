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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
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
import { useFileEncryption, type DecryptedMetadata } from "@/hooks/useFileEncryption";
import { downloadWithProgress } from "@/hooks/useStreamedDownload";
import { useAuth } from "@/hooks/useAuth";
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
  const [pinPrompt, setPinPrompt] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);
  const [drops, setDrops] = useState<DropSummary[]>([]);
  // Drops this tab has finished downloading, for the owned queue view only.
  // In-memory only: on reload, GET /drops itself no longer lists a
  // downloaded (fileEnvelopeStatus "delivered"/"shredded") drop, so this is
  // just what removes it from the list *within this session*, before the
  // next snapshot/SSE event would otherwise do the same.
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [autoSave, setAutoSave] = useState(
    () => window.localStorage.getItem(AUTO_SAVE_STORAGE_KEY) !== "false"
  );
  // C1 (final review): a sender-initiated request link's real claimant is
  // never `link.ownerId` (that's always the initiator who created the
  // request link — see design spec §4.1/§4.2), even after they claim it with
  // `recipientPublicKey: user.publicKey`. So the owner-gated GET /drops below
  // 403s for them despite `mode` reading "owned" (recipientPublicKey does
  // match their account). Once that happens, this flips true and the render
  // logic below falls back to the single-drop claimant view instead of
  // treating the 403 as "link not found" and permanently stranding the drop.
  const [ownedAccessDenied, setOwnedAccessDenied] = useState(false);

  const stored = slug ? links[slug] : undefined;
  // A stored entry (PIN-protected or not — see useLocalLinks.ts's StoredLink)
  // means this browser holds a usable local key for this slug. Depending on
  // its mere presence, not on `.privateKey` specifically, matters: a
  // PIN-protected entry has no `.privateKey` at all (only `wrapped`+`salt`)
  // until the PIN is submitted below, but this browser still created/claimed
  // that link and must still get the anonymous single-drop view, never
  // "none" or a queue.
  const hasStoredKey = !!stored;
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
        .then((raw) => setKeyPair(nacl.box.keyPair.fromSecretKey(decodeBase64(raw))))
        .catch(() => {
          // I6 (final review): a corrupted/malformed local key (bad storage
          // format, tampering, etc.) must not crash the whole page over it —
          // leave the key pair unset and let the rest of the page render
          // normally, same as any other missing-key state here.
        });
    } else {
      setPinPrompt(true);
    }
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
      setKeyPair(nacl.box.keyPair.fromSecretKey(decodeBase64(raw)));
      setPinPrompt(false);
      setPinError(false);
    } catch {
      setPinError(true);
    }
  };

  // Plain status fetch — this same GET also serves the sender's page, so it
  // has no side effect of its own. It runs regardless of mode: it's the only
  // source of the claim gate (recipientPublicKey === null) and of
  // ownerNote/codewords, and every mode needs linkNotFound to come from
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
        // Keep ownerNote/codewords fresh from the same response the live
        // drop comes from, in addition to the one-off fetch above.
        setLink(data);
        // Narrowed into a local const: TS doesn't carry the `if (data.drop)`
        // narrowing into the setDrops callback closure below.
        const drop = data.drop;
        if (drop) setDrops((prev) => mergeDrops(prev, [drop]));
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

  const handleDropDownloaded = useCallback((dropId: string) => {
    setDownloadedIds((prev) => new Set(prev).add(dropId));
  }, []);

  if (linkNotFound) return <p role="alert">{t("errors.linkNotFound")}</p>;
  if (!link) return <p>{t("loading")}</p>;

  if (pinPrompt) {
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardContent className="space-y-4 pt-6">
          <p>{t("enterPin")}</p>
          <input
            type="password"
            inputMode="numeric"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            className="w-full rounded border p-2 text-sm"
          />
          {pinError && (
            <Alert variant="destructive">
              <AlertDescription>{t("wrongPin")}</AlertDescription>
            </Alert>
          )}
          <Button onClick={submitPin}>{t("unlock")}</Button>
        </CardContent>
      </Card>
    );
  }

  if (mode === "claim") {
    return <ClaimView slug={slug!} saveLink={saveLink} onClaimed={setLink} t={t} />;
  }

  if (mode === "none") return <p>{t("errors.noLocalKey")}</p>;

  if (mode === "owned" && !ownedAccessDenied) {
    const needsRelogin = !userKeyPair;
    // Same server-side rule as GET /drops (which already excludes
    // delivered/shredded drops on the next reload) — plus anything this tab
    // has just finished downloading itself, before the next snapshot/SSE
    // event catches up.
    const queued = drops.filter(
      (drop) =>
        drop.fileEnvelopeStatus !== "delivered" &&
        drop.fileEnvelopeStatus !== "shredded" &&
        !downloadedIds.has(drop.id)
    );
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardHeader>
          <CardTitle>{t("queueTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {needsRelogin && (
            <Alert>
              <AlertDescription>
                {t("reloginRequired")}{" "}
                <Link to="/login" state={{ returnTo: `/receive/${slug}` }}>
                  {t("reloginLink")}
                </Link>
              </AlertDescription>
            </Alert>
          )}
          {!needsRelogin && queued.length === 0 && <p>{t("queueEmpty")}</p>}
          {!needsRelogin &&
            queued.map((drop) => (
              <div key={drop.id} className="space-y-2 border-b pb-4 last:border-0">
                <DropDetail
                  slug={slug!}
                  drop={drop}
                  decryptMetadata={decryptMetadata}
                  decryptMessage={decryptMessage}
                  decryptArchive={decryptArchive}
                  decryptPercent={decryptPercent}
                  autoSave={autoSave}
                  onDownloaded={handleDropDownloaded}
                  t={t}
                />
              </div>
            ))}
        </CardContent>
      </Card>
    );
  }

  // Single-drop claimant view: either a locally-held anonymous key (mode
  // "anonymous"), or an "owned" link whose GET /drops came back 403 (a
  // request link's real claimant, using their account key pair instead — see
  // the C1 comment on `ownedAccessDenied` above). Only the latter can ever
  // need a relogin gate here: an "anonymous" local key is always usable the
  // moment it's loaded, so `needsRelogin` is trivially false for it.
  const needsRelogin = mode === "owned" && !userKeyPair;
  const drop: DropSummary | null = drops[0] ?? link.drop ?? null;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {needsRelogin && (
          <Alert>
            <AlertDescription>
              {t("reloginRequired")}{" "}
              <Link to="/login" state={{ returnTo: `/receive/${slug}` }}>
                {t("reloginLink")}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {!needsRelogin && (
          <>
            {link.codewords.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
                <p className="font-mono text-lg">{link.codewords.join(" · ")}</p>
              </div>
            )}
            {link.ownerNote && (
              <Alert>
                <AlertDescription>
                  {link.ownerNote}
                  <br />
                  <span className="text-xs">{t("ownerNoteWarning")}</span>
                </AlertDescription>
              </Alert>
            )}
            {!drop && <p>{t("waitingForFile")}</p>}
            {drop && (
              <DropDetail
                slug={slug!}
                drop={drop}
                decryptMetadata={decryptMetadata}
                decryptMessage={decryptMessage}
                decryptArchive={decryptArchive}
                decryptPercent={decryptPercent}
                autoSave={autoSave}
                onAutoSaveChange={(value) => {
                  setAutoSave(value);
                  window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, String(value));
                }}
                t={t}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
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
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("claimTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {user ? (
          <Button onClick={claimWithAccount}>{t("claimWithAccount")}</Button>
        ) : (
          <p className="text-sm">
            <Link to="/login" state={{ returnTo: `/receive/${slug}` }} className="underline">
              {t("logInToClaimWithAccount")}
            </Link>
          </p>
        )}
        <div className="space-y-2 border-t pt-4">
          <Alert>
            <AlertDescription>{t("anonymousClaimWarning")}</AlertDescription>
          </Alert>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t("pinPlaceholder")}
            className="w-full rounded border p-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("pinWarning")}</p>
          <Button variant="secondary" onClick={claimAnonymously}>
            {t("claimAnonymously")}
          </Button>
        </div>
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

  return (
    <>
      {metadata && (
        <ul className="text-sm">
          {metadata.files.map((f) => (
            <li key={f.name}>
              {f.name} — {f.size} {t("bytes")}
            </li>
          ))}
        </ul>
      )}
      {drop.hasMessage && revealedMessage === null && metadata !== null && (
        <Button variant="secondary" onClick={() => setConfirmReveal(true)}>
          {t("decryptMessageButton")}
        </Button>
      )}
      {revealedMessage !== null && <p className="italic">{revealedMessage}</p>}
      {revealError && (
        <Alert variant="destructive">
          <AlertDescription>
            {revealError === "alreadyRevealed"
              ? t("errors.messageAlreadyRevealed")
              : revealError === "decryptFailed"
                ? t("errors.messageDecryptFailed")
                : t("errors.revealFailed")}
          </AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        {t("contentExpiresAt", { date: new Date(drop.contentExpiresAt).toLocaleString() })}
      </p>
      {drop.fileUploadStatus !== "complete" && <p>{t("waitingForFile")}</p>}
      {drop.fileUploadStatus === "complete" && !downloaded && !downloadFailed && (
        <Button onClick={download} disabled={downloadPercent > 0 && downloadPercent < 100}>
          {t("downloadButton")}
        </Button>
      )}
      {downloadFailed && (
        <>
          <Alert variant="destructive">
            <AlertDescription>{t("errors.downloadFailed")}</AlertDescription>
          </Alert>
          <Button onClick={download}>{t("retryButton")}</Button>
        </>
      )}
      {(downloadPercent > 0 || decryptPercent > 0) && !downloaded && (
        <div className="space-y-2">
          <Progress value={downloadPercent}>
            <p className="text-xs">{t("downloading")}</p>
          </Progress>
          <Progress value={decryptPercent}>
            <p className="text-xs">{t("decrypting")}</p>
          </Progress>
        </div>
      )}
      {downloaded && !autoSave && savedBlobUrl && (
        <a href={savedBlobUrl} download="download.zip" className="underline">
          {t("saveFileLink")}
        </a>
      )}
      {downloaded && <p>{t("downloadedMessage")}</p>}
      {onAutoSaveChange && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={autoSave} onChange={(e) => onAutoSaveChange(e.target.checked)} />
          {t("autoSaveToggle")}
        </label>
      )}
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
    </>
  );
}
