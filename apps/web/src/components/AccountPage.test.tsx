// apps/web/src/components/AccountPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const logout = vi.fn();
const authState: {
  user: { id: string; username: string; email: string } | null;
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
});
