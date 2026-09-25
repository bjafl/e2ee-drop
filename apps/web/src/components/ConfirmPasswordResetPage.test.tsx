// apps/web/src/components/ConfirmPasswordResetPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { generateWrappingSalt, wrapPrivateKey, generateRecoveryCode, deriveRecoveryKey } from "@/lib/keyWrapping";

import { ConfirmPasswordResetPage } from "./ConfirmPasswordResetPage";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password/confirm" element={<ConfirmPasswordResetPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ConfirmPasswordResetPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resets with a correct recovery code without warning about data loss", async () => {
    const keyPair = nacl.box.keyPair();
    const recoveryCode = generateRecoveryCode();
    const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
    const salt = generateWrappingSalt();

    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "i@example.com", passwordSalt: salt, recoveryWrappedPrivateKey: recoveryWrapped }),
          { status: 200 }
        );
      }
      if (url.includes("/complete") && !url.includes("fresh")) {
        return new Response(JSON.stringify({ reset: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");

    await waitFor(() => screen.getByLabelText(/recovery code/i));
    await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
    await user.type(screen.getByLabelText(/new password/i), "a brand new password");
    await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));

    await waitFor(() => {
      expect(screen.getByText(/password has been reset/i)).toBeInTheDocument();
    });
    expect(encodeBase64(keyPair.publicKey)).toBeTruthy(); // sanity: the key pair used above is valid
  });

  it("shows a specific error (not the wrong-recovery-code message) when the server call fails for an unrelated reason", async () => {
    const keyPair = nacl.box.keyPair();
    const recoveryCode = generateRecoveryCode();
    const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
    const salt = generateWrappingSalt();

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "i@example.com", passwordSalt: salt, recoveryWrappedPrivateKey: recoveryWrapped }),
          { status: 200 }
        );
      }
      if (url.includes("/complete") && !url.includes("fresh")) {
        return new Response(JSON.stringify({ error: "server exploded" }), { status: 500 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");

    await waitFor(() => screen.getByLabelText(/recovery code/i));
    await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
    await user.type(screen.getByLabelText(/new password/i), "a brand new password");
    await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/doesn't match this account/i)).not.toBeInTheDocument();
  });

  it("shows the wrong-recovery-code message when the recovery code does not unwrap the key", async () => {
    const keyPair = nacl.box.keyPair();
    const recoveryCode = generateRecoveryCode();
    const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
    const salt = generateWrappingSalt();

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "i@example.com", passwordSalt: salt, recoveryWrappedPrivateKey: recoveryWrapped }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");

    await waitFor(() => screen.getByLabelText(/recovery code/i));
    await user.type(screen.getByLabelText(/recovery code/i), "THIS IS NOT THE RIGHT CODE");
    await user.type(screen.getByLabelText(/new password/i), "a brand new password");
    await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));

    await waitFor(() => {
      expect(screen.getByText(/doesn't match this account/i)).toBeInTheDocument();
    });
  });

  it("shows the data-loss warning, then a new recovery code that must be confirmed before completing, when the user has no recovery code", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "j@example.com", passwordSalt: "c2FsdA==", recoveryWrappedPrivateKey: "d2FzdGVk" }),
          { status: 200 }
        );
      }
      if (url.includes("complete-fresh")) {
        return new Response(JSON.stringify({ reset: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");

    await waitFor(() => screen.getByRole("button", { name: /don't have my recovery code/i }));
    await user.click(screen.getByRole("button", { name: /don't have my recovery code/i }));

    expect(screen.getByText(/cannot be recovered/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/new password/i), "a brand new password");
    await user.click(screen.getByRole("button", { name: /start fresh and reset password/i }));

    // The new recovery code must be shown and explicitly confirmed before the
    // reset is considered complete — mirroring RegisterPage's one-time-display
    // pattern for a brand-new recovery code, so the user isn't left with a new
    // key protected by a code they were never shown.
    const confirmButton = await screen.findByRole("button", { name: /saved my new recovery code/i });
    expect(screen.queryByText(/password has been reset/i)).not.toBeInTheDocument();

    await user.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByText(/password has been reset/i)).toBeInTheDocument();
    });
  });
});
