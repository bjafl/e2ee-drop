import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { InboxPage } from "./InboxPage";

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}

describe("InboxPage", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("lists counterparties returned by GET /api/inbox", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          counterparties: [
            { key: "account:1", kind: "account", displayName: "friend1", direction: "incoming", drops: [] },
            { key: "anon:xyz", kind: "anonymous", displayName: "Anonym1", direction: "incoming", drops: [] },
          ],
        }),
      })
    );

    render(<InboxPage />);

    await waitFor(() => expect(screen.getByText("friend1")).toBeInTheDocument());
    expect(screen.getByText("Anonym1")).toBeInTheDocument();
  });

  it("shows a counterparty's drop queue when clicked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          counterparties: [
            {
              key: "account:1",
              kind: "account",
              displayName: "friend1",
              direction: "incoming",
              drops: [{ id: "d1", linkSlug: "myslug", deliveryStatus: "sent", messageEnvelopeStatus: "sealed", fileEnvelopeStatus: "sealed", hasMessage: false, createdAt: 1 }],
            },
          ],
        }),
      })
    );

    render(<InboxPage />);
    const entry = await screen.findByText("friend1");
    entry.click();

    await waitFor(() => expect(screen.getByText("myslug")).toBeInTheDocument());
  });

  it("keeps incoming and outgoing entries for the same person independently selectable even though they share a displayName", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          counterparties: [
            {
              key: "incoming:account:1",
              kind: "account",
              displayName: "friend1",
              direction: "incoming",
              drops: [{ id: "d-in", linkSlug: "in-slug", deliveryStatus: "sent", messageEnvelopeStatus: "sealed", fileEnvelopeStatus: "sealed", hasMessage: false, createdAt: 1 }],
            },
            {
              key: "outgoing:account:1",
              kind: "account",
              displayName: "friend1",
              direction: "outgoing",
              drops: [{ id: "d-out", linkSlug: "out-slug", deliveryStatus: "sent", messageEnvelopeStatus: "sealed", fileEnvelopeStatus: "sealed", hasMessage: false, createdAt: 1 }],
            },
          ],
        }),
      })
    );

    render(<InboxPage />);
    const entries = await screen.findAllByText("friend1");
    expect(entries).toHaveLength(2);

    entries[0].click();
    await waitFor(() => expect(screen.getByText("in-slug")).toBeInTheDocument());

    entries[1].click();
    await waitFor(() => expect(screen.getByText("out-slug")).toBeInTheDocument());
    expect(screen.queryByText("in-slug")).not.toBeInTheDocument();
  });

  it("shows the sender-perspective status label for an outgoing drop, not the recipient-perspective one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          counterparties: [
            {
              key: "outgoing:account:1",
              kind: "account",
              displayName: "friend1",
              direction: "outgoing",
              drops: [{ id: "d1", linkSlug: "myslug", deliveryStatus: "receiver_opened", messageEnvelopeStatus: "sealed", fileEnvelopeStatus: "sealed", hasMessage: false, createdAt: 1 }],
            },
          ],
        }),
      })
    );

    render(<InboxPage />);
    const entry = await screen.findByText("friend1");
    entry.click();

    await waitFor(() => expect(screen.getByText("Opened by recipient")).toBeInTheDocument());
    expect(screen.queryByText("You've opened this")).not.toBeInTheDocument();
  });
});
