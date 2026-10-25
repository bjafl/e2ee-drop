import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { InboxPage } from "./InboxPage";

// Drop cards link to /receive/:slug with a router <Link> (a full page load would
// drop the in-memory account key), so the page needs a router context.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  url: string;
  constructor(url: string) {
    this.url = url;
  }
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

  it("links an incoming, not-yet-delivered drop to its receive page", async () => {
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
              drops: [{ id: "d1", linkSlug: "myslug", deliveryStatus: "sent", messageEnvelopeStatus: "sealed", fileEnvelopeStatus: "sealed", hasMessage: false, createdAt: 1 }],
            },
          ],
        }),
      })
    );

    render(<InboxPage />);
    (await screen.findByText("friend1")).click();

    const link = await screen.findByRole("link", { name: /open and download/i });
    expect(link).toHaveAttribute("href", "/receive/myslug");
  });
});
