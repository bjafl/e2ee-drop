import { describe, it, expect, vi, afterEach } from "vitest";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

vi.mock("../env", () => ({
  env: {
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_REGION: "us-east-1",
    MINIO_BUCKET: "test-bucket",
    MINIO_ACCESS_KEY: "test",
    MINIO_SECRET_KEY: "test",
  },
}));

import { getSignedUploadUrl, getSignedDownloadUrl, listObjects } from "./storage";

describe("storage", () => {
  it("produces a presigned PUT url pointing at the configured bucket/key", async () => {
    const url = await getSignedUploadUrl("links/abc/drop1", 1040);
    expect(url).toContain("test-bucket");
    expect(url).toContain("links/abc/drop1");
  });

  it("produces a presigned GET url pointing at the configured bucket/key", async () => {
    const url = await getSignedDownloadUrl("links/abc/drop1");
    expect(url).toContain("test-bucket");
    expect(url).toContain("links/abc/drop1");
  });
});

describe("listObjects", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns every object's key and lastModified for a single-page response", async () => {
    const lastModified = new Date("2024-01-01T00:00:00Z");
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
      expect(command).toBeInstanceOf(ListObjectsV2Command);
      return { Contents: [{ Key: "link1/drop1", LastModified: lastModified }], IsTruncated: false };
    });

    const objects = await listObjects();

    expect(objects).toEqual([{ key: "link1/drop1", lastModified }]);
  });

  it("pages through IsTruncated/NextContinuationToken until exhausted", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementationOnce(async () => ({
        Contents: [{ Key: "link1/drop1", LastModified: new Date("2024-01-01T00:00:00Z") }],
        IsTruncated: true,
        NextContinuationToken: "token-2",
      }))
      .mockImplementationOnce(async () => ({
        Contents: [{ Key: "link2/drop2", LastModified: new Date("2024-01-02T00:00:00Z") }],
        IsTruncated: false,
      }));

    const objects = await listObjects();

    expect(objects.map((o) => o.key)).toEqual(["link1/drop1", "link2/drop2"]);
    expect(send).toHaveBeenCalledTimes(2);
    const secondCall = send.mock.calls[1][0] as ListObjectsV2Command;
    expect(secondCall.input.ContinuationToken).toBe("token-2");
  });

  it("returns an empty array when the bucket has no objects", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({ Contents: undefined, IsTruncated: false }));

    const objects = await listObjects();

    expect(objects).toEqual([]);
  });
});
