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
  it("returns the intended user-facing message and status for known validation errors", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice4");
    await registerAndGetCookie(server, "bob4");

    const self = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "alice4" },
      cookies: alice.cookies,
    });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toEqual({ error: "Cannot add yourself as a contact" });

    const unknown = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "nobody-by-this-name" },
      cookies: alice.cookies,
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "User not found" });

    const first = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "bob4" },
      cookies: alice.cookies,
    });
    expect(first.statusCode).toBe(200);
    const duplicate = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: "bob4" },
      cookies: alice.cookies,
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toEqual({ error: "A contact relationship already exists" });

    const missing = await server.inject({
      method: "POST",
      url: "/api/contacts/no-such-contact-id/accept",
      cookies: alice.cookies,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Contact request not found" });
  });

  it("does not leak internal error details when an unexpected (Prisma) error is thrown", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice5");

    // No `username` in the body: the handler passes `undefined` straight into
    // prisma.user.findUnique, which throws a PrismaClientValidationError whose
    // message includes the source file path, line number and query snippet.
    // Before the global error handler this was echoed to the client verbatim.
    const response = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: {},
      cookies: alice.cookies,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    expect(response.body).not.toMatch(/prisma|findUnique|\.ts|\/home\/|invocation/i);
  });

  it("rejects a numeric username with 400 (not a Prisma crash) via the route's JSON-schema body validation", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice6");

    const response = await server.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { username: 12345 },
      cookies: alice.cookies,
    });
    expect(response.statusCode).toBe(400);
  });

  it("blocks an incoming pending request, and the blocked party sees the same error as a nonexistent user on retry", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-block");
    const bob = await registerAndGetCookie(server, "bob-block");

    const req = await server.inject({ method: "POST", url: "/api/contacts", cookies: bob.cookies, payload: { username: "alice-block" } });
    const block = await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/block`, cookies: alice.cookies });
    expect(block.statusCode).toBe(200);

    const retry = await server.inject({ method: "POST", url: "/api/contacts", cookies: bob.cookies, payload: { username: "alice-block" } });
    const baseline = await server.inject({ method: "POST", url: "/api/contacts", cookies: bob.cookies, payload: { username: "does-not-exist" } });
    expect(retry.statusCode).toBe(baseline.statusCode);
    expect(retry.json()).toEqual(baseline.json());
  });

  it("hides a blocked row from the blocked party's own contact list", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-block2");
    const bob = await registerAndGetCookie(server, "bob-block2");
    const req = await server.inject({ method: "POST", url: "/api/contacts", cookies: bob.cookies, payload: { username: "alice-block2" } });
    await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/block`, cookies: alice.cookies });

    const bobsList = await server.inject({ method: "GET", url: "/api/contacts", cookies: bob.cookies });
    const all = [...bobsList.json().pending, ...bobsList.json().accepted];
    expect(all.find((c: { username: string }) => c.username === "alice-block2")).toBeUndefined();

    const alicesList = await server.inject({ method: "GET", url: "/api/contacts", cookies: alice.cookies });
    expect(alicesList.statusCode).toBe(200);
    // The blocker CAN still see the block, via its own `blocked` array.
    expect(alicesList.json().blocked).toHaveLength(1);
    expect(alicesList.json().blocked[0].username).toBe("bob-block2");
    expect(alicesList.json().blocked[0].status).toBe("blocked");
  });

  it("resolves a same-direction concurrent double-submit to exactly one row (pre-existing TOCTOU, fixed here)", async () => {
    // sendContactRequest's `findFirst` existing-relationship check and its
    // `create` are not atomic — two requests racing between the check and the
    // create could otherwise both see "no existing row" and both attempt to
    // create one. Contact's `@@unique([userId, contactUserId])` constraint
    // only spans this exact (userId, contactUserId) ordering, so this test
    // (and the fix) covers the same-direction case: one caller submitting
    // twice in quick succession (double-click, client retry after a timeout).
    // It does NOT cover two different users requesting each other in opposite
    // directions at the same moment — that's a different (userId,
    // contactUserId) tuple each way, so this unique constraint can't catch
    // it; the `findFirst` pre-check (both orderings) is the only guard there,
    // and a sufficiently unlucky race could still produce two rows in that
    // specific cross-direction case. Out of scope for this fix — flagging in
    // case it matters later, not silently claiming full coverage.
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-race");
    const bob = await registerAndGetCookie(server, "bob-race");

    const [first, second] = await Promise.all([
      server.inject({ method: "POST", url: "/api/contacts", cookies: alice.cookies, payload: { username: "bob-race" } }),
      server.inject({ method: "POST", url: "/api/contacts", cookies: alice.cookies, payload: { username: "bob-race" } }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 400]); // one succeeds, one gets the normal "already exists" error — never a 500
    const rows = await prisma.contact.findMany({ where: { userId: alice.userId, contactUserId: bob.userId } });
    expect(rows.length).toBe(1);
  });

  it("blocks from an already-accepted contact, and only the blocker can unblock", async () => {
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-block3");
    const bob = await registerAndGetCookie(server, "bob-block3");
    const req = await server.inject({ method: "POST", url: "/api/contacts", cookies: bob.cookies, payload: { username: "alice-block3" } });
    await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/accept`, cookies: alice.cookies });

    const block = await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/block`, cookies: alice.cookies });
    expect(block.statusCode).toBe(200);

    const bobUnblockAttempt = await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/unblock`, cookies: bob.cookies });
    expect(bobUnblockAttempt.statusCode).toBe(403);

    const aliceUnblock = await server.inject({ method: "POST", url: `/api/contacts/${req.json().id}/unblock`, cookies: alice.cookies });
    expect(aliceUnblock.statusCode).toBe(200);

    const afterUnblock = await prisma.contact.findUnique({ where: { id: req.json().id } });
    expect(afterUnblock).toBeNull();
  });

  it("does not let the blocked party seize the block and escape it via re-block + unblock", async () => {
    // Regression test for a fix found in review: blockContact only checked
    // relationship membership, not who currently holds blockedByUserId. That
    // let the blocked party call /block on the same row to overwrite
    // blockedByUserId to themselves, then call /unblock (now "succeeding")
    // to delete the row and send a fresh request — fully escaping the
    // original block.
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-block4");
    const bob = await registerAndGetCookie(server, "bob-block4");
    const req = await server.inject({ method: "POST", url: "/api/contacts", cookies: bob.cookies, payload: { username: "alice-block4" } });
    const contactId = req.json().id;

    const block = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/block`, cookies: alice.cookies });
    expect(block.statusCode).toBe(200);

    // Bob (the blocked party) tries to seize the block by re-blocking the row himself.
    const bobBlockAttempt = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/block`, cookies: bob.cookies });
    expect(bobBlockAttempt.statusCode).toBe(403);

    // The row must still be blocked by alice, unaffected by bob's attempt.
    const stillBlocked = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(stillBlocked?.status).toBe("blocked");
    expect(stillBlocked?.blockedByUserId).toBe(alice.userId);

    // Bob still can't unblock — he was never recorded as the blocker.
    const bobUnblockAttempt = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/unblock`, cookies: bob.cookies });
    expect(bobUnblockAttempt.statusCode).toBe(403);

    // Re-blocking by alice herself (the party who already holds the block) is a harmless no-op.
    const aliceReblock = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/block`, cookies: alice.cookies });
    expect(aliceReblock.statusCode).toBe(200);
  });

  it("does not let the blocked party escape the block via /reject", async () => {
    // Regression test for a fix found in review: rejectContactRequest only
    // checked relationship membership, not row.status. That let a blocked
    // party call /reject on the blocked row (deleting it), then send a fresh
    // contact request — fully escaping the original block.
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-block5");
    const bob = await registerAndGetCookie(server, "bob-block5");
    const req = await server.inject({ method: "POST", url: "/api/contacts", cookies: bob.cookies, payload: { username: "alice-block5" } });
    const contactId = req.json().id;

    const block = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/block`, cookies: alice.cookies });
    expect(block.statusCode).toBe(200);

    // Bob (the blocked party) tries to escape the block by rejecting (deleting) the row.
    const bobRejectAttempt = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/reject`, cookies: bob.cookies });
    expect(bobRejectAttempt.statusCode).toBe(403);

    // The row must still exist, still blocked by alice, unaffected by bob's attempt.
    const stillBlocked = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(stillBlocked?.status).toBe("blocked");
    expect(stillBlocked?.blockedByUserId).toBe(alice.userId);
  });

  it("does not let the blocked party escape the block via /accept", async () => {
    // Regression test for a fix found in review: acceptContactRequest only
    // checked that the caller is the request's recipient, not row.status. If
    // alice sent bob a request and then blocked him, the row becomes
    // status: "blocked", blockedByUserId: alice, but row.contactUserId is
    // still bob — so bob (still "the recipient") could call /accept to flip
    // status to "accepted" while blockedByUserId stayed stale at alice,
    // turning the block into contacts-only link access for bob.
    const server = buildServer();
    const alice = await registerAndGetCookie(server, "alice-block6");
    const bob = await registerAndGetCookie(server, "bob-block6");
    const req = await server.inject({ method: "POST", url: "/api/contacts", cookies: alice.cookies, payload: { username: "bob-block6" } });
    const contactId = req.json().id;

    const block = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/block`, cookies: alice.cookies });
    expect(block.statusCode).toBe(200);

    // Bob (the blocked party, and the request's original recipient) tries to accept his way out.
    const bobAcceptAttempt = await server.inject({ method: "POST", url: `/api/contacts/${contactId}/accept`, cookies: bob.cookies });
    expect(bobAcceptAttempt.statusCode).toBe(404);

    // The row must be unchanged: still blocked, still pointing at alice as the blocker.
    const stillBlocked = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(stillBlocked?.status).toBe("blocked");
    expect(stillBlocked?.blockedByUserId).toBe(alice.userId);
  });
});
