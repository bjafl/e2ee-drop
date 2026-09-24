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

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: env.MINIO_REGION,
      endpoint: env.MINIO_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
      },
    });
  }
  return client;
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
  const s3 = getClient();
  const command = new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function getSignedDownloadUrl(s3Key: string, expiresIn = 600): Promise<string> {
  const s3 = getClient();
  const command = new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function deleteObject(s3Key: string): Promise<void> {
  const s3 = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key }));
}
