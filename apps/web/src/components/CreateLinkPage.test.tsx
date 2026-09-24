import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CreateLinkPage } from "./CreateLinkPage";

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
});
