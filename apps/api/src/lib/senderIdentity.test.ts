import { describe, it, expect } from "vitest";
import { assertSenderIdentity, SenderIdentityMismatchError } from "./senderIdentity";

describe("assertSenderIdentity", () => {
  it("passes when the authenticated user's publicKey matches the claim", () => {
    expect(() => assertSenderIdentity({ publicKey: "pk-1" }, "pk-1")).not.toThrow();
  });

  it("throws when the authenticated user's publicKey does not match the claim", () => {
    expect(() => assertSenderIdentity({ publicKey: "pk-1" }, "pk-2")).toThrow(SenderIdentityMismatchError);
  });

  it("passes for an anonymous sender (no session) regardless of the claimed key", () => {
    expect(() => assertSenderIdentity(null, "anything")).not.toThrow();
  });
});
