// apps/api/src/routes/links.ts
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  CreateLinkRequest,
  CreateLinkResponse,
  CreateCustomLinkRequest,
  CreateRequestLinkRequest,
  CreateRequestLinkResponse,
  ClaimLinkRequest,
  ListDropsResponse,
  ListLinksResponse,
} from "@e2ee-drop/shared";
import { prisma, Prisma } from "@e2ee-drop/db";
import {
  createOneTimeLink,
  deleteLinkIfExists,
  generateAnonymousSlug,
  getLinkBySlug,
  isLinkExpired,
  isLinkInactive,
  isSenderInitiatedReceiveCapability,
  toDropSummary,
  toLinkStatusResponse,
  toLinkSummary,
} from "../lib/links";
import { hasAcceptedContact, hasBlockRelationship } from "../lib/contacts";
import { deleteObject } from "../lib/storage";
import { deleteLinkReleasingQuota } from "../lib/quota";
import { resolveLocale, deriveCodewords } from "../lib/codewords";
import { resolveRetentionDays } from "../lib/retention";
import { emitDropEvent } from "../lib/dropEvents";
import { env } from "../env";

export function registerLinkRoutes(server: FastifyInstance): void {
  server.post<{ Body: CreateLinkRequest }>(
    "/api/links",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            recipientPublicKey: { type: "string" },
            locale: { type: ["string", "null"] },
            ownerNote: { type: ["string", "null"] },
            retentionDays: { type: ["integer", "null"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { recipientPublicKey, locale, ownerNote, retentionDays } = request.body;
      if (!recipientPublicKey) {
        return reply.status(400).send({ error: "Missing recipientPublicKey" });
      }
      // A one-time link's own expiry is fixed by LINK_EXPIRY_HOURS; resolve retentionDays
      // against that same window before the link is created (createOneTimeLink no longer
      // accepts an out-of-range value implicitly, since Link.retentionDays is NOT NULL).
      const provisionalExpiresAt = new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000);
      const resolvedRetention = resolveRetentionDays(retentionDays, provisionalExpiresAt);
      if (typeof resolvedRetention !== "number") {
        return reply.status(400).send(resolvedRetention);
      }
      const link = await createOneTimeLink(recipientPublicKey, resolvedRetention, locale, ownerNote ?? undefined);
      // One-time links always have an expiry (createOneTimeLink sets it); only
      // permanent links, which this route doesn't create, have a null expiresAt.
      if (!link.expiresAt) throw new Error("one-time link created without expiresAt");
      // link.recipientPublicKey is guaranteed non-null here: it was just
      // created from the request's checked-truthy recipientPublicKey above
      // (the `if (!recipientPublicKey)` guard), so this can never be an
      // unclaimed link — the `? : []` mirrors lib/links.ts's toLinkStatusResponse.
      const body: CreateLinkResponse = {
        linkId: link.id,
        slug: link.slug,
        codewords: link.recipientPublicKey
          ? deriveCodewords(link.recipientPublicKey, link.id, resolveLocale(link.codewordLocale), env.CODEWORD_WORD_COUNT)
          : [],
        expiresAt: link.expiresAt.getTime(),
      };
      return reply.send(body);
    }
  );

  const SLUG_PATTERN = /^[a-z0-9-]{3,32}$/;

  // Lets a logged-in user create an additional named link beyond their
  // default one (Plan 3, Task 5). Unlike the default link created at
  // registration (createDefaultLinkForUser), the slug here is caller-chosen,
  // so it must be validated and its uniqueness enforced explicitly.
  server.post<{ Body: CreateCustomLinkRequest }>(
    "/api/links/custom",
    {
      preHandler: server.requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            slug: { type: "string" },
            mode: { type: "string" },
            visibility: { type: ["string", "null"] },
            retentionDays: { type: ["integer", "null"] },
            ownerNote: { type: ["string", "null"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { slug, mode, visibility, retentionDays } = request.body;
      if (!slug || !SLUG_PATTERN.test(slug)) {
        return reply.status(400).send({ error: "Slug must be 3-32 lowercase letters, digits, or hyphens" });
      }
      if (mode !== "permanent" && mode !== "one-time") {
        return reply.status(400).send({ error: "Invalid mode" });
      }
      // Link.visibility is a free String column and the upload route only
      // restricts senders when it is exactly "contacts-only", so an unchecked
      // typo ("contacts_only") would silently create a public link — failing
      // open. Only the two known values are accepted; omitted means public.
      if (visibility !== undefined && visibility !== "public" && visibility !== "contacts-only") {
        return reply.status(400).send({ error: "Invalid visibility" });
      }
      // A one-time custom link's own expiry is fixed by LINK_EXPIRY_HOURS, exactly like
      // the anonymous POST /api/links route above; a permanent link has no expiry ceiling.
      const provisionalExpiresAt =
        mode === "one-time" ? new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000) : null;
      const resolvedRetention = resolveRetentionDays(retentionDays, provisionalExpiresAt);
      if (typeof resolvedRetention !== "number") {
        return reply.status(400).send(resolvedRetention);
      }

      const owner = await prisma.user.findUnique({ where: { id: request.user!.id } });
      if (!owner) return reply.status(404).send({ error: "User not found" });

      if (!owner.emailVerified) {
        return reply.status(403).send({ error: "Verify your email address before creating a link" });
      }

      // No pre-check findUnique({ where: { slug } }) here: Link.slug is a
      // plain @unique column (schema.prisma), not a per-owner composite key,
      // so the create() below is the single, race-safe source of truth for
      // "is this slug taken" — a separate pre-check would leave a TOCTOU gap
      // between the check and the create. Catching P2002 on create both
      // avoids that gap and covers every collision (this owner's own prior
      // link, a different owner's link, or an anonymous link) in one place.
      let link;
      try {
        link = await prisma.link.create({
          data: {
            ownerId: owner.id,
            slug,
            mode,
            visibility: visibility ?? "public",
            retentionDays: resolvedRetention,
            ownerNote: request.body.ownerNote ?? undefined,
            recipientPublicKey: owner.publicKey,
            expiresAt: provisionalExpiresAt,
          },
        });
      } catch (error: unknown) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          // Slug is globally unique (not scoped to this owner), so the
          // collision may be with a different owner's link, or an anonymous
          // one — never assume it must be this owner's own prior link.
          return reply.status(409).send({ error: "This slug is already taken" });
        }
        throw error;
      }

      // link.recipientPublicKey is guaranteed non-null here: it was just
      // created from owner.publicKey (a required, non-null User column) above,
      // so this can never be an unclaimed link — the `? : []` mirrors
      // lib/links.ts's toLinkStatusResponse.
      const body: CreateLinkResponse = {
        linkId: link.id,
        slug: link.slug,
        codewords: link.recipientPublicKey
          ? deriveCodewords(link.recipientPublicKey, link.id, resolveLocale(link.codewordLocale), env.CODEWORD_WORD_COUNT)
          : [],
        // Only one-time custom links have a real expiry; a permanent one's
        // expiresAt is null forever, so it's omitted rather than reported as
        // a fake epoch-0 "already expired" timestamp.
        ...(link.expiresAt ? { expiresAt: link.expiresAt.getTime() } : {}),
      };
      return reply.send(body);
    }
  );

  // Design spec §4.1: the initiator here becomes the link's owner and therefore the party
  // charged for quota once content flows (lib/quota.ts already keys everything off
  // Link.ownerId, unchanged by this endpoint) — the eventual recipient is unknown at creation
  // time and supplies their own key later via /claim (Task 13).
  server.post<{ Body: CreateRequestLinkRequest }>(
    "/api/links/request",
    {
      preHandler: server.requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            ownerNote: { type: ["string", "null"] },
            retentionDays: { type: ["integer", "null"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { ownerNote, retentionDays } = request.body ?? {};
      const resolvedRetention = resolveRetentionDays(retentionDays, null); // permanent by default
      if (typeof resolvedRetention !== "number") {
        return reply.status(400).send(resolvedRetention);
      }

      const owner = await prisma.user.findUnique({ where: { id: request.user!.id } });
      if (!owner) return reply.status(404).send({ error: "User not found" });

      // Same gate as POST /api/links/custom, for the same reason: this route
      // also creates an owned link. Without it, an unverified user could
      // create a request link that immediately became unclaimable/invisible
      // anyway — isLinkInactive's owner-emailVerified check (added alongside
      // this gate, see /custom above) 404s GET /:slug and POST /:slug/claim
      // for any owned link whose owner isn't verified, request links
      // included, so a request link created here without this check would be
      // dead on arrival rather than merely restricted at creation time.
      if (!owner.emailVerified) {
        return reply.status(403).send({ error: "Verify your email address before creating a link" });
      }

      const link = await prisma.link.create({
        data: {
          ownerId: request.user!.id,
          slug: generateAnonymousSlug(),
          mode: "permanent",
          visibility: "public",
          retentionDays: resolvedRetention,
          ownerNote: ownerNote ?? undefined,
          recipientPublicKey: null,
        },
      });
      const body: CreateRequestLinkResponse = { slug: link.slug };
      return reply.send(body);
    }
  );

  // Design spec §4.2: no auth required (anonymous claim is allowed, generating a local keypair
  // exactly like the existing anonymous CreateLinkPage flow — plan 3 builds that UI). The CAS is
  // the whole safety property: two concurrent claims can never both win, and an already-claimed
  // link (from either flow — recipient-initiated links always have a key from creation) cannot be
  // re-claimed.
  server.post<{ Params: { slug: string }; Body: ClaimLinkRequest }>(
    "/api/links/:slug/claim",
    {
      schema: {
        body: {
          type: "object",
          properties: { recipientPublicKey: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { recipientPublicKey } = request.body ?? {};
      if (!recipientPublicKey) return reply.status(400).send({ error: "Missing recipientPublicKey" });

      const link = await getLinkBySlug(request.params.slug);
      if (!link || (await isLinkInactive(link))) return reply.status(404).send({ error: "Link not found" });

      const { count } = await prisma.link.updateMany({
        where: { id: link.id, recipientPublicKey: null },
        data: { recipientPublicKey },
      });
      if (count !== 1) return reply.status(409).send({ error: "This link has already been claimed" });
      // Design spec §4.2: lets /send/:slug (the initiator's page, subscribed via
      // GET /api/links/:slug/events — owner-gated, so only the initiator hears
      // this) detect the claim over the existing per-link SSE channel instead of
      // polling. Emitted only after the CAS above actually won.
      emitDropEvent(link.id, { type: "link-claimed", recipientPublicKey });
      return reply.send({ claimed: true });
    }
  );

  // List-mine (dashboard/unified-inbox plan, Task 3). Must not be shadowed by
  // the parameterized GET below: Fastify matches static/literal routes before
  // parameterized ones regardless of declaration order, but this is placed
  // here to keep related routes visually grouped.
  server.get("/api/links", { preHandler: server.requireAuth }, async (request, reply) => {
    const links = await prisma.link.findMany({
      where: { ownerId: request.user!.id },
      orderBy: { createdAt: "asc" },
    });
    const body: ListLinksResponse = { links: links.map(toLinkSummary) };
    return reply.send(body);
  });

  server.get<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    // Expired/revoked/unverified-owner links are treated as gone but deliberately
    // NOT deleted here: the cleanup job is the only place that deletes expired
    // links, because it deletes each drop's storage object before the row.
    // Deleting the row lazily here would lose the s3Key and orphan the object in
    // storage forever.
    if (await isLinkInactive(link)) return reply.status(404).send({ error: "Link not found" });
    const requesterId = request.user?.id;
    const isOwner = requesterId !== undefined && requesterId === link.ownerId;
    // A block relationship overrides visibility entirely — a blocked party
    // must see the same "not found" as a genuinely nonexistent link,
    // regardless of whether the link is public or contacts-only. This must
    // run before/independent of the contacts-only check below, since it
    // also applies to public links.
    if (!isOwner && requesterId !== undefined && link.ownerId !== null) {
      if (await hasBlockRelationship(link.ownerId, requesterId)) {
        return reply.status(404).send({ error: "Link not found" });
      }
    }
    if (link.visibility === "contacts-only") {
      const isContact =
        !isOwner && requesterId !== undefined && link.ownerId !== null && (await hasAcceptedContact(link.ownerId, requesterId));
      if (!isOwner && !isContact) return reply.status(404).send({ error: "Link not found" });
    }
    return reply.send(await toLinkStatusResponse(link, request.user?.id));
  });

  // Owner-only queue listing (Plan 3, Task 6). Returns every non-downloaded drop
  // for the link, oldest first — the initial snapshot the frontend queue view
  // (Task 12) renders before SSE takes over. getLinkBySlug's `include: { drops:
  // true }` has no `take`/restrictive `where`, so link.drops already holds the
  // full set of drops regardless of status; the filtering and ordering below is
  // done in JS rather than pushed into the query.
  server.get<{ Params: { slug: string } }>(
    "/api/links/:slug/drops",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (link.ownerId !== request.user!.id) return reply.status(403).send({ error: "Forbidden" });

      const drops = link.drops
        .filter((drop) => drop.fileEnvelopeStatus !== "delivered" && drop.fileEnvelopeStatus !== "shredded")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      const body: ListDropsResponse = { drops: drops.map((drop) => toDropSummary(drop, link)) };
      return reply.send(body);
    }
  );

  // Receive-side signal (design spec §6.1). This replaces a spoofable
  // `?role=receiver` query param on the shared GET above: any client can
  // call this, so it's still not cryptographic proof of receipt, but it
  // narrows the surface from "flip a param on any GET" to "call the one
  // endpoint whose entire purpose is this action". No-op for a NORMAL owned
  // link — that queue's delivery state is spec 5's concern (GET .../drops).
  // Acts for an anonymous link (as before) and now also for a claimed
  // sender-initiated link's non-owner caller (the claimant) — see
  // isSenderInitiatedReceiveCapability in lib/links.ts for why the
  // initiator/owner themselves must still be excluded even there.
  server.post<{ Params: { slug: string } }>(
    "/api/links/:slug/mark-receiver-opened",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      if (link.ownerId === null || (await isSenderInitiatedReceiveCapability(link, request.user?.id))) {
        const drop = link.drops[0];
        if (drop) {
          await prisma.drop.updateMany({
            where: { id: drop.id, linkId: link.id, deliveryStatus: "sent" },
            data: { deliveryStatus: "receiver_opened" },
          });
        }
      }
      return reply.send({ acknowledged: true });
    }
  );

  // Send-side signal (spec 1 plan 3 Task 11 / Task 5 of the delivery-lifecycle-
  // retention plan). Symmetric counterpart to mark-receiver-opened above, but
  // deliberately simpler: unconditional overwrite of Link.lastSenderOpenedAt
  // on every call, no CAS and no deliveryStatus check. This is pure
  // informational telemetry ("when did the sender last look at this link's
  // page") with no downstream effect on the burn/envelope state machine, so
  // every visit is meaningful, not just the first. No auth required, no body.
  server.post<{ Params: { slug: string } }>(
    "/api/links/:slug/mark-sender-opened",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
      await prisma.link.updateMany({ where: { id: link.id }, data: { lastSenderOpenedAt: new Date() } });
      return reply.send({ acknowledged: true });
    }
  );

  server.delete<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    // This route is unauthenticated: knowing an anonymous link's random slug is
    // the only capability it checks, which is what Plan 1 designed it for. An
    // owned link's slug is NOT a secret (a user's default link slug is their
    // username), so the slug alone must never authorize deleting it — owned
    // links, and default links in particular (spec §5: non-deletable), can
    // only ever be removed through an authenticated owner path (Plan 3).
    //
    // KNOWN, ACCEPTED TRADE-OFF (security review SEC10): for an anonymous
    // link, anyone who has seen the slug, including a bystander, can delete it.
    // Deliberate. The slug is the only credential an ownerless link has, and a
    // bystander can already sabotage the exchange by taking its single upload
    // slot first. Content stays E2EE either way. See spec §5.1 for the
    // rationale and for the creator "manage token" design to adopt if this
    // route ever needs to be restricted to the link's creator.
    if (link.ownerId !== null) {
      if (link.ownerId !== request.user?.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      // Spec §5: a user's default link is non-deletable.
      if (link.isDefault) {
        return reply.status(403).send({ error: "The default link cannot be deleted" });
      }
      // Owner-initiated delete of their own link. The Link row (and, by cascade, every
      // Drop row) is hard-deleted in this same request, so scrubbing first would add
      // nothing but a race window. Storage objects first (same order as the anonymous
      // branch below), skipping drops whose object is already gone (file envelope
      // terminal). Then deleteLinkReleasingQuota: it row-locks the owner and the Link
      // (blocking a concurrent drop insert or /complete from racing the delete) and
      // releases quota from its atomic DELETE ... RETURNING — only for drops still
      // charged, i.e. whose file side was not already delivered/shredded (their charge
      // was released when that terminal transition happened).
      for (const drop of link.drops) {
        if (drop.fileEnvelopeStatus !== "delivered" && drop.fileEnvelopeStatus !== "shredded") {
          await deleteObject(drop.s3Key);
        }
      }
      await deleteLinkReleasingQuota(link);
      return reply.send({ deleted: true });
    }
    // Same order as runCleanup (jobs/cleanup.ts): storage objects first, then the
    // row. If a storage delete throws, the row (and thus the s3Key) survives, so the
    // delete can be retried or the cleanup job can still find it once expired.
    for (const drop of link.drops) {
      await deleteObject(drop.s3Key);
    }
    await deleteLinkIfExists(link.id);
    return reply.send({ deleted: true });
  });

  async function requireOwnedLink(slug: string, userId: string, reply: FastifyReply) {
    const link = await getLinkBySlug(slug);
    if (!link) {
      reply.status(404).send({ error: "Link not found" });
      return null;
    }
    if (link.ownerId !== userId) {
      reply.status(403).send({ error: "Forbidden" });
      return null;
    }
    return link;
  }

  server.post<{ Params: { slug: string } }>(
    "/api/links/:slug/revoke",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const link = await requireOwnedLink(request.params.slug, request.user!.id, reply);
      if (!link) return;
      await prisma.link.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
      // NOTE (see plan self-review / spec §3.1): shredding this link's still-
      // sealed/delivery_failed drops on revoke is spec 2's job (owner-cancel
      // mechanism) and is intentionally NOT done here — spec 2's plan should
      // add that call once its shred function exists. Revoke here only makes
      // the link stop being servable; it does not touch existing drops.
      return reply.send({ revoked: true });
    }
  );

  server.post<{ Params: { slug: string } }>(
    "/api/links/:slug/unrevoke",
    { preHandler: server.requireAuth },
    async (request, reply) => {
      const link = await requireOwnedLink(request.params.slug, request.user!.id, reply);
      if (!link) return;
      await prisma.link.update({ where: { id: link.id }, data: { revokedAt: null } });
      return reply.send({ revoked: false });
    }
  );

  server.patch<{ Params: { slug: string }; Body: { visibility?: string } }>(
    "/api/links/:slug",
    {
      preHandler: server.requireAuth,
      schema: { body: { type: "object", properties: { visibility: { type: "string" } } } },
    },
    async (request, reply) => {
      const link = await requireOwnedLink(request.params.slug, request.user!.id, reply);
      if (!link) return;
      const { visibility } = request.body;
      if (visibility !== "public" && visibility !== "contacts-only") {
        return reply.status(400).send({ error: "Invalid visibility" });
      }
      await prisma.link.update({ where: { id: link.id }, data: { visibility } });
      return reply.send({ visibility });
    }
  );
}
