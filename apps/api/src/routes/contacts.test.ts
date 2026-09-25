// apps/api/src/routes/contacts.test.ts
//
// The brief this test was drafted from used a placeholder `x-test-user-id`
// header to fake `request.user` in .inject() calls. That header does not
// exist anywhere in this codebase's real auth plugin (apps/api/src/plugins/auth.ts)
// — request.user is populated only from a signed SESSION_COOKIE_NAME cookie,
// resolved via lib/sessions.ts. Per twoFactor.test.ts's established pattern
// (registerAndGetCookie), each test user here is a REAL user registered via
// POST /api/auth/register, and every subsequent authenticated request uses
// that user's real session cookie extracted from the registration response.
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

async function registerAndGetCookie(server: ReturnType<typeof buildServer>, username: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `${username}@example.com`,
      username,
      name: username,
      authKey: "p",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: `${username}-pubkey`,
    },
  });
  const cookie = response.cookies.find((c: { name: string }) => c.name === "e2ee_drop_session")!;
  return { userId: response.json().userId as string, cookies: { e2ee_drop_session: cookie.value } };
}

describe("contact routes", () => {
  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  it("sends a request, lists it as pending for both sides, then accepts it", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice");
    const bob = await registerAndGetCookie(server, "bob");

    const sendRes = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "bob" },
      cookies: alice.cookies,
    });
    expect(sendRes.statusCode).toBe(200);

    const aliceList = await server.inject({
      method: "GET",
      url: "/api/contacts",
      cookies: alice.cookies,
    });
    expect(aliceList.json().pending).toHaveLength(1);
    expect(aliceList.json().pending[0].username).toBe("bob");

    const bobList = await server.inject({
      method: "GET",
      url: "/api/contacts",
      cookies: bob.cookies,
    });
    expect(bobList.json().pending).toHaveLength(1);

    const contactId = aliceList.json().pending[0].id;
    const acceptRes = await server.inject({
      method: "POST",
      url: `/api/contacts/${contactId}/accept`,
      cookies: bob.cookies,
    });
    expect(acceptRes.statusCode).toBe(200);

    const aliceAfter = await server.inject({
      method: "GET",
      url: "/api/contacts",
      cookies: alice.cookies,
    });
    expect(aliceAfter.json().accepted).toHaveLength(1);
    expect(aliceAfter.json().pending).toHaveLength(0);
  });

  it("rejects accept from someone who isn't the request's recipient", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice2");
    const bob = await registerAndGetCookie(server, "bob2");
    // A genuinely different logged-in user (her own real session, not a
    // spoofable header) attempting to accept alice's request to bob.
    const carol = await registerAndGetCookie(server, "carol2");

    const sendRes = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "bob2" },
      cookies: alice.cookies,
    });
    const contactId = sendRes.json().id;

    const acceptRes = await server.inject({
      method: "POST",
      url: `/api/contacts/${contactId}/accept`,
      cookies: carol.cookies,
    });
    expect(acceptRes.statusCode).toBe(403);
  });

  it("lets either party reject a pending request", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice3");
    const bob = await registerAndGetCookie(server, "bob3");

    const sendRes = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "bob3" },
      cookies: alice.cookies,
    });
    const contactId = sendRes.json().id;

    // The recipient (bob) rejects their own incoming request.
    const rejectRes = await server.inject({
      method: "POST",
      url: `/api/contacts/${contactId}/reject`,
      cookies: bob.cookies,
    });
    expect(rejectRes.statusCode).toBe(200);

    const aliceAfter = await server.inject({
      method: "GET",
      url: "/api/contacts",
      cookies: alice.cookies,
    });
    expect(aliceAfter.json().pending).toHaveLength(0);
    expect(aliceAfter.json().accepted).toHaveLength(0);
  });

  it("requires authentication for every contacts route", async () => {
    const server = buildServer();
    const noSession = await server.inject({ method: "GET", url: "/api/contacts" });
    expect(noSession.statusCode).toBe(403);

    const noSessionSend = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "nobody" },
    });
    expect(noSessionSend.statusCode).toBe(403);
  });
});
