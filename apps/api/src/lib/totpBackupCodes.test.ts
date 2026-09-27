// apps/api/src/lib/totpBackupCodes.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@e2ee-drop/db";
import { generateAndStoreBackupCodes, consumeBackupCodeIfValid } from "./totpBackupCodes";

describe("totpBackupCodes", () => {
  let userId: string;

  beforeEach(async () => {
    await prisma.totpBackupCode.deleteMany();
    await prisma.session.deleteMany();
    await prisma.link.deleteMany();
    await prisma.user.deleteMany();
    const user = await prisma.user.create({
      data: {
        email: "backup@example.com",
        username: "backupuser",
        name: "Backup",
        passwordHash: "h",
        passwordSalt: "s",
        passwordWrappedPrivateKey: "w",
        recoveryWrappedPrivateKey: "r",
        publicKey: "k",
        storageQuotaBytes: 1000n,
      },
    });
    userId = user.id;
  });

  it("generates exactly 10 codes matching the expected format", async () => {
    const codes = await generateAndStoreBackupCodes(userId);
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[23456789a-hj-km-np-z]{5}-[23456789a-hj-km-np-z]{5}$/);
    }
    // No duplicates within a batch.
    expect(new Set(codes).size).toBe(10);
  });

  it("regenerating invalidates all previously unused codes", async () => {
    const firstBatch = await generateAndStoreBackupCodes(userId);
    const secondBatch = await generateAndStoreBackupCodes(userId);

    const firstStillValid = await consumeBackupCodeIfValid(userId, firstBatch[0]);
    expect(firstStillValid).toBe(false);

    const secondValid = await consumeBackupCodeIfValid(userId, secondBatch[0]);
    expect(secondValid).toBe(true);
  });

  it("a used code cannot be reused", async () => {
    const codes = await generateAndStoreBackupCodes(userId);
    const firstUse = await consumeBackupCodeIfValid(userId, codes[0]);
    expect(firstUse).toBe(true);
    const secondUse = await consumeBackupCodeIfValid(userId, codes[0]);
    expect(secondUse).toBe(false);
  });

  it("rejects a code that was never issued", async () => {
    await generateAndStoreBackupCodes(userId);
    const result = await consumeBackupCodeIfValid(userId, "zzzzz-zzzzz");
    expect(result).toBe(false);
  });

  // Regression test: a real user hand-copying a code is prone to stray case
  // and whitespace, and previously this hashed the raw input, so a
  // correctly-typed-but-differently-cased/padded code hashed to a different
  // value than the stored hash and was wrongly rejected as "invalid code".
  it("accepts an uppercased, whitespace-padded variant of a real code", async () => {
    const codes = await generateAndStoreBackupCodes(userId);
    const messy = `  ${codes[0].toUpperCase()}  `;
    const result = await consumeBackupCodeIfValid(userId, messy);
    expect(result).toBe(true);
  });
});
