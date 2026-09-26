import { describe, it, expect, vi } from "vitest";
import { emitDropEvent, subscribeToLink } from "./dropEvents";
import type { DropSummary } from "@e2ee-drop/shared";

const drop: DropSummary = {
  id: "drop1",
  fileUploadStatus: "complete",
  deliveryStatus: "sent",
  messageEnvelopeStatus: "sealed",
  fileEnvelopeStatus: "sealed",
  senderPublicKey: "x",
  archiveNonce: "x",
  contentMD5: "x",
  encryptedMetadata: "x",
  metadataNonce: "x",
  hasMessage: false,
  contentExpiresAt: 0,
};

describe("dropEvents", () => {
  it("delivers an emitted event only to subscribers of the same linkId", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubA = subscribeToLink("link-a", listenerA);
    const unsubB = subscribeToLink("link-b", listenerB);

    emitDropEvent("link-a", { type: "drop-created", drop });

    expect(listenerA).toHaveBeenCalledWith({ type: "drop-created", drop });
    expect(listenerB).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it("stops delivering events after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLink("link-c", listener);
    unsubscribe();

    emitDropEvent("link-c", { type: "drop-updated", drop });

    expect(listener).not.toHaveBeenCalled();
  });
});
