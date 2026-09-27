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
    allowContactRequests?: boolean;
  } | null;
  loading: boolean;
} = { user: null, loading: false };

// Mutates the shared authState directly rather than holding its own React
// state, matching this mock's existing "plain object read fresh on every
// useAuth() call" style — a subsequent state-driven re-render (e.g. the
// setFlow() calls already made by AccountPage's own handlers) then observes
// the patched value, which is exactly what's being tested: that patchUser is
// actually wired up and its effect is visible without a remount.
const patchUser = vi.fn((partial: Partial<NonNullable<typeof authState.user>>) => {
  if (authState.user) authState.user = { ...authState.user, ...partial };
});

// This factory mock (rather than an auto-mock + vi.mocked(...).mockReturnValue)
// is this file's existing convention for stubbing useAuth — kept as-is here
// so the 2FA tests below share it instead of registering a second,
// conflicting vi.mock("@/hooks/useAuth", ...) call for the same module.
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    loading: authState.loading,
    login: vi.fn(),
    logout,
    register: vi.fn(),
    patchUser,
  }),
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
    patchUser.mockClear();
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

describe("AccountPage 2FA section", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    logout.mockReset();
    logout.mockResolvedValue(undefined);
    patchUser.mockClear();
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

  // Regression test: useAuth() previously exposed no way to update the
  // cached user in place, so after a successful enable the page's buttons
  // stayed showing the pre-enable state (Enable 2FA) until a full reload,
  // even though the flow's own re-render (setFlow -> "backup-codes" -> back
  // to "idle") happens right away. patchUser({ totpEnabled: true }) must be
  // wired into confirmEnable so that same re-render shows the post-enable
  // buttons (Replace/Disable/Regenerate), with no remount involved.
  it("reflects 2FA now being enabled (Replace/Disable buttons) right after a successful enable, without a remount", async () => {
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
    expect(patchUser).toHaveBeenCalledWith({ totpEnabled: true });

    // Dismiss the backup-codes screen (same component instance, no remount)
    // and confirm the idle view now shows the post-enable buttons.
    fireEvent.click(screen.getByText(/i've saved these codes/i));

    expect(screen.queryByTestId("enable-2fa-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("replace-2fa-button")).toBeInTheDocument();
    expect(screen.getByTestId("disable-2fa-button")).toBeInTheDocument();
    expect(screen.getByTestId("regenerate-backup-codes-button")).toBeInTheDocument();
  });

  it("reflects 2FA now being disabled (Enable button) right after a successful disable, without a remount", async () => {
    authState.user = { id: "u1", username: "erin", email: "erin@example.com", totpEnabled: true };
    global.fetch = vi.fn((url: string) => {
      if (url === "/api/auth/2fa/disable") {
        return Promise.resolve({ ok: true, json: async () => ({ disabled: true }) } as Response);
      }
      return Promise.reject(new Error("unexpected url " + url));
    }) as unknown as typeof fetch;

    renderAt("/account");
    fireEvent.click(screen.getByTestId("disable-2fa-button"));
    fireEvent.change(screen.getByTestId("totp-action-code-input"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("confirm-totp-action-button"));

    await waitFor(() => expect(patchUser).toHaveBeenCalledWith({ totpEnabled: false }));
    await waitFor(() => expect(screen.getByTestId("enable-2fa-button")).toBeInTheDocument());
    expect(screen.queryByTestId("disable-2fa-button")).not.toBeInTheDocument();
  });
});
