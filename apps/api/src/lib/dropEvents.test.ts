import { describe, it, expect, vi } from "vitest";
import { emitDropEvent, subscribeToLink, emitOwnerDropEvent, subscribeToOwner } from "./dropEvents";
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

describe("owner-keyed channel", () => {
  it("delivers an owner-emitted event only to subscribers of the same ownerId", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubA = subscribeToOwner("owner-a", listenerA);
    const unsubB = subscribeToOwner("owner-b", listenerB);

    emitOwnerDropEvent("owner-a", { type: "drop-created", drop });

    expect(listenerA).toHaveBeenCalledWith({ type: "drop-created", drop });
    expect(listenerB).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it("stops delivering events after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToOwner("owner-c", listener);
    unsubscribe();

    emitOwnerDropEvent("owner-c", { type: "drop-updated", drop });

    expect(listener).not.toHaveBeenCalled();
  });

  it("uses a namespaced key so an ownerId can never collide with a linkId", () => {
    const linkListener = vi.fn();
    const ownerListener = vi.fn();
    const unsubLink = subscribeToLink("shared-id", linkListener);
    const unsubOwner = subscribeToOwner("shared-id", ownerListener);

    emitDropEvent("shared-id", { type: "drop-created", drop });

    expect(linkListener).toHaveBeenCalledWith({ type: "drop-created", drop });
    expect(ownerListener).not.toHaveBeenCalled();

    unsubLink();
    unsubOwner();
  });
});
