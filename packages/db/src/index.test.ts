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

  it("creates a user with allowContactRequests defaulting to true, and a blocked contact row", async () => {
    const user = await prisma.user.create({
      data: {
        email: "col-check@example.com",
        username: "colcheck",
        name: "Col Check",
        passwordHash: "h",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "pk",
        storageQuotaBytes: 1000n,
      },
    });
    expect(user.allowContactRequests).toBe(true);

    const other = await prisma.user.create({
      data: { ...user, id: undefined, email: "col-check-2@example.com", username: "colcheck2", publicKey: "pk2" },
    });
    const contact = await prisma.contact.create({
      data: { userId: user.id, contactUserId: other.id, status: "blocked", blockedByUserId: user.id },
    });
    expect(contact.blockedByUserId).toBe(user.id);
  });
});
