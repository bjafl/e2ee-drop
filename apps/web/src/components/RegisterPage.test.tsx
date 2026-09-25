// apps/web/src/components/RegisterPage.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const registerMock = vi.fn().mockResolvedValue({ recoveryCode: "ABCD1234EFGH5678IJKL" });
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null, register: registerMock, login: vi.fn(), logout: vi.fn() }) }));

import { RegisterPage } from "./RegisterPage";

describe("RegisterPage", () => {
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
});
