// apps/web/src/components/ConfirmPasswordResetPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import {
  generateWrappingSalt,
  wrapPrivateKey,
  unwrapPrivateKey,
  generateRecoveryCode,
  deriveRecoveryKey,
  deriveWrappingKey,
  deriveAuthKey,
} from "@/lib/keyWrapping";

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
    let completeBody: Record<string, string> | null = null;

    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "i@example.com", passwordSalt: salt, recoveryWrappedPrivateKey: recoveryWrapped }),
          { status: 200 }
        );
      }
      if (url.includes("/complete") && !url.includes("fresh")) {
        completeBody = JSON.parse(String(init?.body));
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

    // Sends authKey (derived from the NEW salt), never the password, and the
    // re-wrapped key unwraps to the SAME private key under the new password.
    const body = completeBody!;
    expect(body).not.toHaveProperty("newPassword");
    expect(body.newAuthKey).toBe(await deriveAuthKey("a brand new password", body.newPasswordSalt));
    const newWrappingKey = await deriveWrappingKey("a brand new password", body.newPasswordSalt);
    expect(unwrapPrivateKey(body.newPasswordWrappedPrivateKey, newWrappingKey)).toEqual(keyPair.secretKey);
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
    let freshBody: Record<string, string> | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "j@example.com", passwordSalt: "c2FsdA==", recoveryWrappedPrivateKey: "d2FzdGVk" }),
          { status: 200 }
        );
      }
      if (url.includes("complete-fresh")) {
        freshBody = JSON.parse(String(init?.body));
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

    const body = freshBody!;
    expect(body).not.toHaveProperty("newPassword");
    expect(body.newAuthKey).toBe(await deriveAuthKey("a brand new password", body.newPasswordSalt));
  });

  // Regression guard for the zero-knowledge property (spec §3.1): neither
  // reset path may send the plaintext new password to the server.
  it.each([
    { path: "recovery-code", fresh: false },
    { path: "start-fresh", fresh: true },
  ])("never sends the plaintext new password in any request body ($path path)", async ({ fresh }) => {
    const PASSWORD = "Plaintext-New-Password-Must-Not-Leak-42";
    const keyPair = nacl.box.keyPair();
    const recoveryCode = generateRecoveryCode();
    const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
    const bodies: string[] = [];

    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      bodies.push(typeof init?.body === "string" ? init.body : "");
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({
            email: "k@example.com",
            passwordSalt: generateWrappingSalt(),
            recoveryWrappedPrivateKey: recoveryWrapped,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/complete")) return new Response(JSON.stringify({ reset: true }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");

    if (fresh) {
      await waitFor(() => screen.getByRole("button", { name: /don't have my recovery code/i }));
      await user.click(screen.getByRole("button", { name: /don't have my recovery code/i }));
      await user.type(screen.getByLabelText(/new password/i), PASSWORD);
      await user.click(screen.getByRole("button", { name: /start fresh and reset password/i }));
      await user.click(await screen.findByRole("button", { name: /saved my new recovery code/i }));
    } else {
      await waitFor(() => screen.getByLabelText(/recovery code/i));
      await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
      await user.type(screen.getByLabelText(/new password/i), PASSWORD);
      await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));
    }

    await waitFor(() => {
      expect(screen.getByText(/password has been reset/i)).toBeInTheDocument();
    });
    expect(bodies.length).toBe(2); // verify-token + complete / complete-fresh
    for (const body of bodies) {
      expect(body).not.toContain(PASSWORD);
    }
  });

  it("sends only one /complete request on a double submit and disables the button while in flight", async () => {
    const keyPair = nacl.box.keyPair();
    const recoveryCode = generateRecoveryCode();
    const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
    const salt = generateWrappingSalt();
    let completeCalls = 0;
    let releaseComplete!: () => void;
    const completeGate = new Promise<void>((resolve) => (releaseComplete = resolve));

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/verify-token")) {
        return new Response(
          JSON.stringify({ email: "i@example.com", passwordSalt: salt, recoveryWrappedPrivateKey: recoveryWrapped }),
          { status: 200 }
        );
      }
      if (url.includes("/complete")) {
        completeCalls += 1;
        await completeGate;
        return new Response(JSON.stringify({ reset: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    renderAt("/reset-password/confirm?token=abc");
    await waitFor(() => screen.getByLabelText(/recovery code/i));
    await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
    await user.type(screen.getByLabelText(/new password/i), "a brand new password");

    const submit = screen.getByRole("button", { name: /reset with recovery code/i });
    // Two synchronous submits, before React can re-render the disabled state.
    fireEvent.submit(submit.closest("form")!);
    fireEvent.submit(submit.closest("form")!);

    await waitFor(() => expect(completeCalls).toBe(1));
    expect(screen.getByRole("button", { name: /reset with recovery code/i })).toBeDisabled();

    releaseComplete();
    await waitFor(() => expect(screen.getByText(/password has been reset/i)).toBeInTheDocument());
    expect(completeCalls).toBe(1);
  });

  describe("two-factor accounts", () => {
    function setup(totpEnabled: boolean | undefined) {
      const keyPair = nacl.box.keyPair();
      const recoveryCode = generateRecoveryCode();
      const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
      return {
        recoveryCode,
        verifyBody: JSON.stringify({
          email: "t@example.com",
          passwordSalt: generateWrappingSalt(),
          recoveryWrappedPrivateKey: recoveryWrapped,
          ...(totpEnabled === undefined ? {} : { totpEnabled }),
        }),
      };
    }

    it("asks for the code up front when verify-token reports totpEnabled, and sends it with /complete", async () => {
      const { recoveryCode, verifyBody } = setup(true);
      const completeBodies: Record<string, string>[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/verify-token")) return new Response(verifyBody, { status: 200 });
        if (url.includes("/complete") && !url.includes("fresh")) {
          completeBodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ reset: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const user = userEvent.setup();
      renderAt("/reset-password/confirm?token=abc");
      await waitFor(() => screen.getByLabelText(/two-factor code/i));
      await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
      await user.type(screen.getByLabelText(/new password/i), "a brand new password");
      await user.type(screen.getByLabelText(/two-factor code/i), "123456");
      await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));

      await waitFor(() => expect(screen.getByText(/password has been reset/i)).toBeInTheDocument());
      expect(completeBodies).toHaveLength(1);
      expect(completeBodies[0]!.totpCode).toBe("123456");
    });

    it("shows no code field and sends no totpCode for an account without 2FA", async () => {
      const { recoveryCode, verifyBody } = setup(false);
      let completeBody: Record<string, string> | null = null;
      vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/verify-token")) return new Response(verifyBody, { status: 200 });
        if (url.includes("/complete")) {
          completeBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ reset: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const user = userEvent.setup();
      renderAt("/reset-password/confirm?token=abc");
      await waitFor(() => screen.getByLabelText(/recovery code/i));
      expect(screen.queryByLabelText(/two-factor code/i)).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
      await user.type(screen.getByLabelText(/new password/i), "a brand new password");
      await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));

      await waitFor(() => expect(screen.getByText(/password has been reset/i)).toBeInTheDocument());
      expect(completeBody).not.toHaveProperty("totpCode");
    });

    it("reveals the code field on a requiresTotp rejection from /complete-fresh, flags a wrong code, and completes on resubmit", async () => {
      const { verifyBody } = setup(undefined);
      const freshBodies: Record<string, string>[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/verify-token")) return new Response(verifyBody, { status: 200 });
        if (url.includes("complete-fresh")) {
          const body = JSON.parse(String(init?.body));
          freshBodies.push(body);
          if (body.totpCode === "654321") return new Response(JSON.stringify({ reset: true }), { status: 200 });
          return new Response(
            JSON.stringify({ error: body.totpCode ? "Invalid TOTP code" : "TOTP code required", requiresTotp: true }),
            { status: 401 }
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const user = userEvent.setup();
      renderAt("/reset-password/confirm?token=abc");
      await waitFor(() => screen.getByRole("button", { name: /don't have my recovery code/i }));
      await user.click(screen.getByRole("button", { name: /don't have my recovery code/i }));
      expect(screen.queryByLabelText(/two-factor code/i)).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(/new password/i), "a brand new password");
      await user.click(screen.getByRole("button", { name: /start fresh and reset password/i }));

      await waitFor(() => expect(screen.getByText(/enter the code from your authenticator/i)).toBeInTheDocument());
      expect(screen.queryByText(/invalid or has expired/i)).not.toBeInTheDocument();

      await user.type(screen.getByLabelText(/two-factor code/i), "000000");
      await user.click(screen.getByRole("button", { name: /start fresh and reset password/i }));
      await waitFor(() => expect(screen.getByText(/two-factor code is invalid/i)).toBeInTheDocument());

      await user.clear(screen.getByLabelText(/two-factor code/i));
      await user.type(screen.getByLabelText(/two-factor code/i), "654321");
      await user.click(screen.getByRole("button", { name: /start fresh and reset password/i }));
      await user.click(await screen.findByRole("button", { name: /saved my new recovery code/i }));
      await waitFor(() => expect(screen.getByText(/password has been reset/i)).toBeInTheDocument());

      expect(freshBodies.map((b) => b.totpCode)).toEqual([undefined, "000000", "654321"]);
    });

    it("shows a throttling message when too many codes were tried", async () => {
      const { recoveryCode, verifyBody } = setup(true);
      vi.spyOn(global, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/verify-token")) return new Response(verifyBody, { status: 200 });
        if (url.includes("/complete")) {
          return new Response(JSON.stringify({ error: "Too many attempts. Please try again later." }), { status: 429 });
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const user = userEvent.setup();
      renderAt("/reset-password/confirm?token=abc");
      await waitFor(() => screen.getByLabelText(/two-factor code/i));
      await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
      await user.type(screen.getByLabelText(/new password/i), "a brand new password");
      await user.type(screen.getByLabelText(/two-factor code/i), "111111");
      await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));
      await waitFor(() => expect(screen.getByText(/too many incorrect codes/i)).toBeInTheDocument());
    });
  });

  // Minimum password length (lib/passwordPolicy.ts) is enforced client-side
  // only — the server never sees the password — so the page must stop a
  // too-short password before ANY /complete or /complete-fresh call (which
  // would otherwise consume the reset token).
  describe.each([
    { path: "recovery", fresh: false },
    { path: "fresh", fresh: true },
  ])("minimum password length ($path path)", ({ fresh }) => {
    const setup = () => {
      const keyPair = nacl.box.keyPair();
      const recoveryCode = generateRecoveryCode();
      const recoveryWrapped = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));
      const completeCalls: string[] = [];
      vi.spyOn(global, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/verify-token")) {
          return new Response(
            JSON.stringify({
              email: "i@example.com",
              passwordSalt: generateWrappingSalt(),
              recoveryWrappedPrivateKey: recoveryWrapped,
            }),
            { status: 200 }
          );
        }
        if (url.includes("/complete")) {
          completeCalls.push(url);
          return new Response(JSON.stringify({ reset: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      return { recoveryCode, completeCalls };
    };

    const submit = async (user: ReturnType<typeof userEvent.setup>, recoveryCode: string, password: string) => {
      renderAt("/reset-password/confirm?token=abc");
      if (fresh) {
        await waitFor(() => screen.getByRole("button", { name: /don't have my recovery code/i }));
        await user.click(screen.getByRole("button", { name: /don't have my recovery code/i }));
        await user.type(screen.getByLabelText(/new password/i), password);
        await user.click(screen.getByRole("button", { name: /start fresh and reset password/i }));
      } else {
        await waitFor(() => screen.getByLabelText(/recovery code/i));
        await user.type(screen.getByLabelText(/recovery code/i), recoveryCode);
        await user.type(screen.getByLabelText(/new password/i), password);
        await user.click(screen.getByRole("button", { name: /reset with recovery code/i }));
      }
    };

    it("shows the minimum-length hint next to the field", async () => {
      setup();
      const user = userEvent.setup();
      renderAt("/reset-password/confirm?token=abc");
      if (fresh) {
        await waitFor(() => screen.getByRole("button", { name: /don't have my recovery code/i }));
        await user.click(screen.getByRole("button", { name: /don't have my recovery code/i }));
      } else {
        await waitFor(() => screen.getByLabelText(/new password/i));
      }
      expect(screen.getByLabelText(/new password/i)).toHaveAccessibleDescription(/at least 12 characters/i);
    });

    it("rejects an 11-character password with a clear message and never calls the server", async () => {
      const { recoveryCode, completeCalls } = setup();
      const user = userEvent.setup();
      await submit(user, recoveryCode, "a".repeat(11));

      // (The fresh path also renders its data-loss warning as an Alert, so
      // match the message text rather than a single role="alert".)
      expect(await screen.findByText(/password must be at least 12 characters long/i)).toHaveAttribute("role", "alert");
      expect(completeCalls).toEqual([]);
      expect(screen.queryByText(/password has been reset/i)).not.toBeInTheDocument();
    });

    it("accepts a password of exactly 12 characters", async () => {
      const { recoveryCode, completeCalls } = setup();
      const user = userEvent.setup();
      await submit(user, recoveryCode, "a".repeat(12));

      await waitFor(() => expect(completeCalls).toHaveLength(1));
      expect(screen.queryByText(/at least 12 characters long/i)).not.toBeInTheDocument();
    });
  });
});
