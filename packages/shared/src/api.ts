// packages/shared/src/api.ts
export type LinkMode = "permanent" | "one-time";
export type LinkVisibility = "public" | "contacts-only";

// Internal upload-transfer bookkeeping (was DropStatus's "uploading"/"uploaded" pair).
export type FileUploadStatus = "uploading" | "complete";

// Display-level status. Only "sender_opened" and "sent" are ever written directly by an
// upload-side handler (plan 2); "receiver_opened", "partial_delivery" and "delivered" are
// written by receive-side handlers (plan 2) — see the design spec §3.1/§6.
export type DeliveryStatus = "sender_opened" | "sent" | "receiver_opened" | "partial_delivery" | "delivered";
export type EnvelopeStatus = "sealed" | "delivery_failed" | "delivered" | "shredded";

export interface CreateLinkRequest {
  recipientPublicKey: string; // base64
  locale?: string;
  ownerNote?: string;
  retentionDays?: number; // validated against env defaults/max — see plan 2 Task on POST /api/links
}

export interface CreateLinkResponse {
  linkId: string;
  slug: string;
  codewords: string[];
  expiresAt?: number;
}

export interface CreateCustomLinkRequest {
  slug: string;
  mode: LinkMode;
  visibility?: LinkVisibility;
  retentionDays?: number;
  ownerNote?: string;
}

// New: sender-initiated "request a drop" flow (design spec §4.1).
export interface CreateRequestLinkRequest {
  ownerNote?: string;
  retentionDays?: number;
}

export interface CreateRequestLinkResponse {
  slug: string;
}

// New: recipient claims an unclaimed (sender-initiated) link (design spec §4.2).
export interface ClaimLinkRequest {
  recipientPublicKey: string; // base64
}

export interface DropSummary {
  id: string;
  fileUploadStatus: FileUploadStatus;
  deliveryStatus: DeliveryStatus;
  messageEnvelopeStatus: EnvelopeStatus;
  fileEnvelopeStatus: EnvelopeStatus;
  senderPublicKey: string; // base64
  archiveNonce: string; // base64
  contentMD5: string; // base64
  encryptedMetadata: string; // base64 ciphertext
  metadataNonce: string; // base64
  hasMessage: boolean; // true iff encryptedMessage is still present (not yet revealed)
  contentExpiresAt: number; // epoch ms — createdAt + link.retentionDays, computed server-side
}

export interface ListDropsResponse {
  drops: DropSummary[];
}

export interface LinkStatusResponse {
  slug: string;
  mode: LinkMode;
  recipientPublicKey: string | null; // null => unclaimed, see design spec §4.2
  drop: DropSummary | null;
  // Every currently-outstanding (not yet delivered/shredded) drop for this
  // link, oldest first — populated ONLY for a claimed sender-initiated
  // (request) link's non-owner claimant (docs/STATUS.md gap 3): that link is
  // `mode: "permanent"` and can receive more than one file over its
  // lifetime, unlike a one-time anonymous link (at most one drop ever) or a
  // normal owned link's recipient (who reads their queue from the
  // owner-gated GET .../drops instead). `drop` above still mirrors `drops[0]`
  // for backward compatibility; other link shapes never set this field.
  drops?: DropSummary[];
  isAnonymous: boolean;
  codewords: string[];
  ownerNote?: string;
  retentionDays: number;
  expiresAt?: number; // epoch ms, mirrors CreateLinkResponse's field for an already-created link
  recipientName?: string;
  recipientUsername?: string;
  recipientEmail?: string; // present only when design spec §6.4's visibility rule allows it
  recipientEmailVerified?: boolean;
  recipientTotpEnabled?: boolean;
  recipientAllowContactRequests?: boolean;
}

export interface LinkSummary {
  slug: string;
  mode: LinkMode;
  visibility: LinkVisibility;
  isDefault: boolean;
  createdAt: number; // epoch ms
  expiresAt?: number; // epoch ms, omitted for permanent links
  revokedAt?: number; // epoch ms, omitted if not revoked
  lastSenderOpenedAt?: number; // epoch ms, omitted if never opened by a sender
  retentionDays: number;
}

export interface ListLinksResponse {
  links: LinkSummary[];
}

export interface InboxDrop {
  id: string;
  linkSlug: string;
  deliveryStatus: "sender_opened" | "sent" | "receiver_opened" | "partial_delivery" | "delivered";
  messageEnvelopeStatus: "sealed" | "delivery_failed" | "delivered" | "shredded";
  fileEnvelopeStatus: "sealed" | "delivery_failed" | "delivered" | "shredded";
  hasMessage: boolean;
  createdAt: number; // epoch ms
}

export interface InboxCounterparty {
  // Stable within one response; "account:<userId>" or "anon:<senderPublicKey>".
  // Never persisted or reused as a lookup key server-side beyond this response.
  key: string;
  kind: "account" | "anonymous";
  displayName: string; // username for "account", "Anonym1"/"Anonym2"/... for "anonymous"
  direction: "incoming" | "outgoing";
  drops: InboxDrop[];
}

export interface InboxResponse {
  counterparties: InboxCounterparty[];
}

// Body for POST /api/links/:slug/upload-url. Replaces the old flat "message"/"metadata" shape —
// all three envelopes are now independently-nonced ciphertext (design spec §3.1/§5).
export interface RequestUploadUrlRequest {
  senderPublicKey: string; // base64
  archiveNonce: string; // base64 — the file archive's own nonce, generated client-side before the PUT
  encryptedMessage?: string; // base64 ciphertext, omitted iff no message
  messageNonce?: string; // base64, required iff encryptedMessage is present
  encryptedMetadata: string; // base64 ciphertext of { files: [{name, size}], mimeType } JSON
  metadataNonce: string; // base64
  metadata: {
    fileSize: number; // cleartext — quota checks need this before any decryption is possible
    contentMD5: string; // base64, nacl.hash over the archive ciphertext
  };
}

export interface RequestUploadUrlResponse {
  dropId: string;
  uploadUrl: string;
}

export interface DownloadUrlResponse {
  downloadUrl: string;
  archiveNonce: string; // base64
  senderPublicKey: string; // base64
  contentMD5: string; // base64
}

// New: POST /api/links/:slug/drops/:dropId/reveal-message response (design spec §6.2).
export interface RevealMessageResponse {
  encryptedMessage: string; // base64 ciphertext
  messageNonce: string; // base64
}

export interface ApiErrorResponse {
  error: string;
}
