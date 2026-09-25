// apps/web/src/components/AccountPage.integration.test.tsx
//
// Uses the real AuthProvider (fetch stubbed) rather than a mocked useAuth():
// the bug this guards against — logout()'s setUser(null) re-rendering the
// page into its own "logged out -> /login" guard before navigating home —
// only shows up when logout genuinely clears `user`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";

// The dialog is covered by DeleteAccountDialog.test.tsx; stub it so the test
// can fire onDeleted directly, as the real dialog does after a 2xx DELETE.
vi.mock("@/components/DeleteAccountDialog", () => ({
  DeleteAccountDialog: ({ onDeleted }: { onDeleted: () => void }) => (
    <button data-testid="delete-account-dialog" onClick={onDeleted}>
      stub delete
    </button>
  ),
}));

import { AccountPage } from "./AccountPage";

const visited: string[] = [];
function LocationRecorder() {
  const location = useLocation();
  if (visited[visited.length - 1] !== location.pathname) visited.push(location.pathname);
  return null;
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/account"]}>
      <AuthProvider>
        <LocationRecorder />
        <Routes>
          <Route path="/" element={<p>home page</p>} />
          <Route path="/login" element={<p>login page</p>} />
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

function stubFetch(logoutResult: "ok" | "network-error") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/me") {
        return {
          ok: true,
          json: async () => ({
            userId: "u1",
            username: "alice",
            name: "Alice",
            email: "alice@example.com",
            emailVerified: true,
            publicKey: "cHVi",
            passwordSalt: "c2FsdA==",
            passwordWrappedPrivateKey: "d3JhcA==",
            totpEnabled: false,
          }),
        };
      }
      if (url === "/api/auth/logout" && init?.method === "POST") {
        if (logoutResult === "network-error") throw new TypeError("network down");
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    })
  );
}

describe("AccountPage with the real AuthProvider", () => {
  beforeEach(() => {
    visited.length = 0;
  });

  it("lands on / (never /login) after the account is deleted, and logs out", async () => {
    stubFetch("ok");
    renderApp();

    await userEvent.click(await screen.findByTestId("delete-account-dialog"));

    await waitFor(() => {
      expect(screen.getByText("home page")).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(visited).toEqual(["/account", "/"]);
  });

  it("still lands on / when the logout request itself fails", async () => {
    stubFetch("network-error");
    renderApp();

    await userEvent.click(await screen.findByTestId("delete-account-dialog"));

    await waitFor(() => {
      expect(screen.getByText("home page")).toBeInTheDocument();
    });
    expect(visited).toEqual(["/account", "/"]);
  });
});
