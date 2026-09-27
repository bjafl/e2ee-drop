// apps/api/src/routes/events.test.ts
//
// Rejections (404/403) are answered before the route hijacks the response, so
// they're exercised with plain .inject(). The success path is a never-ending
// SSE stream, which .inject() can't observe incrementally, so those tests
// start a real listener on an ephemeral port and read the stream over HTTP.
//
// Authenticated requests use a REAL registered user's session cookie (see
// links.test.ts / contacts.test.ts) — there is no fake user-id header.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";
import type { DropSummary } from "@e2ee-drop/shared";
import { buildServer } from "../server";
import { emitDropEvent, linkListenerCount } from "../lib/dropEvents";
import { SSE_HEARTBEAT_INTERVAL_MS } from "./events";

const drop: DropSummary = {
  id: "drop1",
  fileUploadStatus: "complete",
  deliveryStatus: "sent",
  messageEnvelopeStatus: "sealed",
  fileEnvelopeStatus: "sealed",
  senderPublicKey: "x",
  archiveNonce: "x",
  contentMD5: "x",
  encryptedMetadata: "x",
  metadataNonce: "x",
  hasMessage: false,
  contentExpiresAt: 0,
};

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
  return { value: cookie.value, cookies: { e2ee_drop_session: cookie.value } };
}

interface OpenStream {
  statusCode: number;
  contentType: string | undefined;
  headers: http.IncomingHttpHeaders;
  // Resolves with everything received so far once `text` appears in the stream.
  waitFor: (text: string) => Promise<string>;
  close: () => void;
}

function openStream(port: number, path: string, sessionCookie?: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: sessionCookie ? { cookie: `e2ee_drop_session=${sessionCookie}` } : {},
      },
      (res) => {
        let received = "";
        const waiters: Array<{ text: string; done: (value: string) => void }> = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          received += chunk;
          for (const waiter of [...waiters]) {
            if (received.includes(waiter.text)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.done(received);
            }
          }
        });
        resolve({
          statusCode: res.statusCode ?? 0,
          contentType: res.headers["content-type"],
          headers: res.headers,
          waitFor: (text) =>
            received.includes(text)
              ? Promise.resolve(received)
              : new Promise((done) => waiters.push({ text, done })),
          close: () => req.destroy(),
        });
      }
    );
    req.on("error", (error) => {
      // Destroying the request ourselves surfaces as ECONNRESET; ignore that.
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
  });
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(condition()).toBe(true);
}

