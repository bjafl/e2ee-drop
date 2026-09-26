// apps/api/src/routes/completeVerification.test.ts
//
// POST /api/links/:slug/drops/:dropId/complete must verify the upload really
// landed in storage (HEAD, exact Content-Length) before marking the drop
// "uploaded" — and, on an owned link, before charging the owner's quota —
// and must answer a repeat call on an already-completed drop idempotently.
//
// Nothing about storage is mocked here: bytes are PUT to the real MinIO
// through the presigned URL the API hands out, exactly as the browser does,
// so these tests exercise the real HeadObject path. They need MINIO_ENDPOINT
// (and MINIO_PUBLIC_ENDPOINT, if set) to reach a MinIO that accepts
// MINIO_ACCESS_KEY / MINIO_SECRET_KEY; beforeAll fails loudly if it can't.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@e2ee-drop/db";
import { buildServer } from "../server";
import { ensureBucket, deleteObject } from "../lib/storage";
import { env } from "../env";
import { subscribeToLink, type DropEvent } from "../lib/dropEvents";

const OVERHEAD = 16;
const FILE_SIZE = 100;
const CHARGE = BigInt(FILE_SIZE + OVERHEAD);

const metadata = {
  fileName: "report.pdf",
  fileSize: FILE_SIZE,
  nonce: "bm9uY2U=",
  mimeType: "application/pdf",
  contentMD5: "bWQ1",
};

type Server = ReturnType<typeof buildServer>;

let userCounter = 0;
async function createOwnedLink(slug: string) {
  userCounter++;
  const owner = await prisma.user.create({
    data: {
      email: `verify${userCounter}@example.com`,
      username: `verify${userCounter}`,
      name: "Verify",
      passwordHash: "h",
      passwordSalt: "s",
      passwordWrappedPrivateKey: "w",
      recoveryWrappedPrivateKey: "r",
      publicKey: "pk",
      storageQuotaBytes: 10_000,
    },
  });
  await prisma.link.create({ data: { ownerId: owner.id, slug, mode: "permanent", recipientPublicKey: "pk", retentionDays: 7 } });
  return owner;
}

async function createAnonymousLink(server: Server): Promise<string> {
  const res = await server.inject({ method: "POST", url: "/api/links", payload: { recipientPublicKey: "cmVjaXBpZW50" } });
  return res.json().slug as string;
}

const createdKeys: string[] = [];

async function requestUpload(server: Server, slug: string) {
  const res = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata },
  });
  expect(res.statusCode).toBe(200);
  const { dropId, uploadUrl } = res.json() as { dropId: string; uploadUrl: string };
  const drop = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
  createdKeys.push(drop.s3Key);
  return { dropId, uploadUrl, s3Key: drop.s3Key };
}

// The real upload: the ciphertext-sized body PUT to the presigned URL.
async function putBytes(uploadUrl: string, size = FILE_SIZE + OVERHEAD) {
  const res = await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(size) });
  expect(res.status).toBe(200);
}

function complete(server: Server, slug: string, dropId: string) {
  return server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
}

async function statusOf(dropId: string) {
  // @ts-expect-error — rewritten in plan 2
  return (await prisma.drop.findUniqueOrThrow({ where: { id: dropId } })).status;
}

async function usedBytes(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).storageUsedBytes;
}

