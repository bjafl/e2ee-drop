import { describe, it, expect } from "vitest";
import { prisma } from "./index";

describe("prisma client", () => {
  it("exposes link and drop delegates", () => {
    expect(prisma.link).toBeDefined();
    expect(prisma.drop).toBeDefined();
  });
});
