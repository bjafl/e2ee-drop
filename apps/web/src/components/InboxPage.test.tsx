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
});
