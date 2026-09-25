import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
});
