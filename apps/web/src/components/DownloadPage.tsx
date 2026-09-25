// apps/web/src/components/DownloadPage.tsx
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { decodeBase64 } from "tweetnacl-util";
import nacl from "tweetnacl";
import type { DownloadUrlResponse, DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import i18n from "@/i18n";
import downloadEn from "@/locales/en/download.json";
import downloadNb from "@/locales/nb/download.json";

i18n.addResourceBundle("en", "download", downloadEn, true, false);
i18n.addResourceBundle("nb", "download", downloadNb, true, false);

const POLL_INTERVAL_MS = 3000;

// Mirrors the backend's download-url gate (routes/downloads.ts): once the upload
// has finished, a download URL can be (re-)issued for "uploaded", "downloading" and
// "downloaded" alike. Gating on "uploaded" only would strand a recipient who
// reloads, or whose first attempt failed after the status moved to "downloading",
// on the waiting message forever.
function isReadyForDownload(drop: DropSummary | null): drop is DropSummary {
  return drop !== null && drop.status !== "uploading";
}

export function DownloadPage() {
  const { t } = useTranslation("download");
  const { slug } = useParams<{ slug: string }>();
  const { links } = useLocalLinks();
  const { setKeyPair, decryptFile } = useFileEncryption();
  const [drop, setDrop] = useState<DropSummary | null>(null);
  const [codewords, setCodewords] = useState<string[]>([]);
  const [downloaded, setDownloaded] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  // `linkNotFound` is a fatal, page-replacing condition (the link itself
  // doesn't exist / never existed in this browser). `downloadFailed` is a
  // failure during the download/decrypt action, which must NOT tear down
  // the page — the recipient needs to see it and retry the same button.
  // Both are booleans (translated only at render time) rather than stored
  // strings, so that the async effects below don't need `t` in their
  // dependency arrays — including a translation function in an interval
  // effect's deps risks re-running (and re-polling / re-scheduling) the
  // effect if `t`'s identity ever changes across renders.
  const [linkNotFound, setLinkNotFound] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const stored = slug ? links[slug] : undefined;
  // Depend on the primitive key string, not the `stored` object reference:
  // `links` is plain React state, but nothing guarantees a hook consumer
  // (including test doubles) returns referentially-stable objects across
  // renders, and an object identity in a dependency array that churns on
  // every render would re-run these effects — including re-issuing the
  // initial poll() call — after every state update they themselves trigger.
  const storedPrivateKey = stored?.privateKey;

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
    if (!slug || !storedPrivateKey) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/links/${slug}`);
        if (cancelled) return;
        if (!res.ok) {
          // The link itself is gone (expired/never existed) — this is a
          // genuine dead end, so stop polling and surface a fatal error.
          setLinkNotFound(true);
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        const data = (await res.json()) as LinkStatusResponse;
        if (cancelled) return;
        setDrop(data.drop);
        setCodewords(data.codewords ?? []);
        if (isReadyForDownload(data.drop) && pollRef.current) {
          clearInterval(pollRef.current);
        }
      } catch {
        // Transient network failure (offline, DNS blip, etc.) — don't
        // strand the recipient on a hard error; just retry on the next tick.
      }
    }

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [slug, storedPrivateKey]);

  const handleDownload = async () => {
    if (!slug || !drop || isDownloading) return;
    setDownloadFailed(false);
    setIsDownloading(true);
    try {
      const res = await fetch(`/api/links/${slug}/download-url`);
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

      setDownloaded(true);
    } catch {
      setDownloadFailed(true);
    } finally {
      setIsDownloading(false);
    }
  };

  if (!stored) return <p>{t("errors.noLocalKey")}</p>;
  if (linkNotFound) return <p role="alert">{t("errors.linkNotFound")}</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {codewords.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
            <p className="font-mono text-lg">{codewords.slice(0, 3).join(" · ")}</p>
          </div>
        )}
        {downloadFailed && (
          <Alert variant="destructive">
            <AlertDescription>{t("errors.downloadFailed")}</AlertDescription>
          </Alert>
        )}
        {!isReadyForDownload(drop) && !downloaded && <p>{t("waitingForFile")}</p>}
        {isReadyForDownload(drop) && !downloaded && (
          <>
            <p>{drop.fileName}</p>
            {drop.message && <p className="italic">{drop.message}</p>}
            <Button onClick={handleDownload} disabled={isDownloading}>
              {t("downloadButton")}
            </Button>
          </>
        )}
        {downloaded && <p>{t("downloadedMessage")}</p>}
      </CardContent>
    </Card>
  );
}
