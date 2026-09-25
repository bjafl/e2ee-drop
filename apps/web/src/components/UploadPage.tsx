// apps/web/src/components/UploadPage.tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import nacl from "tweetnacl";
import type {
  LinkStatusResponse,
  RequestUploadUrlRequest,
  RequestUploadUrlResponse,
} from "@e2ee-drop/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import i18n from "@/i18n";
import uploadEn from "@/locales/en/upload.json";
import uploadNb from "@/locales/nb/upload.json";

i18n.addResourceBundle("en", "upload", uploadEn, true, false);
i18n.addResourceBundle("nb", "upload", uploadNb, true, false);

const MAX_MESSAGE_LENGTH = 500;

export function UploadPage() {
  const { t } = useTranslation("upload");
  const { slug } = useParams<{ slug: string }>();
  const [link, setLink] = useState<LinkStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const { setKeyPair, encryptFile } = useFileEncryption();

  useEffect(() => {
    setKeyPair(nacl.box.keyPair());
  }, [setKeyPair]);

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

  const handleFile = async (file: File) => {
    if (!link || !slug || isUploading) return;
    setError(null);
    setIsUploading(true);
    try {
      const encrypted = await encryptFile(file, link.recipientPublicKey);
      const requestBody: RequestUploadUrlRequest = {
        senderPublicKey: encrypted.senderPublicKey,
        message: message || undefined,
        metadata: {
          fileName: encrypted.fileName,
          fileSize: encrypted.fileSize,
          nonce: encrypted.nonce,
          mimeType: encrypted.mimeType,
          contentMD5: encrypted.contentMD5,
        },
      };
      const uploadUrlRes = await fetch(`/api/links/${slug}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!uploadUrlRes.ok) throw new Error("upload-url failed");
      const { dropId, uploadUrl } = (await uploadUrlRes.json()) as RequestUploadUrlResponse;

      const putRes = await fetch(uploadUrl, { method: "PUT", body: encrypted.encrypted });
      if (!putRes.ok) throw new Error("upload failed");

      const completeRes = await fetch(`/api/links/${slug}/drops/${dropId}/complete`, {
        method: "POST",
      });
      if (!completeRes.ok) throw new Error("complete failed");
      setDone(true);
    } catch {
      setError(t("errors.uploadFailed"));
    } finally {
      setIsUploading(false);
    }
  };

  // A failure while fetching the link itself leaves us with nothing to show
  // a form for, so that's a genuine dead end. A failure during the upload
  // chain (handleFile) happens once `link` is already loaded and valid, so
  // it must NOT replace the form — the sender needs to be able to see the
  // error and simply pick a file again to retry.
  if (error && !link) {
    return (
      <Alert variant="destructive" className="mx-auto mt-12 max-w-md">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!link) return <p>{t("loading")}</p>;
  if (done) return <p>{t("success")}</p>;

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
          {link.isAnonymous ? t("anonymousRecipient") : t("verifiedRecipient")}
        </div>
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
          />
          <p className="text-right text-xs text-muted-foreground">
            {message.length}/{MAX_MESSAGE_LENGTH}
          </p>
        </div>
        <Alert variant="destructive">
          <AlertDescription>{t("messageNotEncryptedWarning")}</AlertDescription>
        </Alert>
        <input
          type="file"
          data-testid="file-input"
          disabled={isUploading}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </CardContent>
    </Card>
  );
}
