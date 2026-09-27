import { EventEmitter } from "node:events";
import type { DropSummary } from "@e2ee-drop/shared";

export type DropEvent =
  | { type: "drop-created"; drop: DropSummary }
  | { type: "drop-updated"; drop: DropSummary }
  // Design spec §4.2: emitted by POST /api/links/:slug/claim once the CAS that
  // sets Link.recipientPublicKey wins, so /send/:slug's SSE subscriber (the
  // sender-initiated flow's initiator, who is the only one authorized to
  // subscribe — GET /api/links/:slug/events is owner-gated) can detect the
  // claim without polling. No `drop` field: nothing drop-shaped happened.
  | { type: "link-claimed"; recipientPublicKey: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function linkKey(linkId: string): string {
  return `link:${linkId}`;
}

function ownerKey(ownerId: string): string {
  return `owner:${ownerId}`;
}

export function emitDropEvent(linkId: string, event: DropEvent): void {
  emitter.emit(linkKey(linkId), event);
}

export function subscribeToLink(linkId: string, listener: (event: DropEvent) => void): () => void {
  emitter.on(linkKey(linkId), listener);
  return () => emitter.off(linkKey(linkId), listener);
}

// Number of live subscribers for a link — lets tests (and any future
// diagnostics) verify SSE connections unsubscribe on close instead of leaking.
export function linkListenerCount(linkId: string): number {
  return emitter.listenerCount(linkKey(linkId));
}

// NEW — see Task 2 of the dashboard/inbox implementation plan. Callers that
// transition a Drop's status on an OWNED link should call this alongside the
// existing emitDropEvent(linkId, ...), passing link.ownerId, so subscribers
// to GET /api/inbox/events see it. Never call this for an anonymous link
// (ownerId === null) — there is no owner channel to notify.
export function emitOwnerDropEvent(ownerId: string, event: DropEvent): void {
  emitter.emit(ownerKey(ownerId), event);
}

export function subscribeToOwner(ownerId: string, listener: (event: DropEvent) => void): () => void {
  emitter.on(ownerKey(ownerId), listener);
  return () => emitter.off(ownerKey(ownerId), listener);
}

export function ownerListenerCount(ownerId: string): number {
  return emitter.listenerCount(ownerKey(ownerId));
}
