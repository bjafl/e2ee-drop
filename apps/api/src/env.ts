// apps/api/src/env.ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: int("PORT", 3000),
  MAX_FILE_SIZE_BYTES: int("MAX_FILE_SIZE_BYTES", 500 * 1024 * 1024),
  LINK_EXPIRY_HOURS: int("LINK_EXPIRY_HOURS", 24),
  DROP_RETENTION_DAYS: int("DROP_RETENTION_DAYS", 7),
  // Internal endpoint for server-to-MinIO calls (bucket setup, deletes).
  MINIO_ENDPOINT: required("MINIO_ENDPOINT"),
  // Browser-reachable endpoint embedded in presigned upload/download URLs.
  // May include a path prefix handled by a reverse proxy (e.g. http://localhost:8080/s3).
  // Falls back to MINIO_ENDPOINT when unset (e.g. local dev hitting MinIO directly).
  MINIO_PUBLIC_ENDPOINT: process.env.MINIO_PUBLIC_ENDPOINT || undefined,
  MINIO_REGION: process.env.MINIO_REGION ?? "us-east-1",
  MINIO_BUCKET: required("MINIO_BUCKET"),
  MINIO_ACCESS_KEY: required("MINIO_ACCESS_KEY"),
  MINIO_SECRET_KEY: required("MINIO_SECRET_KEY"),
};
