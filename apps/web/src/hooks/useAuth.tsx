// apps/web/src/hooks/useAuth.tsx
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import type { LoginResponse, MeResponse, PreloginResponse, RegisterResponse } from "@e2ee-drop/shared";
import {
  generateWrappingSalt,
  deriveWrappingKey,
  deriveAuthKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  generateRecoveryCode,
  deriveRecoveryKey,
} from "@/lib/keyWrapping";

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  email: string;
  emailVerified: boolean;
  publicKey: string;
  totpEnabled: boolean;
  // Undefined immediately after register()/login(), which don't carry this
  // field on their response bodies (see MeResponse vs. LoginResponse) —
  // callers should treat undefined the same as the DB default (true), the
  // way AccountPage does. Always defined once the initial /api/auth/me
  // session restore below has settled.
  allowContactRequests?: boolean;
  keyPair: nacl.BoxKeyPair | null;
}

export interface RegisterInput {
  email: string;
  username: string;
  name: string;
  password: string;
}

// Thrown by register() on a non-2xx response, carrying the HTTP status code
// (and the server's parsed { error } body, when present) instead of a fixed
// generic message — RegisterPage needs to tell a 409 (already in use — see
// the SEC11 trade-off comment in apps/api/src/routes/auth.ts, which depends
// on the frontend actually surfacing this distinctly), 400 (invalid
// input), 403 (registration disabled) and 429 (rate limited) apart, each
// with its own message. login()'s existing requiresTotp handling below
// takes the same approach of inspecting the response body rather than just
// `.ok`, but resolves entirely inside this hook (it returns a result
// instead of throwing); register()'s callers need the distinction
// themselves, so it's carried on the thrown error instead.
export class RegisterError extends Error {
  readonly status: number;
  readonly body?: { error?: string };

  constructor(status: number, body?: { error?: string }) {
    super(body?.error ?? "Registration failed");
    this.name = "RegisterError";
    this.status = status;
    this.body = body;
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  // True until the initial GET /api/auth/me session restore settles. Pages
  // that redirect logged-out visitors must wait for this, or a hard refresh
  // of a protected page bounces to /login before the session is restored.
  loading: boolean;
  login: (email: string, password: string, totpCode?: string) => Promise<{ requiresTotp: boolean }>;
  logout: () => Promise<void>;
  register: (input: RegisterInput) => Promise<{ recoveryCode: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? (res.json() as Promise<MeResponse>) : null))
      .then((data) => {
        if (!data) return;
        setUser({
          id: data.userId,
          username: data.username,
          name: data.name,
          email: data.email,
          emailVerified: data.emailVerified,
          publicKey: data.publicKey,
          totpEnabled: data.totpEnabled,
          allowContactRequests: data.allowContactRequests,
          keyPair: null,
        });
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const register = useCallback(async (input: RegisterInput): Promise<{ recoveryCode: string }> => {
    const keyPair = nacl.box.keyPair();
    const passwordSalt = generateWrappingSalt();
    const wrappingKey = await deriveWrappingKey(input.password, passwordSalt);
    const passwordWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, wrappingKey);
    // Separate, domain-separated Argon2id output used as the login
    // credential. The plaintext password is never sent to the server.
    const authKey = await deriveAuthKey(input.password, passwordSalt);

    const recoveryCode = generateRecoveryCode();
    const recoveryWrappedPrivateKey = wrapPrivateKey(keyPair.secretKey, deriveRecoveryKey(recoveryCode));

    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        username: input.username,
        name: input.name,
        authKey,
        passwordSalt,
        passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey,
        publicKey: encodeBase64(keyPair.publicKey),
      }),
    });
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new RegisterError(response.status, errorBody);
    }
    const body: RegisterResponse = await response.json();

    setUser({
      id: body.userId,
      username: body.username,
      name: input.name,
      email: input.email,
      emailVerified: false,
      publicKey: encodeBase64(keyPair.publicKey),
      totpEnabled: false,
      keyPair,
    });

    return { recoveryCode };
  }, []);

  const login = useCallback(
    async (email: string, password: string, totpCode?: string): Promise<{ requiresTotp: boolean }> => {
      // 1. Fetch passwordSalt first: authKey can't be derived without it,
      //    and the plaintext password must never be sent. Runs on every
      //    call, including the TOTP retry (login() is stateless between the
      //    two submissions, so it just repeats prelogin + derivation).
      const preloginResponse = await fetch("/api/auth/prelogin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!preloginResponse.ok) throw new Error("Login failed");
      const { passwordSalt } = (await preloginResponse.json()) as PreloginResponse;

      // 2. Derive both keys locally. The wrapping key stays in the browser;
      //    only authKey goes to the server.
      const wrappingKey = await deriveWrappingKey(password, passwordSalt);
      const authKey = await deriveAuthKey(password, passwordSalt);

      // 3. Submit. A requiresTotp response short-circuits here, before any
      //    unwrap; the caller re-invokes login() with the TOTP code.
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, authKey, totpCode }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.requiresTotp) return { requiresTotp: true };
        throw new Error(body.error ?? "Login failed");
      }
      const loginBody = body as LoginResponse;
      // The login response's passwordSalt is not used: the wrapping key was
      // already derived from the prelogin salt, and that same salt is what
      // authenticated this login (a mismatched salt would have produced a
      // wrong authKey and a 401), so unwrapping with it is correct.
      const secretKey = unwrapPrivateKey(loginBody.passwordWrappedPrivateKey, wrappingKey);
      const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);

      setUser({
        id: loginBody.userId,
        username: loginBody.username,
        name: loginBody.name,
        email: loginBody.email,
        emailVerified: loginBody.emailVerified,
        publicKey: loginBody.publicKey,
        totpEnabled: loginBody.totpEnabled,
        keyPair,
      });

      return { requiresTotp: false };
    },
    []
  );

  const logout = useCallback(async () => {
    // Clear local state even if the request fails: the decrypted private key
    // in `user.keyPair` must not outlive a logout (or an account deletion).
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
    }
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout, register }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
