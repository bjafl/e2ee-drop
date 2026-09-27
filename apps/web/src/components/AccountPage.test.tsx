// apps/web/src/components/AccountPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const logout = vi.fn();
const authState: {
  user: { id: string; username: string; email: string; allowContactRequests?: boolean } | null;
  loading: boolean;
} = { user: null, loading: false };

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, loading: authState.loading, login: vi.fn(), logout, register: vi.fn() }),
}));

// The dialog itself is covered by DeleteAccountDialog.test.tsx; here it's a
// stub that exposes its onDeleted prop as a button so the page's wiring can
// be exercised directly.
vi.mock("@/components/DeleteAccountDialog", () => ({
  DeleteAccountDialog: ({ onDeleted }: { onDeleted: () => void }) => (
    <button data-testid="delete-account-dialog" onClick={onDeleted}>
      stub delete
    </button>
  ),
}));

import { AccountPage } from "./AccountPage";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<p>home page</p>} />
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/account" element={<AccountPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AccountPage", () => {
  beforeEach(() => {
    logout.mockReset();
    logout.mockResolvedValue(undefined);
    authState.user = null;
    authState.loading = false;
  });

  it("redirects to /login when logged out", () => {
    renderAt("/account");

    expect(screen.getByText("login page")).toBeInTheDocument();
    expect(screen.queryByTestId("delete-account-dialog")).not.toBeInTheDocument();
  });

  it("does not redirect while the session is still being restored", () => {
    authState.loading = true;

    renderAt("/account");

    expect(screen.queryByText("login page")).not.toBeInTheDocument();
  });

  // Finding 4 (final review): a `useState(user?.allowContactRequests ??
  // true)` seed only reads its value once, at mount, and so could freeze on
  // the default `true` and never self-correct once the real, `false` value
  // arrived. The full async-resolution sequence (loading -> /me resolves)
  // is exercised end to end in AccountPage.integration.test.tsx, which uses
  // the real AuthProvider; this mocked-useAuth harness can only mount
  // directly with the final value already set, which still covers the
  // regression (the checkbox must never default to checked).
  it("renders the checkbox unchecked when allowContactRequests is false on mount", () => {
    authState.user = { id: "u1", username: "alice", email: "alice@example.com", allowContactRequests: false };

    renderAt("/account");

    expect(screen.getByLabelText(/allow contact requests/i)).not.toBeChecked();
  });

  it("shows the user and mounts the delete-account dialog when logged in", () => {
    authState.user = { id: "u1", username: "alice", email: "alice@example.com" };

    renderAt("/account");

    expect(screen.getByText(/signed in as alice/i)).toBeInTheDocument();
    expect(screen.getByText(/alice@example\.com/)).toBeInTheDocument();
    expect(screen.getByTestId("delete-account-dialog")).toBeInTheDocument();
  });

  // This mock's logout() never clears `user`, so it can't catch the
  // "guard redirects to /login first" regression — that end-to-end behavior
  // is covered with the real AuthProvider in AccountPage.integration.test.tsx.
  it("calls logout once the account is deleted", async () => {
    authState.user = { id: "u1", username: "alice", email: "alice@example.com" };

    renderAt("/account");
    await userEvent.click(screen.getByTestId("delete-account-dialog"));

    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1);
    });
  });

  it("toggles allowContactRequests and PATCHes the change to the server", async () => {
    authState.user = { id: "u1", username: "alice", email: "alice@example.com", allowContactRequests: true };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ updated: true }) });

    renderAt("/account");
    const toggle = screen.getByLabelText(/allow contact requests/i);
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);

    expect(toggle).not.toBeChecked();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/account",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ allowContactRequests: false }),
        })
      );
    });
  });

  it("rolls the toggle back if the PATCH request fails", async () => {
    authState.user = { id: "u1", username: "alice", email: "alice@example.com", allowContactRequests: true };
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "nope" }) });

    renderAt("/account");
    const toggle = screen.getByLabelText(/allow contact requests/i);

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
  });
});