describe("/complete verifies the upload in storage", () => {
  beforeAll(async () => {
    try {
      await ensureBucket();
    } catch (err) {
      throw new Error(
        `completeVerification.test.ts needs a reachable MinIO at MINIO_ENDPOINT=${env.MINIO_ENDPOINT} ` +
          `accepting MINIO_ACCESS_KEY/MINIO_SECRET_KEY (${(err as Error).name}: ${(err as Error).message})`
      );
    }
  });

  beforeEach(async () => {
    await prisma.contact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(async () => {
    await Promise.all(createdKeys.splice(0).map((key) => deleteObject(key)));
  });

  describe("owned link", () => {
    it("rejects /complete without a PUT: no charge, drop stays uploading (phantom quota charge)", async () => {
      const server = buildServer();
      const owner = await createOwnedLink("phantom");
      const { dropId } = await requestUpload(server, "phantom");

      const res = await complete(server, "phantom", dropId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: expect.any(String) });
      expect(await statusOf(dropId)).toBe("uploading");
      expect(await usedBytes(owner.id)).toBe(0n);
      // Still a reservation, still tagged to its sender: the phantom attempt
      // freed none of the sender's reservation share.
      expect((await prisma.drop.findUniqueOrThrow({ where: { id: dropId } })).reservationSenderKey).not.toBeNull();
    });

    it("rejects an object of the wrong size, even though one exists at the key", async () => {
      const server = buildServer();
      const owner = await createOwnedLink("wrong-size");
      const { dropId, s3Key } = await requestUpload(server, "wrong-size");
      // The presigned URL can't store a wrong-sized body (content-length is
      // signed), so write one directly with the API's own credentials.
      const s3 = new S3Client({
        region: env.MINIO_REGION,
        endpoint: env.MINIO_ENDPOINT,
        forcePathStyle: true,
        credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
      });
      await s3.send(new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key, Body: new Uint8Array(FILE_SIZE) }));

      const res = await complete(server, "wrong-size", dropId);

      expect(res.statusCode).toBe(409);
      expect(await statusOf(dropId)).toBe("uploading");
      expect(await usedBytes(owner.id)).toBe(0n);
    });

    it("completes a real upload and charges exactly once; a repeat /complete is 200 and charges nothing", async () => {
      const server = buildServer();
      const owner = await createOwnedLink("real");
      const { dropId, uploadUrl } = await requestUpload(server, "real");

      // Phantom first, then the real PUT: the earlier rejection must not
      // stand in the way of the genuine completion.
      expect((await complete(server, "real", dropId)).statusCode).toBe(409);
      await putBytes(uploadUrl);

      const first = await complete(server, "real", dropId);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ updated: true });
      expect(await statusOf(dropId)).toBe("uploaded");
      expect(await usedBytes(owner.id)).toBe(CHARGE);

      const second = await complete(server, "real", dropId);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ updated: false });
      expect(await usedBytes(owner.id)).toBe(CHARGE);
    });

    it("is idempotent on a downloaded drop: 200, no charge, no status regression", async () => {
      const server = buildServer();
      const owner = await createOwnedLink("downloaded");
      const { dropId, uploadUrl } = await requestUpload(server, "downloaded");
      await putBytes(uploadUrl);
      expect((await complete(server, "downloaded", dropId)).statusCode).toBe(200);
      // @ts-expect-error — rewritten in plan 2
      await prisma.drop.update({ where: { id: dropId }, data: { status: "downloaded" } });

      const late = await complete(server, "downloaded", dropId);

      expect(late.statusCode).toBe(200);
      expect(await statusOf(dropId)).toBe("downloaded");
      expect(await usedBytes(owner.id)).toBe(CHARGE);
    });

    it("charges exactly once when many /complete calls for a real upload race", async () => {
      const server = buildServer();
      await server.listen({ port: 0, host: "127.0.0.1" });
      const address = server.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const owner = await createOwnedLink("race");
        const { dropId, uploadUrl } = await requestUpload(server, "race");
        await putBytes(uploadUrl);

        const responses = await Promise.all(
          Array.from({ length: 8 }, () =>
            fetch(`http://127.0.0.1:${port}/api/links/race/drops/${dropId}/complete`, { method: "POST" })
          )
        );
        const bodies = await Promise.all(responses.map((r) => r.json()));

        expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
        expect(bodies.filter((b) => b.updated === true)).toHaveLength(1);
        expect(await usedBytes(owner.id)).toBe(CHARGE);
      } finally {
        await server.close();
      }
    });
  });

  describe("anonymous link", () => {
    it("rejects a phantom /complete, then completes once the real bytes land", async () => {
      const server = buildServer();
      const slug = await createAnonymousLink(server);
      const { dropId, uploadUrl } = await requestUpload(server, slug);

      // A bystander (anyone with the slug can read the drop id) completing
      // early is now refused rather than flipping the drop to "uploaded".
      const early = await complete(server, slug, dropId);
      expect(early.statusCode).toBe(409);
      expect(await statusOf(dropId)).toBe("uploading");

      await putBytes(uploadUrl);
      const real = await complete(server, slug, dropId);
      expect(real.statusCode).toBe(200);
      expect(real.json()).toEqual({ updated: true });
      expect(await statusOf(dropId)).toBe("uploaded");
    });

    it("lets the real sender's /complete succeed after a bystander already completed it", async () => {
      const server = buildServer();
      const slug = await createAnonymousLink(server);
      const link = await prisma.link.findUniqueOrThrow({ where: { slug } });
      const { dropId, uploadUrl } = await requestUpload(server, slug);
      await putBytes(uploadUrl);
      const events: DropEvent[] = [];
      const unsubscribe = subscribeToLink(link.id, (event) => events.push(event));

      const bystander = await complete(server, slug, dropId);
      const sender = await complete(server, slug, dropId);
      unsubscribe();

      expect(bystander.statusCode).toBe(200);
      expect(sender.statusCode).toBe(200);
      expect(sender.json()).toEqual({ updated: false });
      expect(await statusOf(dropId)).toBe("uploaded");
      // Only the call that actually won the transition announces it.
      // @ts-expect-error — rewritten in plan 2
      expect(events.map((e) => [e.type, e.drop.status])).toEqual([["drop-updated", "uploaded"]]);
    });

    it("still 404s a drop id that doesn't exist on this link", async () => {
      const server = buildServer();
      const slug = await createAnonymousLink(server);

      const res = await complete(server, slug, "no-such-drop");

      expect(res.statusCode).toBe(404);
    });
  });
});
