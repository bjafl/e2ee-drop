// apps/api/src/routes/inbox.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { buildServer } from "../server";
import { ownerListenerCount } from "../lib/dropEvents";

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

describe("GET /api/inbox", () => {
  it("requires authentication", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(403);
  });

  it("returns an empty list for a user with no drops", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-inbox-route");
    const response = await server.inject({ method: "GET", url: "/api/inbox", cookies: alice.cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ counterparties: [] });
  });
});

describe("GET /api/inbox/events", () => {
  it("requires authentication", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/inbox/events" });
    expect(response.statusCode).toBe(403);
  });

  // Full SSE payload delivery is exercised end-to-end in events.test.ts's
  // equivalent per-link test; this pins only that the route wires the right
  // owner id into subscribeToOwner, using the exported listener-count probe
  // the same way dropEvents.test.ts's own suite does.
  it("subscribes to the caller's own ownerId channel", async () => {
    const server = buildServer();
    const bob = await registerAndGetCookie(server, "bob-inbox-events");
    expect(ownerListenerCount(bob.userId)).toBe(0);

    // light-my-request's inject() promise only settles once the response
    // finishes or is destroyed — an SSE route never calls end(), so without
    // payloadAsStream: true it would await forever. With it, the promise
    // resolves as soon as the handler calls reply.raw.writeHead() (headers
    // sent), exactly like a browser's fetch() resolving on response headers
    // while the SSE body keeps streaming — so this settles well before the
    // 20ms wait below, and the final await is a formality, not a hang risk.
    const injectPromise = server.inject({
      method: "GET",
      url: "/api/inbox/events",
      cookies: bob.cookies,
      payload: undefined,
      payloadAsStream: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the handler reach subscribeToOwner
    expect(ownerListenerCount(bob.userId)).toBe(1);

    await injectPromise.then(() => {});
  });
});
