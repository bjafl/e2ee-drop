// apps/web/src/hooks/useAuth.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { generateWrappingSalt, deriveWrappingKey, wrapPrivateKey } from "@/lib/keyWrapping";
import { AuthProvider, useAuth } from "./useAuth";

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("useAuth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("register() generates a key pair locally and stores it, unwrapped, in state", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/register")) {
        return new Response(JSON.stringify({ userId: "u1", username: "frank", defaultLinkSlug: "frank" }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    let recoveryCode = "";
    await act(async () => {
      const { recoveryCode: code } = await result.current.register({
        email: "frank@example.com",
        username: "frank",
        name: "Frank",
        password: "p",
      });
      recoveryCode = code;
    });

    expect(result.current.user?.username).toBe("frank");
    expect(result.current.user?.keyPair).not.toBeNull();
    expect(recoveryCode.length).toBeGreaterThan(0);
  });

  it("login() derives the wrapping key from the server-returned salt and unwraps the real private key", async () => {
    const keyPair = nacl.box.keyPair();
    const salt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey("secret", salt);
    const wrapped = wrapPrivateKey(keyPair.secretKey, wrappingKey);

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/login")) {
        return new Response(
          JSON.stringify({
            userId: "u1",
            username: "grace",
            name: "Grace",
            email: "grace@example.com",
            emailVerified: false,
            publicKey: encodeBase64(keyPair.publicKey),
            passwordSalt: salt,
            passwordWrappedPrivateKey: wrapped,
            totpEnabled: false,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.login("grace@example.com", "secret");
    });

    expect(result.current.user?.keyPair?.publicKey).toEqual(keyPair.publicKey);
  });

  it("login() reports requiresTotp instead of throwing when the server asks for a code", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/login")) {
        return new Response(JSON.stringify({ error: "TOTP code required", requiresTotp: true }), { status: 401 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    let outcome: { requiresTotp: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.login("grace@example.com", "secret");
    });

    expect(outcome?.requiresTotp).toBe(true);
    expect(result.current.user).toBeNull();
  });
});
