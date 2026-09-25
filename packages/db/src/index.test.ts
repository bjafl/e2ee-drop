import { describe, it, expect } from "vitest";
import { prisma } from "./index";

describe("prisma client", () => {
  it("exposes link, drop, user, session, contact, and password-reset-token delegates", () => {
    expect(prisma.link).toBeDefined();
    expect(prisma.drop).toBeDefined();
    expect(prisma.user).toBeDefined();
    expect(prisma.session).toBeDefined();
    expect(prisma.contact).toBeDefined();
    expect(prisma.passwordResetToken).toBeDefined();
  });
});
