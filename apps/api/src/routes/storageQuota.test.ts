// apps/api/src/routes/storageQuota.test.ts
//
// Per-user storage quota enforcement (spec §8) across upload-url, /complete,
// and the owner-side deletion paths. Owned links only; anonymous links must
// be entirely unaffected.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

// deleteObject and objectHasSize are stubbed so this suite needs no reachable
// MinIO: the cascade test deletes objects, and every /complete HEAD-verifies
// its upload (always "present, right size" here — these tests are about the
// accounting; completeVerification.test.ts exercises the real HEAD against
// real uploaded bytes). Presigning is a local computation and stays real.
vi.mock("../lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/storage")>();
  return {
    ...original,
    deleteObject: vi.fn().mockResolvedValue(undefined),
    objectHasSize: vi.fn().mockResolvedValue(true),
  };
});

import { buildServer } from "../server";
import { cascadeDeleteUserLinks } from "../lib/accountDeletion";
import { env } from "../env";
import { chargedBytes, senderReservationCap } from "../lib/quota";
import { reservationSenderKey } from "../lib/senderKey";

const OVERHEAD = 16;
const FILE_SIZE = 100;
const CHARGE = FILE_SIZE + OVERHEAD; // 116: what one drop of FILE_SIZE costs

const metadata = (fileSize = FILE_SIZE) => ({
  fileName: "report.pdf",
  fileSize,
  nonce: "bm9uY2U=",
  mimeType: "application/pdf",
  contentMD5: "bWQ1",
});

type Server = ReturnType<typeof buildServer>;

let userCounter = 0;
async function createOwner(quota: number, used = 0) {
  userCounter++;
  return prisma.user.create({
    data: {
      email: `quota${userCounter}@example.com`,
      username: `quota${userCounter}`,
      name: "Quota",
      passwordHash: "h",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "pk",
      storageQuotaBytes: quota,
      storageUsedBytes: used,
    },
  });
}

async function createOwnedLink(ownerId: string, slug: string, mode: "permanent" | "one-time" = "permanent") {
  return prisma.link.create({
    data: {
      ownerId,
      slug,
      mode,
      recipientPublicKey: "pk",
      retentionDays: 7,
      expiresAt: mode === "one-time" ? new Date(Date.now() + 60 * 60 * 1000) : null,
    },
  });
}

async function usedBytes(userId: string): Promise<bigint> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return user.storageUsedBytes;
}

function requestUpload(server: Server, slug: string, fileSize = FILE_SIZE) {
  return server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: metadata(fileSize) },
  });
}

function complete(server: Server, slug: string, dropId: string) {
  return server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
}

