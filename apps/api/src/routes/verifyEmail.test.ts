// apps/api/src/routes/verifyEmail.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { clearAllRateLimiters } from "../lib/rateLimit";

vi.mock("../lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer")>();
  return { ...actual, sendVerificationEmail: vi.fn().mockResolvedValue(undefined), isMailerConfigured: () => true };
});

async function registerAndGetCookie(server: ReturnType<typeof buildServer>, email: string, username: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email,
      username,
      name: "Test User",
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k",
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return { userId: response.json().userId, cookieValue: cookie.value };
}

describe("verify-email routes", () => {
  beforeEach(async () => {
    clearAllRateLimiters();
    await prisma.emailVerificationToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("confirms a valid token and sets emailVerified", async () => {
    const server = buildServer();
    await registerAndGetCookie(server, "confirm@example.com", "confirmuser");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "confirm@example.com" } });
    // Read the token back out via its hash isn't possible (one-way) — instead,
    // exercise the flow by minting our own token+row the same way the route does,
    // to keep this test independent of register's internal token generation.
    const { hashVerificationToken } = await import("./verifyEmail");
    const token = "test-token-value";
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() + 60_000) },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/verify-email/confirm",
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.emailVerified).toBe(true);
  });

  it("rejects an already-consumed token", async () => {
    const server = buildServer();
    await registerAndGetCookie(server, "reuse@example.com", "reuseuser");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "reuse@example.com" } });
    const { hashVerificationToken } = await import("./verifyEmail");
    const token = "reuse-token";
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() + 60_000) },
    });

    const first = await server.inject({ method: "POST", url: "/api/auth/verify-email/confirm", payload: { token } });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({ method: "POST", url: "/api/auth/verify-email/confirm", payload: { token } });
    expect(second.statusCode).toBe(400);
  });

  it("rejects an expired token", async () => {
    const server = buildServer();
    await registerAndGetCookie(server, "expired@example.com", "expireduser");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "expired@example.com" } });
    const { hashVerificationToken } = await import("./verifyEmail");
    const token = "expired-token";
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashVerificationToken(token), expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await server.inject({ method: "POST", url: "/api/auth/verify-email/confirm", payload: { token } });
    expect(response.statusCode).toBe(400);
  });

  it("resend requires authentication", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "POST", url: "/api/auth/verify-email/resend" });
    expect(response.statusCode).toBe(403);
  });

  it("resend invalidates the previous token and rate-limits after 3 calls in the window", async () => {
    const server = buildServer();
    const { cookieValue } = await registerAndGetCookie(server, "resend@example.com", "resenduser");
    const cookies = { e2ee_drop_session: cookieValue };

    const first = await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { emailDeliveryAvailable: boolean }).emailDeliveryAvailable).toBe(true);

    await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    const fourth = await server.inject({ method: "POST", url: "/api/auth/verify-email/resend", cookies });
    expect(fourth.statusCode).toBe(429);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "resend@example.com" } });
    const tokenCount = await prisma.emailVerificationToken.count({ where: { userId: user.id } });
    expect(tokenCount).toBe(1); // registration's token + each resend's invalidate-then-create nets to 1
  });
});
