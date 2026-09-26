// apps/web/src/components/LoginPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const loginMock = vi.fn().mockResolvedValue({ requiresTotp: true });
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null, login: loginMock, register: vi.fn(), logout: vi.fn() }) }));

import { LoginPage } from "./LoginPage";

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/email/i), "grace@example.com");
  await user.type(screen.getByLabelText(/password/i), "secret");
  await user.click(screen.getByRole("button", { name: /log in/i }));
}

describe("LoginPage", () => {
  beforeEach(() => {
    loginMock.mockReset().mockResolvedValue({ requiresTotp: true });
  });

  it("shows a TOTP field after the server asks for a code", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    await fillAndSubmit(user);

    await waitFor(() => {
      expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument();
    });
  });

  it("I8: navigates to the returnTo path from location.state after a successful login", async () => {
    const user = userEvent.setup();
    loginMock.mockResolvedValueOnce({ requiresTotp: false });
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { returnTo: "/send/abc123" } }]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/send/:slug" element={<p>send page</p>} />
        </Routes>
      </MemoryRouter>
    );

    await fillAndSubmit(user);

    await waitFor(() => {
      expect(screen.getByText(/send page/i)).toBeInTheDocument();
    });
  });

  it("falls back to the terminal done message when no returnTo was given", async () => {
    const user = userEvent.setup();
    loginMock.mockResolvedValueOnce({ requiresTotp: false });
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    await fillAndSubmit(user);

    await waitFor(() => {
      expect(screen.getByText(/log in ✓/i)).toBeInTheDocument();
    });
  });
});
