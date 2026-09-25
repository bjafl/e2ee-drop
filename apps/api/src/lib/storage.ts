import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

function makeClient(endpoint: string): S3Client {
  return new S3Client({
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
    presignClient = makeClient(publicEndpoint.origin);
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
}

export async function getSignedUploadUrl(s3Key: string, expiresIn = 600): Promise<string> {
  const command = new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key });
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
