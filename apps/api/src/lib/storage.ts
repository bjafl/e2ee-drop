import {
  S3Client,
  type S3ClientConfig,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

function makeClient(endpoint: string, extra: Partial<S3ClientConfig> = {}): S3Client {
  return new S3Client({
    ...extra,
    region: env.MINIO_REGION,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
    },
  });
}

// Internal client: talks to MinIO directly over the private network
// (e.g. http://minio:9000). Used for real API calls made by this process
// (bucket setup, deletes).
let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) client = makeClient(env.MINIO_ENDPOINT);
  return client;
}

// Presigned URLs are handed to browsers, so they must point at an address the
// browser can reach (MINIO_PUBLIC_ENDPOINT, e.g. http://localhost:8080/s3 —
// a reverse proxy in front of MinIO). Presigning is a purely local signature
// computation, so this client never makes network calls.
//
// SigV4 signs both the Host header and the request path. The reverse proxy
// strips the public path prefix (/s3) and forwards the original Host, so what
// MinIO sees is `Host: <public host>` + `/<bucket>/<key>`. To make the
// signature match, we sign against the public *origin* only (no prefix) and
// splice the prefix into the URL afterwards — the prefix is never part of the
// signed canonical request.
let presignClient: S3Client | null = null;
let presignPathPrefix = "";

function getPresignClient(): S3Client {
  if (!presignClient) {
    const publicEndpoint = new URL(env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT);
    presignPathPrefix = publicEndpoint.pathname.replace(/\/+$/, "");
    // The SDK's default flexible checksums would compute a CRC32 at presign time —
    // of an *empty* body, since the real bytes are only uploaded later by the
    // browser — and bake it into the URL (x-amz-checksum-crc32=AAAAAA==). Backends
    // that enforce it reject every real upload. Only add checksums when an
    // operation requires them.
    presignClient = makeClient(publicEndpoint.origin, {
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }
  return presignClient;
}

async function presign(command: PutObjectCommand | GetObjectCommand, expiresIn: number): Promise<string> {
  const s3 = getPresignClient();
  const signed = new URL(await getSignedUrl(s3, command, { expiresIn }));
  signed.pathname = presignPathPrefix + signed.pathname;
  return signed.toString();
}

export async function ensureBucket(): Promise<void> {
  const s3 = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.MINIO_BUCKET }));
  }
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: env.MINIO_BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedMethods: ["GET", "PUT"],
              AllowedOrigins: ["*"],
              AllowedHeaders: ["*"],
            },
          ],
        },
      })
    );
  } catch (err) {
    // MinIO does not implement the per-bucket CORS API (it answers 501
    // NotImplemented; CORS is configured server-wide via MINIO_API_CORS_ALLOW_ORIGIN,
    // which defaults to "*"). In the Compose setup presigned URLs are same-origin
    // via the web container's /s3 proxy anyway, so this is non-fatal there. Other
    // S3-compatible backends that do support it still get the rule applied.
    if ((err as { name?: string }).name !== "NotImplemented") throw err;
    console.warn("[storage] bucket CORS API not implemented by storage backend; skipping");
  }
}

// `contentLength` is the exact number of bytes the upload must contain. It becomes a
// signed header (X-Amz-SignedHeaders=content-length;host), so the storage backend
// rejects any PUT whose actual body size differs (SignatureDoesNotMatch) — that's
// what enforces the server's size limit at the storage layer, rather than trusting
// the client-declared size the API checked when issuing the URL. Browsers set
// Content-Length from the body automatically, so clients need no changes as long as
// they upload exactly the declared bytes.
export async function getSignedUploadUrl(s3Key: string, contentLength: number, expiresIn = 600): Promise<string> {
  const command = new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key, ContentLength: contentLength });
  return presign(command, expiresIn);
}

export async function getSignedDownloadUrl(s3Key: string, expiresIn = 600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key });
  return presign(command, expiresIn);
}

export async function deleteObject(s3Key: string): Promise<void> {
  const s3 = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key }));
}
