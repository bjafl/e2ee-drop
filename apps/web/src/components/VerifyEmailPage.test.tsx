import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { VerifyEmailPage } from "./VerifyEmailPage";

describe("VerifyEmailPage", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
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
});
