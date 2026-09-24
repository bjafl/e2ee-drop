import { describe, it, expect, vi } from "vitest";

vi.mock("../env", () => ({
  env: {
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_REGION: "us-east-1",
    MINIO_BUCKET: "test-bucket",
    MINIO_ACCESS_KEY: "test",
    MINIO_SECRET_KEY: "test",
  },
}));

import { getSignedUploadUrl, getSignedDownloadUrl } from "./storage";

describe("storage", () => {
  it("produces a presigned PUT url pointing at the configured bucket/key", async () => {
    const url = await getSignedUploadUrl("links/abc/drop1");
    expect(url).toContain("test-bucket");
    expect(url).toContain("links/abc/drop1");
  });

  it("produces a presigned GET url pointing at the configured bucket/key", async () => {
    const url = await getSignedDownloadUrl("links/abc/drop1");
    expect(url).toContain("test-bucket");
    expect(url).toContain("links/abc/drop1");
  });
});
