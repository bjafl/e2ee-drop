import { describe, it, expect } from "vitest";
import { isChargedStatus } from "./quota";

describe("isChargedStatus", () => {
  it("is false for uploading (in-flight, not yet charged)", () => {
    expect(isChargedStatus("uploading")).toBe(false);
  });

  it("is true for complete (charged on /complete)", () => {
    expect(isChargedStatus("complete")).toBe(true);
  });

  it("is false for reserved (not yet a real transfer attempt)", () => {
    expect(isChargedStatus("reserved")).toBe(false);
  });
});
