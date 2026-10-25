// apps/web/src/components/UploadPage.tsx
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDropzone } from "react-dropzone";
import nacl from "tweetnacl";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  File as FileIcon,
  Info,
  Lock,
  Upload,
  UserPlus,
  X,
} from "lucide-react";
import type { LinkStatusResponse, RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label, FieldHint } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Codewords } from "@/components/common/Codewords";
import { PageContainer, PageHeader } from "@/components/common/Page";
import { formatBytes } from "@/lib/format";
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
import { Progress } from "@/components/ui/progress";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import { uploadWithProgress } from "@/hooks/useXhrUpload";
import { useAuth } from "@/hooks/useAuth";
import { useCodewords } from "@/hooks/useCodewords";
import i18n from "@/i18n";
import uploadEn from "@/locales/en/upload.json";
import uploadNb from "@/locales/nb/upload.json";

i18n.addResourceBundle("en", "upload", uploadEn, true, false);
i18n.addResourceBundle("nb", "upload", uploadNb, true, false);

const MAX_MESSAGE_LENGTH = 500;

export function UploadPage() {
  const { t } = useTranslation("upload");
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [link, setLink] = useState<LinkStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [showConsent, setShowConsent] = useState(false);
  // The sender must confirm, out of band, that the recipient sees the same
  // verification words before the send button unlocks (only while words are
  // shown — see `needsWordsConfirmation` below).
  const [wordsConfirmed, setWordsConfirmed] = useState(false);
  const { setKeyPair, encryptForSend, progress: encryptPercent } = useFileEncryption();

  useEffect(() => {
    // SECURITY: `user.keyPair` is only ever non-null right after a fresh, same-tab
    // login()/register() call — a session restored from just a cookie (e.g. a hard
    // reload, or navigating here directly from a bookmark) always has `user` truthy
    // but `user.keyPair` null, because the private key is never sent to or cached by
    // the server in usable form (see useAuth.tsx). The server's session cookie is
    // sent regardless of what we do here, so if we silently fell back to a random
    // keypair in that combination, `assertSenderIdentity` on the backend would see
    // the account's real public key from the DB, compare it against the random key
    // we just claimed, and reject the upload as a sender-identity mismatch — for
    // every logged-in user who reloads this page. So: only ever set a keyPair here
    // when we know it's genuinely correct — the user's real one (fresh login) or a
    // fresh anonymous one (no user at all). The remaining case (user truthy,
    // keyPair null) intentionally leaves the encryption hook's keyPair unset; the
    // render logic below shows a distinct "please log in again" state for it
    // instead of the send form, so that state can never reach doSend().
    if (user?.keyPair) {
      setKeyPair(user.keyPair);
    } else if (!user) {
      setKeyPair(nacl.box.keyPair());
    }
  }, [setKeyPair, user]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/links/${slug}`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json() as Promise<LinkStatusResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setLink(data);
      })
      .catch(() => {
        if (!cancelled) setError(t("errors.linkNotFound"));
      });
    // Fire-and-forget send-side "opened" telemetry signal (Task 5 of the
    // delivery-lifecycle-retention plan) — deliberately uncoupled from the GET
    // above: it must not gate or block rendering of the link status, so its
    // result (success or failure) is intentionally never inspected here.
    fetch(`/api/links/${slug}/mark-sender-opened`, { method: "POST" }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, t]);

  // I3 (final review): design spec §4.2's "waiting for the recipient to
  // activate this link" state must detect the claim itself, over the same
  // per-link SSE channel ReceivePage uses — not require a manual reload. The
  // sender/initiator of a sender-initiated request link is always its
  // `ownerId`, so (unlike the receiver's own events subscription — see I2)
  // this route never 403s for them.
  const isWaitingForClaim = !!link && link.recipientPublicKey === null;
  useEffect(() => {
    if (!slug || !isWaitingForClaim) return;
    let cancelled = false;
    const source = new EventSource(`/api/links/${slug}/events`);
    source.onmessage = (event: MessageEvent) => {
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(event.data) as { type?: string };
      } catch {
        return;
      }
      if (parsed.type !== "link-claimed") return;
      fetch(`/api/links/${slug}`)
        .then((res) => (res.ok ? (res.json() as Promise<LinkStatusResponse>) : null))
        .then((data) => {
          if (!cancelled && data) setLink(data);
        })
        .catch(() => {
          // Transient network failure — the sender is still shown the
          // waiting state and can reload; nothing to strand them on here.
        });
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [slug, isWaitingForClaim]);

  // Review finding F1: derived locally from `link.recipientPublicKey` — the
  // exact same state value doSend() below passes to encryptForSend — never
  // from the response's `codewords` field. If the server hands this sender a
  // key the recipient doesn't actually hold, the phrase shown here is derived
  // from THAT key and won't match what the recipient derives from their own.
  // Shows every one of the shared CODEWORD_WORD_COUNT words, the same count
  // every recipient-side surface shows.
  const codewords = useCodewords(link?.recipientPublicKey, link?.linkId, link?.codewordLocale);

  // Issue #4: the server's MAX_FILE_SIZE_BYTES caps the whole encrypted archive
  // (all files zipped into one upload), not each file. Check the running total
  // as files are added so an oversize selection is refused immediately instead
  // of after a long encrypt. Advisory only — the upload-url route still 413s.
  // An older API without maxFileSizeBytes simply skips this check.
  const maxBytes = link?.maxFileSizeBytes;
  const [sizeError, setSizeError] = useState<string | null>(null);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  const handleDrop = useCallback(
    (accepted: File[]) => {
      if (!maxBytes) {
        setSizeError(null);
        setFiles((prev) => [...prev, ...accepted]);
        return;
      }
      let running = files.reduce((sum, f) => sum + f.size, 0);
      const added: File[] = [];
      const rejected: File[] = [];
      for (const file of accepted) {
        if (running + file.size <= maxBytes) {
          added.push(file);
          running += file.size;
        } else {
          rejected.push(file);
        }
      }
      setFiles((prev) => [...prev, ...added]);
      setSizeError(
        rejected.length === 0
          ? null
          : t("errors.tooLarge", {
              count: rejected.length,
              names: rejected.map((f) => f.name).join(", "),
              max: formatBytes(maxBytes),
            })
      );
    },
    [files, maxBytes, t]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleDrop,
    disabled: isUploading,
  });

  const doSend = useCallback(async () => {
    if (!link?.recipientPublicKey || !slug || isUploading) return;
    setError(null);
    setIsUploading(true);
    setUploadPercent(0);
    let dropId: string | undefined;
    try {
      const fileData = await Promise.all(
        files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))
      );
      const envelopes = await encryptForSend(fileData, message || null, link.recipientPublicKey);

      const requestBody: RequestUploadUrlRequest = {
        senderPublicKey: envelopes.senderPublicKey,
        archiveNonce: envelopes.archiveNonce,
        encryptedMessage: envelopes.encryptedMessage ?? undefined,
        messageNonce: envelopes.messageNonce ?? undefined,
        encryptedMetadata: envelopes.encryptedMetadata,
        metadataNonce: envelopes.metadataNonce,
        metadata: { fileSize: envelopes.fileSize, contentMD5: envelopes.contentMD5 },
      };
      const uploadUrlRes = await fetch(`/api/links/${slug}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!uploadUrlRes.ok) throw new Error("upload-url failed");
      const { dropId: newDropId, uploadUrl } = (await uploadUrlRes.json()) as RequestUploadUrlResponse;
      dropId = newDropId;

      try {
        await uploadWithProgress(uploadUrl, envelopes.archiveBlob, setUploadPercent);
      } catch (uploadErr) {
        // Design spec §5.1: an interrupted PUT abandons the whole attempt rather than leaving a
        // stale reservation — a retry starts fully fresh (new encryption, new upload-url call).
        await fetch(`/api/links/${slug}/drops/${dropId}/abandon`, { method: "POST" }).catch(() => {});
        throw uploadErr;
      }

      const completeRes = await fetch(`/api/links/${slug}/drops/${dropId}/complete`, { method: "POST" });
      if (!completeRes.ok) throw new Error("complete failed");
      setDone(true);
    } catch {
      setError(t("errors.uploadFailed"));
    } finally {
      setIsUploading(false);
    }
  }, [link, slug, isUploading, files, message, encryptForSend, t]);

  const handleSendClick = () => {
    if (!user) {
      setShowConsent(true);
      return;
    }
    doSend();
  };

  if (authLoading || (!link && !error)) {
    return (
      <PageContainer aria-busy="true">
        <p className="sr-only">{t("loading")}</p>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Skeleton className="h-72" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </PageContainer>
    );
  }
  if (error && !link) {
    return (
      <PageContainer width="form">
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </PageContainer>
    );
  }
  if (!link) return null;

  const recipientDisplay = link.recipientName ?? null;

  if (done) {
    return (
      <PageContainer width="narrow">
        <Card role="status">
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-brand-tint text-success">
              <CheckCircle2 aria-hidden="true" className="size-6" />
            </span>
            <h1 className="text-xl leading-7 font-semibold tracking-[-0.01em]">{t("success")}</h1>
            <p className="max-w-md text-muted-foreground">
              {recipientDisplay ? t("successBodyNamed", { name: recipientDisplay }) : t("successBody")}
            </p>
            <p className="text-xs text-muted-foreground">{t("retentionInfo", { days: link.retentionDays })}</p>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }
  if (link.recipientPublicKey === null) {
    return (
      <PageContainer width="narrow">
        <Card>
          <CardContent className="flex gap-3">
            <Clock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-info" />
            <div className="flex flex-col gap-1">
              <h1 className="text-base leading-6 font-semibold">{t("waitingForClaimTitle")}</h1>
              <p className="text-muted-foreground">{t("waitingForClaim")}</p>
              <p className="mt-1 inline-flex items-center gap-2 text-xs font-medium text-info">
                <span aria-hidden="true" className="size-2 rounded-full bg-info" />
                {t("waitingLive")}
              </p>
            </div>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }
  if (user && !user.keyPair) {
    // Signed in, but this browser tab doesn't currently have the account's
    // private key unlocked (see the SECURITY comment above the keyPair effect).
    // We deliberately do not render the normal send form here: doing so would
    // require either silently generating a throwaway key (which the server's
    // still-active session cookie would then flag as a sender-identity
    // mismatch) or silently claiming the account's real identity without the
    // key to back it up. Re-authenticating is the only way to genuinely send
    // as this account from this tab.
    return (
      <PageContainer width="form">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock aria-hidden="true" className="size-4 text-warning" />
              {t("reauthRequiredTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">{t("reauthRequiredBody")}</p>
            <Button asChild>
              <Link to="/login" state={{ returnTo: `/send/${slug}` }}>
                {t("reauthRequiredAction")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }

  const needsWordsConfirmation = !!codewords && !wordsConfirmed;
  const hasContent = message.trim() !== "" || files.length > 0;
  const canSend = hasContent && !isUploading && !needsWordsConfirmation;
  const sendLabel =
    files.length === 0 ? t("sendMessageButton") : t("sendFilesButton", { count: files.length });

  return (
    <PageContainer>
      <PageHeader
        title={recipientDisplay ? t("titleNamed", { name: recipientDisplay }) : t("title")}
        description={t("subtitle")}
      />

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        {/* Recipient panel first in DOM so phones see who they're sending to
            before the form; on desktop it moves to the right column. */}
        <aside aria-label={t("recipientHeading")} className="flex flex-col gap-4 lg:col-start-2 lg:row-start-1">
          <Card data-testid="recipient-badge">
            <CardContent className="flex flex-col gap-4">
              {!link.recipientName ? (
                <div className="flex gap-3">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="flex flex-col gap-1">
                    <p className="font-semibold">{t("anonymousRecipientTitle")}</p>
                    <p className="text-muted-foreground">{t("anonymousRecipient")}</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-tint font-semibold"
                    >
                      {initials(link.recipientName)}
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-semibold">{link.recipientName}</span>
                      <span className="truncate font-mono text-[13px] leading-5 text-muted-foreground">
                        @{link.recipientUsername}
                      </span>
                    </div>
                  </div>
                  <FieldHint>{t("recipientNameNote")}</FieldHint>
                  <ul className="flex flex-col gap-2">
                    <TrustRow ok>{t("verifiedRecipient")}</TrustRow>
                    <TrustRow ok={!!link.recipientEmailVerified}>
                      {link.recipientEmailVerified ? t("emailVerified") : t("emailUnverified")}
                    </TrustRow>
                    {link.recipientEmail && (
                      <li className="flex items-center gap-2 pl-6 font-mono text-[13px] leading-5 break-all text-muted-foreground">
                        {link.recipientEmail}
                      </li>
                    )}
                    <TrustRow ok={!!link.recipientTotpEnabled}>
                      {link.recipientTotpEnabled ? t("totpEnabled") : t("totpDisabled")}
                    </TrustRow>
                  </ul>
                  <Button
                    variant="secondary"
                    className="h-11 sm:h-9"
                    // Spec §5: the connect action requires the *viewer* (not just the
                    // link's owner) to be authenticated — an anonymous sender must see
                    // the same disabled treatment as when the owner disallows requests,
                    // never a button that fires an unauthenticated POST the backend
                    // would 401 on.
                    disabled={!link.recipientAllowContactRequests || !user}
                    onClick={() =>
                      fetch("/api/contacts", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ username: link.recipientUsername }),
                      })
                    }
                  >
                    <UserPlus aria-hidden="true" />
                    {t("connectButton")}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {link.ownerNote && (
            <Alert variant="info" role="note">
              <Info aria-hidden="true" />
              <AlertTitle>{t("ownerNoteTitle")}</AlertTitle>
              <AlertDescription>
                <p className="text-foreground whitespace-pre-line">{link.ownerNote}</p>
                <span className="text-xs">{t("ownerNoteWarning")}</span>
              </AlertDescription>
            </Alert>
          )}

          <p className="flex gap-2 text-xs leading-4 text-muted-foreground">
            <Clock aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            {t("retentionInfo", { days: link.retentionDays })}
          </p>
        </aside>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-1">
          {error && (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {codewords && (
            <Card aria-labelledby="verify-words-heading">
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="verify-words-heading" className="text-base leading-6 font-semibold">
                    {t("codewordsHeading")}
                  </h2>
                  {wordsConfirmed && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                      <Check aria-hidden="true" className="size-3.5" />
                      {t("codewordsConfirmedBadge")}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground">{t("codewordsLabel")}</p>
                <Codewords words={codewords} />
                <label className="flex min-h-11 cursor-pointer items-center gap-3 font-medium">
                  <input
                    type="checkbox"
                    data-testid="codewords-confirm"
                    className="size-5 shrink-0 accent-primary sm:size-4"
                    checked={wordsConfirmed}
                    disabled={isUploading}
                    onChange={(e) => setWordsConfirmed(e.target.checked)}
                  />
                  {t("codewordsConfirm")}
                </label>
              </CardContent>
            </Card>
          )}

          <Card aria-labelledby="content-heading">
            <CardContent className="flex flex-col gap-4">
              <h2 id="content-heading" className="text-base leading-6 font-semibold">
                {t("contentHeading")}
              </h2>

              <div
                {...getRootProps()}
                data-testid="dropzone"
                className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors duration-150 ${
                  isDragActive ? "border-primary bg-accent" : "border-input bg-background hover:border-primary hover:bg-accent"
                } ${isUploading ? "pointer-events-none opacity-50" : ""}`}
              >
                <input {...getInputProps()} data-testid="file-input" />
                <span className="inline-flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
                  <Upload aria-hidden="true" className="size-5" />
                </span>
                <span className="font-medium">{isDragActive ? t("dropActive") : t("dropInstructions")}</span>
                <span className="text-xs text-muted-foreground">
                  {maxBytes ? t("dropHintWithMax", { max: formatBytes(maxBytes) }) : t("dropHint")}
                </span>
              </div>

              {sizeError && (
                <p role="alert" data-testid="size-error" className="flex items-start gap-2 text-sm text-destructive">
                  <X aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {sizeError}
                </p>
              )}

              {files.length > 0 && (
                <ul aria-label={t("selectedFiles")} className="divide-y rounded-md border">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-3 py-1 pr-1 pl-3">
                      <FileIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="text-xs font-medium text-muted-foreground tabular-nums">
                        {formatBytes(f.size)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 text-muted-foreground sm:size-8"
                        aria-label={t("removeFile", { name: f.name })}
                        disabled={isUploading}
                        onClick={() => {
                          setSizeError(null);
                          setFiles((prev) => prev.filter((_, index) => index !== i));
                        }}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                  {files.length > 1 && (
                    <li className="flex items-center justify-between gap-3 py-2 pr-3 pl-3 text-xs font-medium text-muted-foreground">
                      <span>{t("totalSize")}</span>
                      <span className="tabular-nums" data-testid="total-size">
                        {maxBytes
                          ? t("totalOfMax", { total: formatBytes(totalBytes), max: formatBytes(maxBytes) })
                          : formatBytes(totalBytes)}
                      </span>
                    </li>
                  )}
                </ul>
              )}

              <div className="flex flex-col gap-2">
                <Label htmlFor="send-message">
                  {t("messageLabel")}
                  <span className="font-normal text-muted-foreground">{t("messageLabelHint")}</span>
                </Label>
                <Textarea
                  id="send-message"
                  rows={3}
                  value={message}
                  maxLength={MAX_MESSAGE_LENGTH}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t("messagePlaceholder")}
                  disabled={isUploading}
                />
                <span className="self-end text-xs text-muted-foreground tabular-nums">
                  {message.length} / {MAX_MESSAGE_LENGTH}
                </span>
              </div>

              {isUploading && (
                <div className="flex flex-col gap-3" aria-live="polite">
                  <Progress value={encryptPercent}>
                    <div className="flex w-full justify-between text-xs font-medium">
                      <span>{t("encrypting")}</span>
                      <span className="text-muted-foreground tabular-nums">{Math.round(encryptPercent)} %</span>
                    </div>
                  </Progress>
                  <Progress value={uploadPercent}>
                    <div className="flex w-full justify-between text-xs font-medium">
                      <span>{t("uploading")}</span>
                      <span className="text-muted-foreground tabular-nums">{Math.round(uploadPercent)} %</span>
                    </div>
                  </Progress>
                </div>
              )}

              <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-4 text-muted-foreground">
                  {user ? (
                    t("sendingAs", { name: user.username ?? "" })
                  ) : (
                    <>
                      {t("sendingAnonymously")}{" "}
                      <Link to="/login" state={{ returnTo: `/send/${slug}` }} className="font-medium text-primary-text">
                        {t("logInToSendAsYou")}
                      </Link>
                    </>
                  )}
                </p>
                <Button size="lg" className="h-12 w-full sm:h-10 sm:w-auto" onClick={handleSendClick} disabled={!canSend}>
                  <Lock aria-hidden="true" />
                  {sendLabel}
                </Button>
              </div>
              {needsWordsConfirmation && hasContent && (
                <p className="text-xs text-muted-foreground sm:text-right">{t("confirmWordsFirst")}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog open={showConsent} onOpenChange={setShowConsent}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("anonymousConsentTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("anonymousConsentBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              render={<Button variant="secondary" />}
              onClick={() => {
                setShowConsent(false);
                navigate("/login", { state: { returnTo: `/send/${slug}` } });
              }}
            >
              {t("logInInstead")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowConsent(false);
                doSend();
              }}
            >
              {t("continueAnonymously")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

// One recipient-trust fact: an icon plus the word, never colour alone.
function TrustRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? (
        <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
      ) : (
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warning" />
      )}
      {children}
    </li>
  );
}
