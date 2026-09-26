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

export function emitDropEvent(linkId: string, event: DropEvent): void {
  emitter.emit(linkId, event);
}

export function subscribeToLink(linkId: string, listener: (event: DropEvent) => void): () => void {
  emitter.on(linkId, listener);
  return () => emitter.off(linkId, listener);
}

// Number of live subscribers for a link — lets tests (and any future
// diagnostics) verify SSE connections unsubscribe on close instead of leaking.
export function linkListenerCount(linkId: string): number {
  return emitter.listenerCount(linkId);
}
