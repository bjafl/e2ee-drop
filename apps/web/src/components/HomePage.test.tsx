import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const authState: { user: { id: string; username: string } | null } = { user: null };
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, loading: false, login: vi.fn(), logout: vi.fn(), register: vi.fn() }),
}));

import { HomePage } from "./HomePage";

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
}

describe("HomePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    authState.user = null;
  });

  it("lists this browser's unexpired links so the recipient can get back to their download page", () => {
    const now = Date.now();
    window.localStorage.setItem(
      "e2ee-drop:links",
      JSON.stringify({
        abc123: { privateKey: "c2VjcmV0", createdAt: now, expiresAt: now + 60_000 },
        old999: { privateKey: "c2VjcmV0", createdAt: now - 120_000, expiresAt: now - 60_000 },
      })
    );

    renderHome();

    expect(screen.getByRole("link", { name: /abc123/ })).toHaveAttribute("href", "/download/abc123");
    expect(screen.queryByText(/old999/)).not.toBeInTheDocument();
  });

  it("shows no link list when this browser has no stored links", () => {
    renderHome();

    expect(screen.queryByText(/your links/i)).not.toBeInTheDocument();
  });

  it("shows a link to the account page when logged in", () => {
    authState.user = { id: "u1", username: "alice" };

    renderHome();

    expect(screen.getByRole("link", { name: /my account/i })).toHaveAttribute("href", "/account");
  });

  it("shows no account link when logged out", () => {
    renderHome();

    expect(screen.queryByRole("link", { name: /my account/i })).not.toBeInTheDocument();
  });
});
