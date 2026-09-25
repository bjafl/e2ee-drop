// apps/web/src/hooks/useAuth.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { generateWrappingSalt, deriveWrappingKey, deriveAuthKey, wrapPrivateKey } from "@/lib/keyWrapping";
import { AuthProvider, useAuth } from "./useAuth";

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

interface CapturedRequest {
  url: string;
  body: string;
}

// Wraps a fetch mock implementation so every request's URL and raw body
// string is recorded, for assertions on exactly what left the browser.
function spyFetch(handler: (url: string, body: string) => Response | Promise<Response>): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    captured.push({ url, body });
    return handler(url, body);
  });
  return captured;
}

function loginResponse(keyPair: nacl.BoxKeyPair, salt: string, wrapped: string) {
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

describe("useAuth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("register() generates a key pair locally, stores it in state, and sends authKey instead of the password", async () => {
    const captured = spyFetch((url) => {
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
        password: "frank's password",
      });
      recoveryCode = code;
    });

    expect(result.current.user?.username).toBe("frank");
    expect(result.current.user?.keyPair).not.toBeNull();
    expect(recoveryCode.length).toBeGreaterThan(0);

    const registerBody = JSON.parse(captured.find((c) => c.url.includes("/api/auth/register"))!.body);
    expect(registerBody).not.toHaveProperty("password");
    expect(registerBody.authKey).toBe(await deriveAuthKey("frank's password", registerBody.passwordSalt));
  });

  it("login() fetches the salt via prelogin, sends authKey (not the password), and unwraps the real private key", async () => {
    const keyPair = nacl.box.keyPair();
    const salt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey("secret", salt);
    const wrapped = wrapPrivateKey(keyPair.secretKey, wrappingKey);

    const captured = spyFetch((url) => {
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/prelogin")) return new Response(JSON.stringify({ passwordSalt: salt }), { status: 200 });
      if (url.includes("/api/auth/login")) return loginResponse(keyPair, salt, wrapped);
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.login("grace@example.com", "secret");
    });

    expect(result.current.user?.keyPair?.publicKey).toEqual(keyPair.publicKey);

    const urls = captured.map((c) => c.url).filter((u) => !u.includes("/api/auth/me"));
    expect(urls).toEqual(["/api/auth/prelogin", "/api/auth/login"]);
    expect(JSON.parse(captured.find((c) => c.url.includes("/prelogin"))!.body)).toEqual({
      email: "grace@example.com",
    });
    const loginBody = JSON.parse(captured.find((c) => c.url.includes("/api/auth/login"))!.body);
    expect(loginBody).not.toHaveProperty("password");
    expect(loginBody.authKey).toBe(await deriveAuthKey("secret", salt));
  });

  it("login() reports requiresTotp instead of throwing when the server asks for a code", async () => {
    const salt = generateWrappingSalt();
    spyFetch((url) => {
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/prelogin")) return new Response(JSON.stringify({ passwordSalt: salt }), { status: 200 });
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

  it("login() throws when prelogin fails, without calling /login", async () => {
    const captured = spyFetch((url) => {
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/prelogin")) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await expect(result.current.login("grace@example.com", "secret")).rejects.toThrow();
    });
    expect(captured.some((c) => c.url.includes("/api/auth/login"))).toBe(false);
  });

  // Regression guard for the zero-knowledge property (spec §3.1): the server
  // must never receive the plaintext password in any request, across
  // register, login, and the TOTP-required-then-retry login path.
  it("never sends the plaintext password in any request body across register, login, and a TOTP retry", async () => {
    const PASSWORD = "Plaintext-Password-Must-Not-Leak-42";
    let stored: { passwordSalt: string; passwordWrappedPrivateKey: string; publicKey: string } | null = null;
    let totpRequired = true;

    const captured = spyFetch((url, body) => {
      if (url.includes("/api/auth/me")) return new Response(null, { status: 403 });
      if (url.includes("/api/auth/register")) {
        const parsed = JSON.parse(body);
        stored = {
          passwordSalt: parsed.passwordSalt,
          passwordWrappedPrivateKey: parsed.passwordWrappedPrivateKey,
          publicKey: parsed.publicKey,
        };
        return new Response(JSON.stringify({ userId: "u1", username: "grace", defaultLinkSlug: "grace" }), {
          status: 200,
        });
      }
      if (url.includes("/api/auth/prelogin")) {
        return new Response(JSON.stringify({ passwordSalt: stored!.passwordSalt }), { status: 200 });
      }
      if (url.includes("/api/auth/login")) {
        const parsed = JSON.parse(body);
        if (totpRequired && !parsed.totpCode) {
          return new Response(JSON.stringify({ error: "TOTP code required", requiresTotp: true }), { status: 401 });
        }
        totpRequired = false;
        return new Response(
          JSON.stringify({
            userId: "u1",
            username: "grace",
            name: "Grace",
            email: "grace@example.com",
            emailVerified: false,
            publicKey: stored!.publicKey,
            passwordSalt: stored!.passwordSalt,
            passwordWrappedPrivateKey: stored!.passwordWrappedPrivateKey,
            totpEnabled: true,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/auth/logout")) return new Response(JSON.stringify({ loggedOut: true }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.register({ email: "grace@example.com", username: "grace", name: "Grace", password: PASSWORD });
    });
    const registeredPublicKey = result.current.user?.keyPair?.publicKey;
    expect(registeredPublicKey).toBeDefined();
    await act(async () => {
      await result.current.logout();
    });

    let first: { requiresTotp: boolean } | undefined;
    await act(async () => {
      first = await result.current.login("grace@example.com", PASSWORD);
    });
    expect(first?.requiresTotp).toBe(true);
    await act(async () => {
      await result.current.login("grace@example.com", PASSWORD, "123456");
    });

    // The full flow worked end to end (keys round-tripped via authKey-only requests)...
    expect(result.current.user?.keyPair?.publicKey).toEqual(registeredPublicKey);
    expect(captured.filter((c) => c.url.includes("/api/auth/login"))).toHaveLength(2);
    // ...and the plaintext password appeared in none of the request bodies.
    expect(captured.length).toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.body).not.toContain(PASSWORD);
    }
  });
});
