// apps/api/src/routes/links.ts
import type { FastifyInstance } from "fastify";
import type {
  CreateLinkRequest,
  CreateLinkResponse,
  CreateCustomLinkRequest,
  ListDropsResponse,
} from "@e2ee-drop/shared";
import { prisma, Prisma } from "@e2ee-drop/db";
import {
  createOneTimeLink,
  deleteLinkIfExists,
  getLinkBySlug,
  isLinkExpired,
  toDropSummary,
  toLinkStatusResponse,
} from "../lib/links";
import { deleteObject } from "../lib/storage";
import { resolveLocale, deriveCodewords, CODEWORD_MAX_COUNT } from "../lib/codewords";
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
          },
        },
      },
    },
    async (request, reply) => {
      const { recipientPublicKey, locale } = request.body;
      if (!recipientPublicKey) {
        return reply.status(400).send({ error: "Missing recipientPublicKey" });
      }
      // @ts-expect-error — rewritten in plan 2
      const link = await createOneTimeLink(recipientPublicKey, locale);
      // One-time links always have an expiry (createOneTimeLink sets it); only
      // permanent links, which this route doesn't create, have a null expiresAt.
      if (!link.expiresAt) throw new Error("one-time link created without expiresAt");
      const body: CreateLinkResponse = {
        linkId: link.id,
        slug: link.slug,
        // @ts-expect-error — rewritten in plan 2
        codewords: deriveCodewords(link.recipientPublicKey, resolveLocale(link.codewordLocale), CODEWORD_MAX_COUNT),
        expiresAt: link.expiresAt.getTime(),
      };
      return reply.send(body);
    }
  );

  const SLUG_PATTERN = /^[a-z0-9-]{3,32}$/;
  const MAX_RETENTION_DAYS = 2_147_483_647; // Link.retentionDays is a Postgres int4

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
      // Omitted/null means "use the global DROP_RETENTION_DAYS default" (see
      // sweepExpiredDrops in jobs/cleanup.ts) — there is no "keep forever"
      // option. Otherwise a whole number of
      // days, at least 1, and within Postgres's 32-bit Int column range so an
      // oversized value is a 400 rather than a database error.
      if (
        retentionDays !== undefined &&
        retentionDays !== null &&
        !(Number.isSafeInteger(retentionDays) && retentionDays >= 1 && retentionDays <= MAX_RETENTION_DAYS)
      ) {
        return reply.status(400).send({ error: "Invalid retentionDays" });
      }

      const owner = await prisma.user.findUnique({ where: { id: request.user!.id } });
      if (!owner) return reply.status(404).send({ error: "User not found" });

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
            // @ts-expect-error — rewritten in plan 2
            retentionDays: retentionDays ?? null,
            recipientPublicKey: owner.publicKey,
            expiresAt:
              mode === "one-time" ? new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000) : null,
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

      const body: CreateLinkResponse = {
        linkId: link.id,
        slug: link.slug,
        // @ts-expect-error — rewritten in plan 2
        codewords: deriveCodewords(link.recipientPublicKey, resolveLocale(link.codewordLocale), CODEWORD_MAX_COUNT),
        // Only one-time custom links have a real expiry; a permanent one's
        // expiresAt is null forever, so it's omitted rather than reported as
        // a fake epoch-0 "already expired" timestamp.
        ...(link.expiresAt ? { expiresAt: link.expiresAt.getTime() } : {}),
      };
      return reply.send(body);
    }
  );

  server.get<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    // Expired links are treated as gone but deliberately NOT deleted here: the
    // cleanup job is the only place that deletes expired links, because it deletes
    // each drop's storage object before the row. Deleting the row lazily here would
    // lose the s3Key and orphan the object in storage forever.
    if (isLinkExpired(link)) return reply.status(404).send({ error: "Link not found" });
    return reply.send(await toLinkStatusResponse(link));
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
        // @ts-expect-error — rewritten in plan 2
        .filter((drop) => drop.status !== "downloaded")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // @ts-expect-error — rewritten in plan 2
      const body: ListDropsResponse = { drops: drops.map(toDropSummary) };
      return reply.send(body);
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
      return reply.status(403).send({ error: "Owned links cannot be deleted through this endpoint" });
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
}
