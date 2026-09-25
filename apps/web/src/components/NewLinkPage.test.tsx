import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewLinkPage } from "./NewLinkPage";

describe("NewLinkPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ linkId: "l1", slug: "team-drop" }) })
    );
  });

  it("submits the form and shows the created link", async () => {
    render(<NewLinkPage />);

    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(screen.getByText(/team-drop/)).toBeInTheDocument();
    });
  });
});