describe("SSE events route", () => {
  let server: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    server = buildServer();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
  });

  it("returns 404 for an unknown link", async () => {
    const response = await server.inject({ method: "GET", url: "/api/links/does-not-exist/events" });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an expired link", async () => {
    await prisma.link.create({
      data: { slug: "expired-sse", mode: "one-time", recipientPublicKey: "x", retentionDays: 7, expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await server.inject({ method: "GET", url: "/api/links/expired-sse/events" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects an unauthenticated subscriber to an owned link's events", async () => {
    await registerAndGetCookie(server, "sseowner");

    const response = await server.inject({ method: "GET", url: "/api/links/sseowner/events" });

    expect(response.statusCode).toBe(403);
  });

  it("rejects another authenticated user subscribing to an owned link's events", async () => {
    await registerAndGetCookie(server, "sseowner");
    const intruder = await registerAndGetCookie(server, "intruder");

    const response = await server.inject({
      method: "GET",
      url: "/api/links/sseowner/events",
      cookies: intruder.cookies,
    });

    expect(response.statusCode).toBe(403);
  });

  it("allows a claimed sender-initiated request link's non-owner claimant to open the connection", async () => {
    const initiator = await registerAndGetCookie(server, "sseinitiator");
    const requestRes = await server.inject({
      method: "POST",
      url: "/api/links/request",
      payload: {},
      cookies: initiator.cookies,
    });
    const { slug } = requestRes.json();
    await server.inject({
      method: "POST",
      url: `/api/links/${slug}/claim`,
      payload: { recipientPublicKey: "claimant-pubkey" },
    });
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.server.address() as AddressInfo;

    // The claimant has no session at all here (an anonymous claim) — the slug
    // itself is the receive capability, same trust model as an anonymous link.
    const stream = await openStream(port, `/api/links/${slug}/events`);
    expect(stream.statusCode).toBe(200);
    await stream.waitFor(": connected");

    stream.close();
    await waitUntil(() => linkListenerCount(link.id) === 0);
  });

  it("still allows the initiator/owner themselves to open a claimed request link's connection", async () => {
    const initiator = await registerAndGetCookie(server, "sseinitiator2");
    const requestRes = await server.inject({
      method: "POST",
      url: "/api/links/request",
      payload: {},
      cookies: initiator.cookies,
    });
    const { slug } = requestRes.json();
    await server.inject({
      method: "POST",
      url: `/api/links/${slug}/claim`,
      payload: { recipientPublicKey: "claimant-pubkey" },
    });
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.server.address() as AddressInfo;

    const stream = await openStream(port, `/api/links/${slug}/events`, initiator.value);
    expect(stream.statusCode).toBe(200);
    await stream.waitFor(": connected");

    stream.close();
    await waitUntil(() => linkListenerCount(link.id) === 0);
  });

  it("streams events to an unauthenticated subscriber of an anonymous link", async () => {
    const createRes = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50" },
    });
    const { slug } = createRes.json();
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.server.address() as AddressInfo;

    const stream = await openStream(port, `/api/links/${slug}/events`);
    expect(stream.statusCode).toBe(200);
    expect(stream.contentType).toContain("text/event-stream");
    await stream.waitFor(": connected");

    emitDropEvent(link.id, { type: "drop-created", drop });
    const received = await stream.waitFor("data: ");
    expect(received).toContain(`data: ${JSON.stringify({ type: "drop-created", drop })}\n\n`);

    stream.close();
    await waitUntil(() => linkListenerCount(link.id) === 0);
  });

  it("streams an owned link's events to its owner, and cleans up each connection independently", async () => {
    const owner = await registerAndGetCookie(server, "sseowner");
    const link = (await prisma.link.findUnique({ where: { slug: "sseowner" } }))!;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.server.address() as AddressInfo;

    // Two tabs open on the same link.
    const tabA = await openStream(port, "/api/links/sseowner/events", owner.value);
    const tabB = await openStream(port, "/api/links/sseowner/events", owner.value);
    expect(tabA.statusCode).toBe(200);
    expect(tabB.statusCode).toBe(200);
    await tabA.waitFor(": connected");
    await tabB.waitFor(": connected");
    expect(linkListenerCount(link.id)).toBe(2);

    // Closing one tab removes only its listener; the other keeps receiving, once.
    tabA.close();
    await waitUntil(() => linkListenerCount(link.id) === 1);
    emitDropEvent(link.id, { type: "drop-updated", drop });
    const received = await tabB.waitFor("data: ");
    expect(received.split("data: ").length - 1).toBe(1);

    tabB.close();
    await waitUntil(() => linkListenerCount(link.id) === 0);
  });

  it("disables proxy buffering and sends heartbeats until the client disconnects", async () => {
    const createRes = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50" },
    });
    const { slug } = createRes.json();
    const link = (await prisma.link.findUnique({ where: { slug } }))!;
    await server.listen({ port: 0, host: "127.0.0.1" });
    const { port } = server.server.address() as AddressInfo;
    // Fake only interval timers: sockets and the waitUntil() polling keep
    // using real time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const stream = await openStream(port, `/api/links/${slug}/events`);
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    await stream.waitFor(": connected");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS);
    const received = await stream.waitFor(": ping");
    expect(received).toContain(": ping\n\n");

    stream.close();
    await waitUntil(() => linkListenerCount(link.id) === 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
