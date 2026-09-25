// apps/api/src/routes/auth.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

describe("POST /api/auth/register", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("registers a new user, creates their default permanent link, and sets a session cookie", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "alice@example.com",
        username: "alice",
        name: "Alice",
        password: "correct horse battery staple",
        passwordSalt: "c2FsdA==",
        passwordWrappedPrivateKey: "d3JhcHBlZA==",
        recoveryWrappedPrivateKey: "cmVjb3Zlcnk=",
        publicKey: "cHVia2V5",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.username).toBe("alice");
    expect(body.defaultLinkSlug).toBe("alice");
    expect(response.cookies.some((c: { name: string }) => c.name === "e2ee_drop_session")).toBe(true);

    const link = await prisma.link.findFirst({ where: { slug: "alice" } });
    expect(link?.isDefault).toBe(true);
    expect(link?.mode).toBe("permanent");
    expect(link?.ownerId).toBe(body.userId);
  });

  it("returns 409 when the email is already registered", async () => {
    const server = buildServer();
    const payload = {
      email: "bob@example.com",
      username: "bob",
      name: "Bob",
      password: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k1",
    };
    await server.inject({ method: "POST", url: "/api/auth/register", payload });
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, username: "bob2", publicKey: "k2" },
    });

    expect(second.statusCode).toBe(409);
  });

  it("returns 409 when the username is already registered (different email)", async () => {
    const server = buildServer();
    const payload = {
      email: "carol@example.com",
      username: "carol",
      name: "Carol",
      password: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "k1",
    };
    await server.inject({ method: "POST", url: "/api/auth/register", payload });
    const second = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, email: "carol2@example.com", publicKey: "k2" },
    });

    expect(second.statusCode).toBe(409);
    // Only the first registration's user/link should exist.
    const users = await prisma.user.findMany({ where: { username: "carol" } });
    expect(users).toHaveLength(1);
  });

  it("rejects registration when ALLOW_REGISTRATION is disabled", async () => {
    vi.resetModules();
    vi.doMock("../env", () => ({ env: { ALLOW_REGISTRATION: false, DEFAULT_STORAGE_QUOTA_BYTES: 1000 } }));
    const Fastify = (await import("fastify")).default;
    const { registerAuthRoutes } = await import("./auth");
    const freshServer = Fastify();
    registerAuthRoutes(freshServer);

    const response = await freshServer.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "x@example.com",
        username: "x",
        name: "X",
        password: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
      },
    });

    expect(response.statusCode).toBe(403);
    vi.doUnmock("../env");
    vi.resetModules();
  });

  it("rejects a username containing characters that would break /d/<username> routing", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "dave@example.com",
        username: "dave/../etc",
        name: "Dave",
        password: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
      },
    });

    expect(response.statusCode).toBe(400);
    const user = await prisma.user.findFirst({ where: { email: "dave@example.com" } });
    expect(user).toBeNull();
  });

  it("rejects a username that collides with a reserved application route", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "create@example.com",
        username: "create",
        name: "Create",
        password: "p",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
      },
    });

    expect(response.statusCode).toBe(400);
    const user = await prisma.user.findFirst({ where: { email: "create@example.com" } });
    expect(user).toBeNull();
  });
});