async function withLiveServer<T>(fn: (server: Server, baseUrl: string) => Promise<T>): Promise<T> {
  // Real sockets, as in uploads.test.ts's race tests: inject() does not
  // reliably overlap handlers, so it can't prove the absence of a race.
  const server = buildServer();
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(server, `http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

describe("storage quota", () => {
  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  describe("upload-url enforcement", () => {
    it("allows an upload that exactly fills the quota (fileSize + 16 == quota)", async () => {
      const server = buildServer();
      const owner = await createOwner(CHARGE);
      await createOwnedLink(owner.id, "exact-fit");

      const response = await requestUpload(server, "exact-fit");

      expect(response.statusCode).toBe(200);
    });

    it("rejects an upload one byte over the quota with 413 and creates no drop", async () => {
      const server = buildServer();
      const owner = await createOwner(CHARGE - 1);
      const link = await createOwnedLink(owner.id, "one-over");

      const response = await requestUpload(server, "one-over");

      expect(response.statusCode).toBe(413);
      expect(response.json().error).toMatch(/storage quota/i);
      expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(0);
    });

    it("counts existing storageUsedBytes against the quota, at the exact boundary", async () => {
      const server = buildServer();
      const fits = await createOwner(50 + CHARGE, 50);
      await createOwnedLink(fits.id, "used-fits");
      const over = await createOwner(50 + CHARGE - 1, 50);
      await createOwnedLink(over.id, "used-over");

      expect((await requestUpload(server, "used-fits")).statusCode).toBe(200);
      expect((await requestUpload(server, "used-over")).statusCode).toBe(413);
    });

    it("counts every queued drop on a permanent link, including in-flight (uploading) ones", async () => {
      const server = buildServer();
      const owner = await createOwner(2 * CHARGE);
      await createOwnedLink(owner.id, "queue");

      const first = await requestUpload(server, "queue");
      const second = await requestUpload(server, "queue");
      const third = await requestUpload(server, "queue");

      expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 413]);

      // Completing them converts reservations into real usage; the quota stays full.
      await complete(server, "queue", first.json().dropId);
      await complete(server, "queue", second.json().dropId);
      expect(await usedBytes(owner.id)).toBe(BigInt(2 * CHARGE));
      expect((await requestUpload(server, "queue")).statusCode).toBe(413);
    });

    it("counts quota across all of an owner's links, not per link", async () => {
      const server = buildServer();
      const owner = await createOwner(CHARGE);
      await createOwnedLink(owner.id, "link-a");
      await createOwnedLink(owner.id, "link-b");

      expect((await requestUpload(server, "link-a")).statusCode).toBe(200);
      expect((await requestUpload(server, "link-b")).statusCode).toBe(413);
    });

    it("stops counting an abandoned uploading drop once its reservation window has passed", async () => {
      const server = buildServer();
      const owner = await createOwner(CHARGE);
      const link = await createOwnedLink(owner.id, "stale-reservation");
      await prisma.drop.create({
        data: {
          linkId: link.id,
          senderPublicKey: "s",
          s3Key: `${link.id}/stale`,
          // @ts-expect-error — rewritten in plan 2
          nonce: "n",
          fileName: "f",
          fileSize: FILE_SIZE,
          mimeType: "text/plain",
          contentMD5: "m",
          status: "uploading",
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      });

      expect((await requestUpload(server, "stale-reservation")).statusCode).toBe(200);
    });

    it("still enforces one drop per owned one-time link (409 wins over quota for the second)", async () => {
      const server = buildServer();
      const owner = await createOwner(10 * CHARGE);
      await createOwnedLink(owner.id, "owned-one-time", "one-time");

      expect((await requestUpload(server, "owned-one-time")).statusCode).toBe(200);
      expect((await requestUpload(server, "owned-one-time")).statusCode).toBe(409);
    });
  });

  describe("/complete accounting", () => {
    it("increments the owner's storageUsedBytes by fileSize + 16 once the upload completes", async () => {
      const server = buildServer();
      const owner = await createOwner(1_000_000, 7);
      await createOwnedLink(owner.id, "incr");

      const { dropId } = (await requestUpload(server, "incr", 1234)).json();
      expect(await usedBytes(owner.id)).toBe(7n); // not charged until confirmed

      expect((await complete(server, "incr", dropId)).statusCode).toBe(200);
      expect(await usedBytes(owner.id)).toBe(7n + 1234n + 16n);
    });

    it("does not double-charge on a repeated or late complete call", async () => {
      const server = buildServer();
      const owner = await createOwner(1_000_000);
      await createOwnedLink(owner.id, "double");
      const { dropId } = (await requestUpload(server, "double")).json();

      expect((await complete(server, "double", dropId)).statusCode).toBe(200);
      // Repeats are idempotent successes, but never charge again.
      expect((await complete(server, "double", dropId)).statusCode).toBe(200);
      // @ts-expect-error — rewritten in plan 2
      await prisma.drop.update({ where: { id: dropId }, data: { status: "downloaded" } });
      expect((await complete(server, "double", dropId)).statusCode).toBe(200);

      expect(await usedBytes(owner.id)).toBe(BigInt(CHARGE));
    });

    it("handles quota/usage values far beyond 32-bit range exactly (BigInt end to end)", async () => {
      const server = buildServer();
      const big = 2n ** 40n; // 1 TiB, far beyond a 32-bit Int
      const owner = await prisma.user.create({
        data: {
          email: "big@example.com",
          username: "bigquota",
          name: "Big",
          passwordHash: "h",
          passwordSalt: "s",
          passwordWrappedPrivateKey: "w",
          recoveryWrappedPrivateKey: "r",
          publicKey: "pk",
          storageQuotaBytes: big,
          storageUsedBytes: big - BigInt(CHARGE),
        },
      });
      await createOwnedLink(owner.id, "bigquota-link");

      const response = await requestUpload(server, "bigquota-link");
      expect(response.statusCode).toBe(200);
      await complete(server, "bigquota-link", response.json().dropId);
      expect(await usedBytes(owner.id)).toBe(big);
      expect((await requestUpload(server, "bigquota-link", 1)).statusCode).toBe(413);
    });
  });

  describe("/complete reservation window", () => {
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

    async function backdate(dropIds: string[], ageMs: number) {
      await prisma.drop.updateMany({
        where: { id: { in: dropIds } },
        data: { createdAt: new Date(Date.now() - ageMs) },
      });
    }

    it("rejects completing a drop whose reservation window has passed, without charging it", async () => {
      const server = buildServer();
      const owner = await createOwner(1_000_000);
      await createOwnedLink(owner.id, "stale-complete");
      const { dropId } = (await requestUpload(server, "stale-complete")).json();
      await backdate([dropId], TWO_HOURS_MS);

      const response = await complete(server, "stale-complete", dropId);

      expect(response.statusCode).toBe(410);
      expect(response.json().error).toMatch(/expired/i);
      expect(await usedBytes(owner.id)).toBe(0n);
      const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
      // @ts-expect-error — rewritten in plan 2
      expect(drop.status).toBe("uploading");
    });

    it("still completes (and charges exactly once) a slow upload that finishes inside the window", async () => {
      const server = buildServer();
      const owner = await createOwner(1_000_000);
      await createOwnedLink(owner.id, "slow-complete");
      const { dropId } = (await requestUpload(server, "slow-complete")).json();
      // Past the presigned URL's 600s validity, still well inside the window.
      await backdate([dropId], 15 * 60 * 1000);

      expect((await complete(server, "slow-complete", dropId)).statusCode).toBe(200);
      expect((await complete(server, "slow-complete", dropId)).statusCode).toBe(200);
      expect(await usedBytes(owner.id)).toBe(BigInt(CHARGE));
    });

    it("keeps an unknown drop id a 404, distinct from an expired reservation", async () => {
      const server = buildServer();
      const owner = await createOwner(1_000_000);
      await createOwnedLink(owner.id, "unknown-drop");

      expect((await complete(server, "unknown-drop", "no-such-drop")).statusCode).toBe(404);
    });

    it("blocks the reviewer's repro: late completion of backdated reservations cannot overshoot the quota", async () => {
      const server = buildServer();
      const BATCH = 4;
      const owner = await createOwner(BATCH * CHARGE);
      await createOwnedLink(owner.id, "overshoot");

      const reserve = async () => {
        const ids: string[] = [];
        for (let i = 0; i < BATCH; i++) {
          const response = await requestUpload(server, "overshoot");
          expect(response.statusCode).toBe(200);
          ids.push(response.json().dropId);
        }
        return ids;
      };

      const firstBatch = await reserve();
      await backdate(firstBatch, TWO_HOURS_MS);
      // The stale reservations no longer count, so a full new batch fits.
      const secondBatch = await reserve();

      for (const dropId of firstBatch) {
        expect((await complete(server, "overshoot", dropId)).statusCode).toBe(410);
      }
      for (const dropId of secondBatch) {
        expect((await complete(server, "overshoot", dropId)).statusCode).toBe(200);
      }

      expect(await usedBytes(owner.id)).toBe(BigInt(BATCH * CHARGE));
    });
  });

  describe("anonymous links (regression guard)", () => {
    it("never touches any user's quota and is not subject to quota checks", async () => {
      const server = buildServer();
      // A user with no free space at all: must not affect anonymous uploads.
      const bystander = await createOwner(0, 0);
      const created = await server.inject({
        method: "POST",
        url: "/api/links",
        payload: { recipientPublicKey: "cmVjaXBpZW50" },
      });
      const slug = created.json().slug as string;

      const upload = await requestUpload(server, slug, 10_000);
      expect(upload.statusCode).toBe(200);
      expect((await complete(server, slug, upload.json().dropId)).statusCode).toBe(200);

      const deleted = await server.inject({ method: "DELETE", url: `/api/links/${slug}` });
      expect(deleted.statusCode).toBe(200);
      expect(await usedBytes(bystander.id)).toBe(0n);
    });
  });

  describe("concurrency", () => {
    it("admits exactly as many concurrent upload-url requests as fit the quota", async () => {
      await withLiveServer(async (_server, baseUrl) => {
        const FITS = 3;
        const owner = await createOwner(FITS * CHARGE);
        await createOwnedLink(owner.id, "burst");

        const fire = () =>
          fetch(`${baseUrl}/api/links/burst/upload-url`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ senderPublicKey: "c2VuZGVy", metadata: metadata() }),
          });
        const CONCURRENT_REQUESTS = 12;
        const responses = await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, fire));
        const statuses = responses.map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(FITS);
        expect(statuses.filter((s) => s === 413)).toHaveLength(CONCURRENT_REQUESTS - FITS);

        // Complete the admitted ones concurrently, each twice: every charge
        // lands exactly once, with no lost updates.
        const dropIds = (
          await Promise.all(responses.filter((r) => r.status === 200).map(async (r) => (await r.json()).dropId as string))
        );
        const completes = await Promise.all(
          [...dropIds, ...dropIds].map((dropId) =>
            fetch(`${baseUrl}/api/links/burst/drops/${dropId}/complete`, { method: "POST" })
          )
        );
        // Every call succeeds (repeats idempotently), but exactly one per
        // drop actually performs the transition and its charge.
        expect(completes.map((r) => r.status)).toEqual(Array(2 * FITS).fill(200));
        const bodies = await Promise.all(completes.map((r) => r.json()));
        expect(bodies.filter((b) => b.updated === true)).toHaveLength(FITS);
        expect(await usedBytes(owner.id)).toBe(BigInt(FITS * CHARGE));
      });
    });

    it("keeps an owned one-time link to a single drop under concurrent upload-url requests", async () => {
      await withLiveServer(async (_server, baseUrl) => {
        const owner = await createOwner(100 * CHARGE);
        const link = await createOwnedLink(owner.id, "owned-once-burst", "one-time");

        const responses = await Promise.all(
          Array.from({ length: 12 }, () =>
            fetch(`${baseUrl}/api/links/${link.slug}/upload-url`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ senderPublicKey: "c2VuZGVy", metadata: metadata() }),
            })
          )
        );
        const statuses = responses.map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(statuses.filter((s) => s === 409)).toHaveLength(11);
        expect(await prisma.drop.count({ where: { linkId: link.id } })).toBe(1);
      });
    });

    it("ends at exactly zero usage when completions race a full cascade delete of the owner's links", async () => {
      await withLiveServer(async (server, baseUrl) => {
        const owner = await createOwner(1_000_000);
        await createOwnedLink(owner.id, "race-delete");
        const dropIds: string[] = [];
        for (let i = 0; i < 10; i++) {
          dropIds.push((await requestUpload(server, "race-delete")).json().dropId);
        }
        // Half already completed before the race starts.
        for (const dropId of dropIds.slice(0, 5)) await complete(server, "race-delete", dropId);
        expect(await usedBytes(owner.id)).toBe(BigInt(5 * CHARGE));

        await Promise.all([
          ...dropIds.slice(5).map((dropId) =>
            fetch(`${baseUrl}/api/links/race-delete/drops/${dropId}/complete`, { method: "POST" })
          ),
          cascadeDeleteUserLinks(owner.id),
        ]);

        expect(await prisma.drop.count({ where: { link: { ownerId: owner.id } } })).toBe(0);
        expect(await usedBytes(owner.id)).toBe(0n);
      });
    });
  });

  // Fairness on top of the quota: one sender network may hold at most
  // senderReservationCap(quota) bytes of an owner's in-flight reservations
  // (lib/quota.ts assertWithinSenderShare). With the default settings that is
  // 1.25 GiB of 5 GiB, i.e. two 500 MiB reservations.
  describe("per-sender reservation share", () => {
    const MiB = 1024 * 1024;
    const MAX = env.MAX_FILE_SIZE_BYTES;
    const MAX_CHARGE = chargedBytes(MAX);
    const DEFAULT_QUOTA = 5 * 1024 * MiB;
    const CAP = senderReservationCap(BigInt(DEFAULT_QUOTA), MAX);
    const MAX_FILES_PER_SENDER = Number(CAP / MAX_CHARGE);

    const ATTACKER = "203.0.113.66";
    const OTHER_SENDER = "198.51.100.7";

    function requestUploadFrom(server: Server, slug: string, ip: string, fileSize: number) {
      return server.inject({
        method: "POST",
        url: `/api/links/${slug}/upload-url`,
        remoteAddress: ip,
        payload: { senderPublicKey: "c2VuZGVy", metadata: metadata(fileSize) },
      });
    }

    // Over a real socket every request comes from 127.0.0.1, which the
    // default TRUST_PROXY_HOPS=1 treats as our own nginx, so request.ip is
    // the rightmost X-Forwarded-For entry — exactly how production sees it.
    function liveUploadFrom(baseUrl: string, slug: string, ip: string, fileSize: number) {
      return fetch(`${baseUrl}/api/links/${slug}/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ senderPublicKey: "c2VuZGVy", metadata: metadata(fileSize) }),
      });
    }

    // Bytes currently held in reservation against `ownerId`, optionally by one sender.
    async function reservedBytes(ownerId: string, ip?: string): Promise<bigint> {
      const drops = await prisma.drop.findMany({
        where: {
          // @ts-expect-error — rewritten in plan 2
          status: "uploading",
          link: { ownerId },
          ...(ip === undefined ? {} : { reservationSenderKey: reservationSenderKey(ip) }),
        },
        select: { fileSize: true },
      });
      return drops.reduce((sum, drop) => sum + chargedBytes(drop.fileSize), 0n);
    }

    it("sanity: the default settings give each sender two max-size reservations", () => {
      expect(CAP).toBe(1280n * BigInt(MiB));
      expect(MAX_FILES_PER_SENDER).toBe(2);
    });

    it("stops one IP's concurrent max-size reservation flood at its share, while a different IP can still reserve against the same owner", async () => {
      await withLiveServer(async (_server, baseUrl) => {
        const owner = await createOwner(DEFAULT_QUOTA);
        await createOwnedLink(owner.id, "flooded");

        // The reported attack: ~11 max-size upload-url calls (enough to cover
        // the whole 5 GiB quota, well under the 20/min rate limit), all at once.
        const ATTACK_REQUESTS = 11;
        const attack = await Promise.all(
          Array.from({ length: ATTACK_REQUESTS }, () => liveUploadFrom(baseUrl, "flooded", ATTACKER, MAX))
        );
        const attackStatuses = attack.map((r) => r.status);
        expect(attackStatuses.filter((s) => s === 200)).toHaveLength(MAX_FILES_PER_SENDER);
        expect(attackStatuses.filter((s) => s === 429)).toHaveLength(ATTACK_REQUESTS - MAX_FILES_PER_SENDER);

        const rejected = attack.find((r) => r.status === 429)!;
        expect((await rejected.json()).error).toMatch(/unfinished uploads/i);
        const retryAfter = Number(rejected.headers.get("retry-after"));
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(60 * 60);

        // Byte-level: the attacker holds exactly its share, nowhere near the quota.
        const attackerHeld = await reservedBytes(owner.id, ATTACKER);
        expect(attackerHeld).toBe(BigInt(MAX_FILES_PER_SENDER) * MAX_CHARGE);
        expect(attackerHeld).toBeLessThanOrEqual(CAP);

        // Availability for everyone else: a different sender, same owner,
        // concurrently reserving its own max-size uploads, is unaffected.
        const other = await Promise.all(
          Array.from({ length: MAX_FILES_PER_SENDER }, () => liveUploadFrom(baseUrl, "flooded", OTHER_SENDER, MAX))
        );
        expect(other.map((r) => r.status)).toEqual(Array(MAX_FILES_PER_SENDER).fill(200));

        // The attacker is still capped afterwards, and the quota was never exceeded.
        expect((await liveUploadFrom(baseUrl, "flooded", ATTACKER, MAX)).status).toBe(429);
        expect(await reservedBytes(owner.id)).toBeLessThanOrEqual(BigInt(DEFAULT_QUOTA));
      });
    });

    it("keeps every sender within its share and the owner within quota under a concurrent multi-IP storm", async () => {
      await withLiveServer(async (_server, baseUrl) => {
        const owner = await createOwner(DEFAULT_QUOTA);
        await createOwnedLink(owner.id, "storm");
        const ips = Array.from({ length: 6 }, (_, i) => `192.0.2.${10 + i}`);
        const PER_IP = 5;

        const results = await Promise.all(
          ips.flatMap((ip) =>
            Array.from({ length: PER_IP }, async () => ({ ip, status: (await liveUploadFrom(baseUrl, "storm", ip, MAX)).status }))
          )
        );

        // 6 senders x 2 allowed each = 12 > the 10 max-size files the quota
        // holds, so the quota is the binding limit overall: exactly 10 get in.
        const fitInQuota = Number(BigInt(DEFAULT_QUOTA) / MAX_CHARGE);
        expect(fitInQuota).toBe(10);
        expect(results.filter((r) => r.status === 200)).toHaveLength(fitInQuota);
        for (const ip of ips) {
          expect(results.filter((r) => r.ip === ip && r.status === 200).length).toBeLessThanOrEqual(MAX_FILES_PER_SENDER);
          expect(await reservedBytes(owner.id, ip)).toBeLessThanOrEqual(CAP);
        }
        expect(results.every((r) => [200, 413, 429].includes(r.status))).toBe(true);
        expect(await reservedBytes(owner.id)).toBeLessThanOrEqual(BigInt(DEFAULT_QUOTA));
      });
    });

    it("caps by bytes held, not by request count, at the exact boundary", async () => {
      const server = buildServer();
      const owner = await createOwner(DEFAULT_QUOTA);
      await createOwnedLink(owner.id, "byte-cap");
      const SIZE = 100 * MiB;
      const fits = Number(CAP / chargedBytes(SIZE));
      expect(fits).toBe(12);

      for (let i = 0; i < fits; i++) {
        expect((await requestUploadFrom(server, "byte-cap", ATTACKER, SIZE)).statusCode).toBe(200);
      }
      // Remaining headroom is less than one more 100 MiB file, but a file
      // whose charge exactly fills it still fits; one byte more does not.
      const headroom = CAP - BigInt(fits) * chargedBytes(SIZE);
      const exactFit = Number(headroom) - 16;
      expect((await requestUploadFrom(server, "byte-cap", ATTACKER, exactFit + 1)).statusCode).toBe(429);
      expect((await requestUploadFrom(server, "byte-cap", ATTACKER, exactFit)).statusCode).toBe(200);
      expect(await reservedBytes(owner.id, ATTACKER)).toBe(CAP);
      expect((await requestUploadFrom(server, "byte-cap", ATTACKER, 1)).statusCode).toBe(429);
      // The owner still has room, and other senders get it.
      expect((await requestUploadFrom(server, "byte-cap", OTHER_SENDER, 1)).statusCode).toBe(200);
    });

    it("releases a sender's share when its upload completes, and clears the sender tag", async () => {
      const server = buildServer();
      const owner = await createOwner(DEFAULT_QUOTA);
      await createOwnedLink(owner.id, "release-complete");
      const dropIds: string[] = [];
      for (let i = 0; i < MAX_FILES_PER_SENDER; i++) {
        const response = await requestUploadFrom(server, "release-complete", ATTACKER, MAX);
        expect(response.statusCode).toBe(200);
        dropIds.push(response.json().dropId);
      }
      expect((await requestUploadFrom(server, "release-complete", ATTACKER, MAX)).statusCode).toBe(429);

      expect((await complete(server, "release-complete", dropIds[0]!)).statusCode).toBe(200);
      const completed = await prisma.drop.findUniqueOrThrow({ where: { id: dropIds[0]! } });
      expect(completed.reservationSenderKey).toBeNull();

      expect((await requestUploadFrom(server, "release-complete", ATTACKER, MAX)).statusCode).toBe(200);
    });

    it("releases a sender's share once its reservations leave the reservation window", async () => {
      const server = buildServer();
      const owner = await createOwner(DEFAULT_QUOTA);
      await createOwnedLink(owner.id, "release-window");
      const dropIds: string[] = [];
      for (let i = 0; i < MAX_FILES_PER_SENDER; i++) {
        dropIds.push((await requestUploadFrom(server, "release-window", ATTACKER, MAX)).json().dropId);
      }
      expect((await requestUploadFrom(server, "release-window", ATTACKER, MAX)).statusCode).toBe(429);

      await prisma.drop.updateMany({
        where: { id: { in: dropIds } },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });

      expect((await requestUploadFrom(server, "release-window", ATTACKER, MAX)).statusCode).toBe(200);
    });

    it("does not falsely block a legitimate sender uploading many large files in sequence (including a retry after an abandoned attempt)", async () => {
      const server = buildServer();
      const owner = await createOwner(DEFAULT_QUOTA);
      await createOwnedLink(owner.id, "legit-sequence");

      // One abandoned max-size attempt (e.g. the tab was closed mid-upload)...
      expect((await requestUploadFrom(server, "legit-sequence", OTHER_SENDER, MAX)).statusCode).toBe(200);
      // ...then eight 400 MiB files, one after another, as the web client
      // does (upload-url -> PUT -> complete per file). 3.9 GiB in total from
      // one sender — far above its 1.25 GiB share — all accepted, because the
      // share only limits what is in flight at once.
      const SIZE = 400 * MiB;
      for (let i = 0; i < 8; i++) {
        const response = await requestUploadFrom(server, "legit-sequence", OTHER_SENDER, SIZE);
        expect(response.statusCode).toBe(200);
        expect((await complete(server, "legit-sequence", response.json().dropId)).statusCode).toBe(200);
      }
      expect(await usedBytes(owner.id)).toBe(8n * chargedBytes(SIZE));
    });

    it("never refuses a single max-size upload just because of the cap, even on a small quota", async () => {
      const server = buildServer();
      const owner = await createOwner(Number(MAX_CHARGE));
      await createOwnedLink(owner.id, "small-quota");

      expect((await requestUploadFrom(server, "small-quota", OTHER_SENDER, MAX)).statusCode).toBe(200);
    });

    it("still reports a genuinely full inbox as 413, even to a sender already at its share", async () => {
      const server = buildServer();
      // Room for exactly two max-size files; each sender's share is one.
      const owner = await createOwner(Number(2n * MAX_CHARGE));
      await createOwnedLink(owner.id, "full-inbox");

      expect((await requestUploadFrom(server, "full-inbox", ATTACKER, MAX)).statusCode).toBe(200);
      expect((await requestUploadFrom(server, "full-inbox", ATTACKER, MAX)).statusCode).toBe(429);
      expect((await requestUploadFrom(server, "full-inbox", OTHER_SENDER, MAX)).statusCode).toBe(200);
      expect((await requestUploadFrom(server, "full-inbox", ATTACKER, MAX)).statusCode).toBe(413);
    });
  });
});
