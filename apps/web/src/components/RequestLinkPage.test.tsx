import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RequestLinkPage } from "./RequestLinkPage";

describe("RequestLinkPage", () => {
  it("submits and shows the resulting receive link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slug: "abc123" }) })
    );
    render(<RequestLinkPage />);
    fireEvent.click(screen.getByRole("button", { name: /create link/i }));
    await waitFor(() => expect(screen.getByText(/abc123/)).toBeInTheDocument());
  });

  it("shows an error message when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<RequestLinkPage />);
    fireEvent.click(screen.getByRole("button", { name: /create link/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
