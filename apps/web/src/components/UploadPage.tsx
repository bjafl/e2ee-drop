// apps/web/src/components/UploadPage.tsx
import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDropzone } from "react-dropzone";
import nacl from "tweetnacl";
import { X } from "lucide-react";
import type { LinkStatusResponse, RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted) => setFiles((prev) => [...prev, ...accepted]),
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

  if (authLoading) return <p>{t("loading")}</p>;
  if (error && !link) {
    return (
      <Alert variant="destructive" className="mx-auto mt-12 max-w-md">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!link) return <p>{t("loading")}</p>;
  if (done) return <p>{t("success")}</p>;
  if (link.recipientPublicKey === null) {
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardContent className="pt-6">
          <p>{t("waitingForClaim")}</p>
        </CardContent>
      </Card>
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
      <Card className="mx-auto mt-12 max-w-md">
        <CardHeader>
          <CardTitle>{t("reauthRequiredTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("reauthRequiredBody")}</p>
          <Button asChild>
            <Link to="/login" state={{ returnTo: `/send/${slug}` }}>
              {t("reauthRequiredAction")}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const canSend = (message.trim() !== "" || files.length > 0) && !isUploading;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div data-testid="recipient-badge">
          {!link.recipientName ? (
            t("anonymousRecipient")
          ) : (
            <>
              <p>
                {t("recipientNameLabel", { name: link.recipientName })} (@{link.recipientUsername})
              </p>
              <p>{link.recipientEmailVerified ? t("emailVerified") : t("emailUnverified")}</p>
              {link.recipientEmail && <p>{link.recipientEmail}</p>}
              <p>{link.recipientTotpEnabled ? t("totpEnabled") : t("totpDisabled")}</p>
            </>
          )}
        </div>
        {link.ownerNote && (
          <Alert>
            <AlertDescription>
              {link.ownerNote}
              <br />
              <span className="text-xs">{t("ownerNoteWarning")}</span>
            </AlertDescription>
          </Alert>
        )}
        <div>
          <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
          <p className="font-mono text-lg">{link.codewords.slice(0, 3).join(" · ")}</p>
        </div>
        <div>
          <textarea
            value={message}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("messagePlaceholder")}
            className="w-full rounded border p-2 text-sm"
            disabled={isUploading}
          />
          <p className="text-right text-xs text-muted-foreground">
            {message.length}/{MAX_MESSAGE_LENGTH}
          </p>
        </div>
        <div
          {...getRootProps()}
          data-testid="dropzone"
          className={`rounded border-2 border-dashed p-6 text-center text-sm ${isDragActive ? "border-primary" : "border-muted"}`}
        >
          <input {...getInputProps()} data-testid="file-input" />
          {isDragActive ? t("dropActive") : t("dropInstructions")}
        </div>
        {files.length > 0 && (
          <ul className="text-sm">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2">
                <span className="truncate">{f.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("removeFile", { name: f.name })}
                  disabled={isUploading}
                  onClick={() => setFiles((prev) => prev.filter((_, index) => index !== i))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("retentionInfo", { days: link.retentionDays })}</p>
        {isUploading && (
          <div className="space-y-2">
            <Progress value={encryptPercent}>
              <p className="text-xs">{t("encrypting")}</p>
            </Progress>
            <Progress value={uploadPercent}>
              <p className="text-xs">{t("uploading")}</p>
            </Progress>
          </div>
        )}
        <Button onClick={handleSendClick} disabled={!canSend}>
          {t("sendButton")}
        </Button>
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
      </CardContent>
    </Card>
  );
}
