import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
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

  it("creates a link and shows the shareable URL", async () => {
    render(<CreateLinkPage />);

    await waitFor(() => {
      expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });
  });

  it("shows every verification codeword the server returned, not just the first few", async () => {
    render(<CreateLinkPage />);

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp.*otter/i)).toBeInTheDocument();
    });
  });

  it("links the recipient to their own download page for the new link", async () => {
    render(<CreateLinkPage />);

    const link = await screen.findByRole("link", { name: /download page/i });
    expect(link).toHaveAttribute("href", "/download/abc123");
  });

  it("keeps the private key in localStorage until the server's expiresAt, not a hardcoded expiry", async () => {
    render(<CreateLinkPage />);

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("e2ee-drop:links") ?? "{}");
      expect(stored.abc123?.expiresAt).toBe(SERVER_EXPIRES_AT);
    });
  });
});
