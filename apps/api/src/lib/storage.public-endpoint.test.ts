import { describe, it, expect, vi } from "vitest";

vi.mock("../env", () => ({
  env: {
    MINIO_ENDPOINT: "http://minio:9000",
    MINIO_PUBLIC_ENDPOINT: "http://localhost:8080/s3/",
    MINIO_REGION: "us-east-1",
    MINIO_BUCKET: "test-bucket",
    MINIO_ACCESS_KEY: "test",
    MINIO_SECRET_KEY: "test",
  },
}));

import { getSignedUploadUrl, getSignedDownloadUrl } from "./storage";

describe("storage with a public endpoint behind a path-prefix proxy", () => {
  it("builds presigned PUT urls on the public endpoint, not the internal one", async () => {
    const url = new URL(await getSignedUploadUrl("links/abc/drop1"));
    expect(url.host).toBe("localhost:8080");
    expect(url.pathname).toBe("/s3/test-bucket/links/abc/drop1");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("does not bake a checksum of an empty body into presigned PUT urls", async () => {
    const url = new URL(await getSignedUploadUrl("links/abc/drop1"));
    const checksumParams = [...url.searchParams.keys()].filter((k) =>
      k.toLowerCase().startsWith("x-amz-checksum") || k.toLowerCase() === "x-amz-sdk-checksum-algorithm"
    );
    expect(checksumParams).toEqual([]);
  });

  it("builds presigned GET urls on the public endpoint, not the internal one", async () => {
    const url = new URL(await getSignedDownloadUrl("links/abc/drop1"));
    expect(url.host).toBe("localhost:8080");
    expect(url.pathname).toBe("/s3/test-bucket/links/abc/drop1");
  });
});
