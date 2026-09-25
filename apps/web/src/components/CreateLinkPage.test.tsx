import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { CreateLinkPage } from "./CreateLinkPage";

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("CreateLinkPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ linkId: "link1", slug: "abc123", codewords: ["fox", "river", "lamp"] }),
      })
    );
  });

  it("creates a link and shows the shareable URL", async () => {
    render(<CreateLinkPage />);

    await waitFor(() => {
      expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });
  });

  it("shows the verification codewords", async () => {
    render(<CreateLinkPage />);

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    });
  });

  it("links the recipient to their own download page for the new link", async () => {
    render(<CreateLinkPage />);

    const link = await screen.findByRole("link", { name: /download page/i });
    expect(link).toHaveAttribute("href", "/download/abc123");
  });
});
