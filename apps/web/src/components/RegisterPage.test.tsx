// apps/web/src/components/RegisterPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const registerMock = vi.fn().mockResolvedValue({ recoveryCode: "ABCD1234EFGH5678IJKL" });
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null, register: registerMock, login: vi.fn(), logout: vi.fn() }) }));

import { RegisterPage } from "./RegisterPage";

describe("RegisterPage", () => {
  beforeEach(() => {
    registerMock.mockClear();
  });

  it("shows the recovery code once registration succeeds", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText(/email/i), "h@example.com");
    await user.type(screen.getByLabelText(/username/i), "hank");
    await user.type(screen.getByLabelText(/display name/i), "Hank");
    await user.type(screen.getByLabelText(/^password/i), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText("ABCD1234EFGH5678IJKL")).toBeInTheDocument();
    });
    expect(registerMock).toHaveBeenCalledWith({
      email: "h@example.com",
      username: "hank",
      name: "Hank",
      password: "correct horse battery staple",
    });
  });

  // Minimum password length (lib/passwordPolicy.ts) can only be enforced
  // here: the server receives authKey, never the password.
  const fillForm = async (user: ReturnType<typeof userEvent.setup>, password: string) => {
    await user.type(screen.getByLabelText(/email/i), "h@example.com");
    await user.type(screen.getByLabelText(/username/i), "hank");
    await user.type(screen.getByLabelText(/display name/i), "Hank");
    await user.type(screen.getByLabelText(/^password/i), password);
    await user.click(screen.getByRole("button", { name: /create account/i }));
  };

  it("shows the minimum-length requirement next to the password field", () => {
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    expect(screen.getByLabelText(/^password/i)).toHaveAccessibleDescription(/at least 12 characters/i);
  });

  it("rejects an 11-character password with a clear message and never calls register", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    await fillForm(user, "a".repeat(11));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 12 characters/i);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("accepts a password of exactly 12 characters", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    await fillForm(user, "a".repeat(12));

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/at least 12 characters long/i)).not.toBeInTheDocument();
  });
});
