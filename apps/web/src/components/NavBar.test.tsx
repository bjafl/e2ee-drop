// apps/web/src/components/NavBar.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const logout = vi.fn();
const authState: { user: { id: string; username: string } | null } = { user: null };

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, loading: false, login: vi.fn(), logout, register: vi.fn() }),
}));

import { NavBar } from "./NavBar";

describe("NavBar", () => {
  beforeEach(() => {
    logout.mockReset();
    logout.mockResolvedValue(undefined);
    authState.user = null;
  });

  it("shows login/register and hides contacts/account when logged out", () => {
    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /log in/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /register/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /contacts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^account$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /log out/i })).not.toBeInTheDocument();
  });

  it("shows contacts/new link/account/logout and hides login/register when logged in", () => {
    authState.user = { id: "u1", username: "alice" };

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /contacts/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new link/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^account$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log out/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /log in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^register$/i })).not.toBeInTheDocument();
  });

  it("calls logout when the logout button is clicked", async () => {
    authState.user = { id: "u1", username: "alice" };

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    expect(logout).toHaveBeenCalledTimes(1);
  });
});
