import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { CreateLinkPage } from "./CreateLinkPage";

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

// Deliberately far from the old hardcoded 24h: the operator may configure any
// LINK_EXPIRY_HOURS, and the stored key must live exactly as long as the link.
const SERVER_EXPIRES_AT = Date.now() + 72 * 60 * 60 * 1000;

describe("CreateLinkPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          linkId: "link1",
          slug: "abc123",
          codewords: ["fox", "river", "lamp", "otter"],
          expiresAt: SERVER_EXPIRES_AT,
        }),
      })
    );
  });

  it("does not create a link until the user submits the form", async () => {
    render(<CreateLinkPage />);

    expect(screen.getByRole("button", { name: /create/i })).toBeInTheDocument();
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it("creates a link and shows the shareable URL once the user clicks create", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });
  });

  it("shows only the first few verification codewords until the user asks to see the rest", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/otter/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show all words/i }));

    expect(screen.getByText(/fox.*river.*lamp.*otter/i)).toBeInTheDocument();
  });

  it("links the recipient to their own download page for the new link", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    const link = await screen.findByRole("link", { name: /download page/i });
    expect(link).toHaveAttribute("href", "/download/abc123");
  });

  it("sends the owner note and retention days entered in the form", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.type(screen.getByLabelText(/note for the recipient/i), "For the design team");
    await user.type(screen.getByLabelText(/link expires after/i), "5");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(window.fetch).toHaveBeenCalledWith(
        "/api/links",
        expect.objectContaining({
          body: expect.stringContaining('"ownerNote":"For the design team"'),
        })
      );
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.retentionDays).toBe(5);
  });

  it("keeps the private key in localStorage until the server's expiresAt, not a hardcoded expiry", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("e2ee-drop:links") ?? "{}");
      expect(stored.abc123?.expiresAt).toBe(SERVER_EXPIRES_AT);
    });
  });

  it("PIN-protects the stored key when the user sets a PIN", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.type(screen.getByLabelText(/protect your key with a pin/i), "1234");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("e2ee-drop:links") ?? "{}");
      expect(stored.abc123?.pinProtected).toBe(true);
      expect(stored.abc123?.privateKey).toBeUndefined();
      expect(stored.abc123?.wrapped).toBeDefined();
    });
  });
});
