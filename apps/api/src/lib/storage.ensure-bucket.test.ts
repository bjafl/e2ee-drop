import { describe, it, expect, vi, afterEach } from "vitest";
import { S3Client, PutBucketCorsCommand } from "@aws-sdk/client-s3";

vi.mock("../env", () => ({
  env: {
    MINIO_ENDPOINT: "http://minio:9000",
    MINIO_REGION: "us-east-1",
    MINIO_BUCKET: "test-bucket",
    MINIO_ACCESS_KEY: "test",
    MINIO_SECRET_KEY: "test",
  },
}));

import { ensureBucket } from "./storage";

function failCorsWith(name: string) {
  return vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    if (command instanceof PutBucketCorsCommand) {
      throw Object.assign(new Error(name), { name });
    }
    return {};
  });
}

describe("ensureBucket", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tolerates a backend that does not implement the bucket CORS API (MinIO)", async () => {
    failCorsWith("NotImplemented");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ensureBucket()).resolves.toBeUndefined();
  });

  it("still surfaces other CORS errors", async () => {
    failCorsWith("AccessDenied");
    await expect(ensureBucket()).rejects.toThrow("AccessDenied");
  });
});
