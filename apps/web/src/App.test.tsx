import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

vi.mock("@/hooks/useAuth", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    useAuth: () => ({ user: { id: "u1", username: "me", publicKey: "x" }, login: vi.fn(), logout: vi.fn(), register: vi.fn() }),
  };
});

describe("App routing", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pending: [],
          accepted: [],
        }),
      })
    );
  });

  it("renders the home page at /", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByText(/end-to-end encrypted file drops/i)).toBeInTheDocument();
  });

  it("renders the contacts page at /contacts", () => {
    render(
      <MemoryRouter initialEntries={["/contacts"]}>
        <App />
      </MemoryRouter>
    );
    // Use a more specific query to avoid multiple "Contacts" headings
    expect(screen.getByPlaceholderText("Username to add")).toBeInTheDocument();
  });

  it("renders the account page at /account", () => {
    render(
      <MemoryRouter initialEntries={["/account"]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByText(/signed in as me/i)).toBeInTheDocument();
  });
});
