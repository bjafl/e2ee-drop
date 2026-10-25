// apps/web/src/components/NavBar.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const logout = vi.fn();
const authState: {
  user: { id: string; username: string; emailVerified?: boolean } | null;
} = { user: null };

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

  it("marks the current route's nav link as the active page", () => {
    authState.user = { id: "u1", username: "alice", emailVerified: true };

    render(
      <MemoryRouter initialEntries={["/inbox"]}>
        <NavBar />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /^inbox$/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^overview$/i })).not.toHaveAttribute("aria-current");
  });

  it("opens the mobile menu sheet with navigation and log out", async () => {
    authState.user = { id: "u1", username: "alice", emailVerified: true };

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent(/account and security/i);
    expect(sheet).toHaveTextContent(/log out/i);
  });

  it("shows contacts/new link/account/logout and hides login/register when logged in", async () => {
    authState.user = { id: "u1", username: "alice" };

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /contacts/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new link/i })).toBeInTheDocument();
    // Account and Log out live in the account menu (a disclosure) since the redesign.
    await userEvent.click(screen.getByRole("button", { name: /account menu for alice/i }));
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

    await userEvent.click(screen.getByRole("button", { name: /account menu for alice/i }));
    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe("NavBar email verification banner", () => {
  beforeEach(() => {
    authState.user = null;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sent: true, emailDeliveryAvailable: true }),
    }) as unknown as typeof fetch;
  });

  it("shows no banner when the user is verified", () => {
    authState.user = { id: "u1", username: "erin", emailVerified: true };

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    expect(screen.queryByTestId("verify-email-banner")).toBeNull();
  });

  it("shows a persistent banner with a resend button when unverified", () => {
    authState.user = { id: "u1", username: "erin", emailVerified: false };

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    expect(screen.getByTestId("verify-email-banner")).toBeInTheDocument();
  });

  it("resend calls the API and starts a cooldown", async () => {
    authState.user = { id: "u1", username: "erin", emailVerified: false };

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    const button = screen.getByTestId("resend-verification-button");
    fireEvent.click(button);

    expect(global.fetch).toHaveBeenCalledWith("/api/auth/verify-email/resend", { method: "POST" });
    await waitFor(() => expect(button).toBeDisabled());
  });

  it("shows an unavailable message and does not start the cooldown when the server has no mailer configured", async () => {
    authState.user = { id: "u1", username: "erin", emailVerified: false };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sent: true, emailDeliveryAvailable: false }),
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    const button = screen.getByTestId("resend-verification-button");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("resend-message")).toBeInTheDocument());
    expect(screen.getByTestId("resend-message")).toHaveTextContent(/not configured/i);
    // No point rate-limiting a client that can never succeed.
    expect(button).not.toBeDisabled();
  });

  it("shows a failure message and does not misleadingly imply success on a non-ok response", async () => {
    authState.user = { id: "u1", username: "erin", emailVerified: false };
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    const button = screen.getByTestId("resend-verification-button");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("resend-message")).toBeInTheDocument());
    expect(screen.getByTestId("resend-message")).toHaveTextContent(/could not resend/i);
    expect(button).not.toBeDisabled();
  });

  it("on a 429, shows a message but still shows the cooldown since the user is presently rate-limited", async () => {
    authState.user = { id: "u1", username: "erin", emailVerified: false };
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many requests" }),
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );

    const button = screen.getByTestId("resend-verification-button");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("resend-message")).toBeInTheDocument());
    await waitFor(() => expect(button).toBeDisabled());
  });
});
