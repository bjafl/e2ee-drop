// apps/web/src/components/RegisterPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const registerMock = vi.fn().mockResolvedValue({ recoveryCode: "ABCD1234EFGH5678IJKL" });
vi.mock("@/hooks/useAuth", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useAuth")>("@/hooks/useAuth");
  return {
    ...actual,
    useAuth: () => ({ user: null, register: registerMock, login: vi.fn(), logout: vi.fn() }),
  };
});

import { RegisterPage } from "./RegisterPage";
import { RegisterError } from "@/hooks/useAuth";

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

  it("shows the already-in-use message with a login link on a 409, not the generic fallback", async () => {
    registerMock.mockRejectedValueOnce(new RegisterError(409, { error: "Email or username already in use" }));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    await fillForm(user, "correct horse battery staple");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already in use/i);
    expect(alert).not.toHaveTextContent(/please try again/i);
    const loginLink = screen.getByRole("link", { name: /log in instead/i });
    expect(loginLink).toHaveAttribute("href", "/login");
  });

  it("shows a registration-disabled message on a 403", async () => {
    registerMock.mockRejectedValueOnce(new RegisterError(403, { error: "Registration is disabled on this instance" }));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    await fillForm(user, "correct horse battery staple");

    expect(await screen.findByRole("alert")).toHaveTextContent(/registration is currently disabled/i);
  });

  it("shows a rate-limited message on a 429", async () => {
    registerMock.mockRejectedValueOnce(new RegisterError(429, { error: "Too many attempts. Please try again later." }));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    await fillForm(user, "correct horse battery staple");

    expect(await screen.findByRole("alert")).toHaveTextContent(/too many registration attempts/i);
  });

  it("shows an invalid-username message on a 400", async () => {
    registerMock.mockRejectedValueOnce(
      new RegisterError(400, {
        error: "Username must be 3-32 characters, lowercase letters/numbers/hyphens/underscores only, and not a reserved name",
      })
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    await fillForm(user, "correct horse battery staple");

    expect(await screen.findByRole("alert")).toHaveTextContent(/usernames must be 3-32 characters/i);
  });

  it("falls back to the generic message for an unanticipated error", async () => {
    registerMock.mockRejectedValueOnce(new Error("network exploded"));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );
    await fillForm(user, "correct horse battery staple");

    expect(await screen.findByRole("alert")).toHaveTextContent(/registration failed\. please try again\./i);
  });
});
