// apps/web/src/components/AccountPage.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const logout = vi.fn();
const authState: {
  user: {
    id: string;
    username: string;
    email: string;
    name?: string;
    emailVerified?: boolean;
    publicKey?: string;
    totpEnabled?: boolean;
    keyPair?: null;
  } | null;
  loading: boolean;
} = { user: null, loading: false };

// This factory mock (rather than an auto-mock + vi.mocked(...).mockReturnValue)
// is this file's existing convention for stubbing useAuth — kept as-is here
// so the 2FA tests below share it instead of registering a second,
// conflicting vi.mock("@/hooks/useAuth", ...) call for the same module.
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

describe("AccountPage 2FA section", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    logout.mockReset();
    logout.mockResolvedValue(undefined);
    authState.user = null;
    authState.loading = false;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("shows an Enable 2FA button when 2FA is off", () => {
    authState.user = { id: "u1", username: "erin", email: "erin@example.com", totpEnabled: false };

    renderAt("/account");

    expect(screen.getByTestId("enable-2fa-button")).toBeInTheDocument();
  });

  it("setup shows a QR code and the raw secret, then reveals backup codes once enabled", async () => {
    authState.user = { id: "u1", username: "erin", email: "erin@example.com", totpEnabled: false };
    global.fetch = vi.fn((url: string) => {
      if (url === "/api/auth/2fa/setup") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ secretBase32: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x" }),
        } as Response);
      }
      if (url === "/api/auth/2fa/enable") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enabled: true, backupCodes: ["aaaaa-bbbbb"] }),
        } as Response);
      }
      return Promise.reject(new Error("unexpected url " + url));
    }) as unknown as typeof fetch;

    renderAt("/account");
    fireEvent.click(screen.getByTestId("enable-2fa-button"));
    await waitFor(() => expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("totp-code-input"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("confirm-2fa-code-button"));

    await waitFor(() => expect(screen.getByText("aaaaa-bbbbb")).toBeInTheDocument());
    expect(screen.getByTestId("backup-codes-warning")).toBeInTheDocument();
  });

  it("shows Replace and Disable actions when 2FA is on", () => {
    authState.user = { id: "u1", username: "erin", email: "erin@example.com", totpEnabled: true };

    renderAt("/account");

    expect(screen.getByTestId("replace-2fa-button")).toBeInTheDocument();
    expect(screen.getByTestId("disable-2fa-button")).toBeInTheDocument();
    expect(screen.getByTestId("regenerate-backup-codes-button")).toBeInTheDocument();
  });
});
