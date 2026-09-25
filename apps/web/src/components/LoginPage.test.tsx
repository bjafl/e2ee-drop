// apps/web/src/components/LoginPage.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const loginMock = vi.fn().mockResolvedValue({ requiresTotp: true });
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null, login: loginMock, register: vi.fn(), logout: vi.fn() }) }));

import { LoginPage } from "./LoginPage";

describe("LoginPage", () => {
  it("shows a TOTP field after the server asks for a code", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText(/email/i), "grace@example.com");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument();
    });
  });
});
