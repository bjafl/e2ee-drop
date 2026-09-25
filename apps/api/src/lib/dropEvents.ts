import { EventEmitter } from "node:events";
import type { DropSummary } from "@e2ee-drop/shared";

export interface DropEvent {
  type: "drop-created" | "drop-updated";
  drop: DropSummary;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function emitDropEvent(linkId: string, event: DropEvent): void {
  emitter.emit(linkId, event);
}

export function subscribeToLink(linkId: string, listener: (event: DropEvent) => void): () => void {
  emitter.on(linkId, listener);
  return () => emitter.off(linkId, listener);
}
