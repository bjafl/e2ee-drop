// packages/shared/src/api.ts
export type LinkMode = "permanent" | "one-time";
export type LinkVisibility = "public" | "contacts-only";
export type DropStatus = "uploading" | "uploaded" | "downloading" | "downloaded";

export interface CreateLinkRequest {
  recipientPublicKey: string; // base64
  locale?: string; // "en" | "nb" — UI language of the link creator, fixes the codeword wordlist for this link
}

export interface CreateLinkResponse {
  linkId: string;
  slug: string;
  codewords: string[]; // returned immediately so the creator doesn't need a second round-trip to see their phrase
}

export interface DropSummary {
  id: string;
  status: DropStatus;
  senderPublicKey: string; // base64
  nonce: string; // base64
  fileName: string;
  fileSize: number;
  mimeType: string;
  contentMD5: string; // base64
  message: string | null;
}

export interface LinkStatusResponse {
  slug: string;
  mode: LinkMode;
  recipientPublicKey: string; // base64
  drop: DropSummary | null;
  isAnonymous: boolean;
  codewords: string[]; // deterministic verification phrase, up to CODEWORD_MAX_COUNT words, in the link's fixed locale
}

export interface RequestUploadUrlRequest {
  senderPublicKey: string; // base64
  message?: string;
  metadata: {
    fileName: string;
    fileSize: number;
    nonce: string; // base64
    mimeType: string;
    contentMD5: string; // base64
  };
}

export interface RequestUploadUrlResponse {
  dropId: string;
  uploadUrl: string;
}

export interface DownloadUrlResponse {
  downloadUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  nonce: string; // base64
  senderPublicKey: string; // base64
  contentMD5: string; // base64
}

export interface ApiErrorResponse {
  error: string;
}
