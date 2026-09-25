// apps/web/src/components/DeleteAccountDialog.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { generateWrappingSalt, deriveAuthKey } from "@/lib/keyWrapping";
import { DeleteAccountDialog } from "./DeleteAccountDialog";

// The dialog derives authKey client-side (never sends the plaintext
// password — see DELETE /api/account's contract in apps/api/src/routes/
// account.ts), which requires passwordSalt from a fresh GET /api/auth/me
// call. So this mock branches on the request URL: /api/auth/me returns a
// realistic MeResponse-shaped body with a real, deriveAuthKey-consumable
// salt, while /api/account (DELETE) returns whatever each test wants to
// assert on.
const PASSWORD_SALT = generateWrappingSalt();

function mockFetchSequence(deleteResponse: { ok: boolean; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/me") && (!init || !init.method)) {
        return {
          ok: true,
          json: async () => ({
            userId: "user-1",
            username: "alice",
            name: "Alice",
            email: "alice@example.com",
            emailVerified: true,
            publicKey: "cHVibGljS2V5",
            passwordSalt: PASSWORD_SALT,
            passwordWrappedPrivateKey: "d3JhcHBlZA==",
            totpEnabled: false,
          }),
        };
      }
      if (url === "/api/account" && init?.method === "DELETE") {
        return { ok: deleteResponse.ok, json: async () => deleteResponse.body };
      }
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    })
  );
}

describe("DeleteAccountDialog", () => {
  beforeEach(() => {
    mockFetchSequence({ ok: true, body: { deleted: true } });
  });

  it("keeps the confirm button disabled until a password is entered, then calls onDeleted on success", async () => {
    const onDeleted = vi.fn();
    render(<DeleteAccountDialog onDeleted={onDeleted} />);

    fireEvent.click(screen.getByText(/delete account/i));
    // getByRole (not getByText), because the warning paragraph
    // ("This permanently deletes your account...") also contains the
    // substring "permanently delete" and would otherwise collide with the
    // confirm button's own text.
    const confirmButton = await screen.findByRole("button", { name: /permanently delete/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("delete-account-password"), { target: { value: "my-password" } });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());

    // GET /api/auth/me (for passwordSalt) + DELETE /api/account (with the
    // derived authKey) — never the plaintext password.
    expect(fetch).toHaveBeenCalledWith("/api/auth/me");
    expect(fetch).toHaveBeenCalledWith("/api/account", expect.objectContaining({ method: "DELETE" }));

    const deleteCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "DELETE"
    );
    const deleteBody = JSON.parse(String((deleteCall![1] as RequestInit).body));
    expect(deleteBody).not.toHaveProperty("password");
    expect(deleteBody.authKey).toBe(await deriveAuthKey("my-password", PASSWORD_SALT));
  });

  it("shows the server error and does not call onDeleted when the password is wrong", async () => {
    mockFetchSequence({ ok: false, body: { error: "Incorrect password" } });
    const onDeleted = vi.fn();
    render(<DeleteAccountDialog onDeleted={onDeleted} />);

    fireEvent.click(screen.getByText(/delete account/i));
    fireEvent.change(await screen.findByTestId("delete-account-password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Incorrect password"));
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
