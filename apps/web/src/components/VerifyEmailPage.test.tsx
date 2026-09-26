import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const patchUser = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: null, loading: false, login: vi.fn(), logout: vi.fn(), register: vi.fn(), patchUser }),
}));

import { VerifyEmailPage } from "./VerifyEmailPage";

describe("VerifyEmailPage", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    patchUser.mockReset();
  });

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/verify-email/confirm" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("shows success on a valid token", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
    renderAt("/verify-email/confirm?token=abc123");
    await waitFor(() => expect(screen.getByText(/verified/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith("/api/auth/verify-email/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "abc123" }),
    });
  });

  it("shows an error on an invalid token", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false } as Response);
    renderAt("/verify-email/confirm?token=bad");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("patches the cached user's emailVerified flag on success", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
    renderAt("/verify-email/confirm?token=abc123");
    await waitFor(() => expect(screen.getByText(/verified/i)).toBeInTheDocument());
    expect(patchUser).toHaveBeenCalledWith({ emailVerified: true });
  });

  // Regression test for the double-invoke bug: React StrictMode
  // mounts -> unmounts -> remounts every component once in dev, running this
  // effect twice. A plain `let cancelled` inside the effect body only
  // suppressed the *second* mount's response handling, not its POST, which
  // fired anyway and consumed the token — so the second mount's own POST
  // then got a 400 for an already-consumed token, turning a real success
  // into an apparent failure. The `useRef` guard in VerifyEmailPage must
  // make the POST itself fire only once despite StrictMode's double-invoke.
  it("fires the confirm POST exactly once under React StrictMode's dev double-invoke", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/verify-email/confirm?token=abc123"]}>
          <Routes>
            <Route path="/verify-email/confirm" element={<VerifyEmailPage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>
    );

    await waitFor(() => expect(screen.getByText(/verified/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
