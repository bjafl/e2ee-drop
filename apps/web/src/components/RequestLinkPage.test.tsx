import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { RequestLinkPage } from "./RequestLinkPage";

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

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

  it("I4: also links the initiator to their own send page for the new link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slug: "abc123" }) })
    );
    render(<RequestLinkPage />);
    fireEvent.click(screen.getByRole("button", { name: /create link/i }));

    const link = await screen.findByRole("link", { name: /send page/i });
    expect(link).toHaveAttribute("href", "/send/abc123");
  });

  it("I7: pre-fills the retention field with a default value instead of leaving it blank", () => {
    render(<RequestLinkPage />);
    expect(screen.getByLabelText(/delete received files after/i)).toHaveValue(1);
  });
});
