// apps/web/src/components/ContactsPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "me", publicKey: "x" }, login: vi.fn(), logout: vi.fn(), register: vi.fn() }),
}));

import { ContactsPage } from "./ContactsPage";

describe("ContactsPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pending: [{ id: "c1", userId: "u2", username: "bob", status: "pending", direction: "incoming" }],
          accepted: [{ id: "c2", userId: "u3", username: "carol", status: "accepted", direction: "outgoing" }],
        }),
      })
    );
  });

  it("renders pending and accepted contacts, with a send-file link for accepted ones", async () => {
    render(
      <MemoryRouter>
        <ContactsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("bob")).toBeInTheDocument();
      expect(screen.getByText("carol")).toBeInTheDocument();
    });
    const sendLink = screen.getByRole("link", { name: /send a file/i });
    expect(sendLink).toHaveAttribute("href", "/send/carol");
  });

  it("lets the sender cancel a pending outgoing request", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        pending: [{ id: "c3", userId: "u4", username: "dave", status: "pending", direction: "outgoing" }],
        accepted: [],
      }),
    });

    render(
      <MemoryRouter>
        <ContactsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("dave")).toBeInTheDocument();
    });

    // No accept/reject buttons for an outgoing request, only cancel.
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/contacts/c3/reject", { method: "POST" });
    });
  });
});
