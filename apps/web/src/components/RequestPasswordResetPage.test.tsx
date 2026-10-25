// apps/web/src/components/RequestPasswordResetPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";

import { RequestPasswordResetPage } from "./RequestPasswordResetPage";

function mockRequestResponse(emailDeliveryAvailable: boolean) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/auth/password-reset/request")) {
      return new Response(JSON.stringify({ requested: true, emailDeliveryAvailable }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function submitEmail() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <RequestPasswordResetPage />
    </MemoryRouter>
  );
  await user.type(screen.getByLabelText(/email/i), "someone@example.com");
  await user.click(screen.getByRole("button", { name: /send reset link/i }));
}

describe("RequestPasswordResetPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("tells the user to check their email when the instance can send email", async () => {
    const fetchSpy = mockRequestResponse(true);
    await submitEmail();

    await waitFor(() => {
      expect(screen.getByText(/a reset link has been sent/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/not available on this instance/i)).not.toBeInTheDocument();
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toEqual({ email: "someone@example.com" });
  });

  it("says reset by email is unavailable (not 'sent') when the instance has no mailer", async () => {
    mockRequestResponse(false);
    await submitEmail();

    await waitFor(() => {
      expect(screen.getByText(/not available on this instance/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/a reset link has been sent/i)).not.toBeInTheDocument();
  });
});
