// apps/api/src/routes/storageQuota.test.ts
//
// Per-user storage quota enforcement (spec §8) across upload-url, /complete,
// and the owner-side deletion paths. Owned links only; anonymous links must
// be entirely unaffected.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

// Only deleteObject is stubbed (the cascade test below would otherwise need a
// reachable MinIO); presigning is a local computation and stays real.
vi.mock("../lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/storage")>();
  return { ...original, deleteObject: vi.fn().mockResolvedValue(undefined) };
});

import { buildServer } from "../server";
import { cascadeDeleteUserLinks } from "../lib/accountDeletion";

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
      expect((await complete(server, "double", dropId)).statusCode).toBe(404);
      await prisma.drop.update({ where: { id: dropId }, data: { status: "downloaded" } });
      expect((await complete(server, "double", dropId)).statusCode).toBe(404);

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
      expect((await complete(server, "slow-complete", dropId)).statusCode).toBe(404);
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
        expect(completes.filter((r) => r.status === 200)).toHaveLength(FITS);
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
});
