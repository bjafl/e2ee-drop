// apps/api/src/lib/totpBackupCodes.ts
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@e2ee-drop/db";

// Excludes 0, 1, i, l, o — all visually confusable with a digit or with each
// other in a hand-copied code. 31 characters.
const BACKUP_CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 10; // split into two groups of 5 for display
const CODES_PER_BATCH = 10;

function randomBackupCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Normalizes a user-submitted backup code before hashing, so a correctly
// typed code still matches its stored hash despite stray case or whitespace
// (a real user hand-copying a 10-character code from a saved list is prone
// to both). Trims, lowercases, strips every character not in the backup-code
// alphabet (including the separating hyphen, which is dropped along with
// anything else and re-inserted below), then re-inserts the hyphen at the
// fixed position `generateAndStoreBackupCodes` and `randomBackupCode` above
// use (after the 5th alphabet character) — so this must stay in sync with
// CODE_LENGTH/that split if either ever changes. Does NOT reject malformed
// input here: an input that normalizes to the wrong value simply won't match
// any stored hash, which is exactly the existing "invalid code" outcome.
function normalizeBackupCodeInput(code: string): string {
  const alphabetOnly = code
    .trim()
    .toLowerCase()
    .split("")
    .filter((ch) => BACKUP_CODE_ALPHABET.includes(ch))
    .join("");
  return `${alphabetOnly.slice(0, 5)}-${alphabetOnly.slice(5)}`;
}

// Deletes every existing unused code for the user and inserts a fresh batch of
// CODES_PER_BATCH, in one transaction, so a caller never observes a state with
// both an old and a new batch simultaneously valid. Returns the plaintext
// codes — the only place they ever exist outside the caller's own memory.
export async function generateAndStoreBackupCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: CODES_PER_BATCH }, randomBackupCode);
  await prisma.$transaction([
    prisma.totpBackupCode.deleteMany({ where: { userId, usedAt: null } }),
    prisma.totpBackupCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashBackupCode(code) })),
    }),
  ]);
  return codes;
}

// Atomically consumes a backup code if it exists, belongs to this user, and is
// unused — compare-and-swap via updateMany's where clause (same discipline as
// transitionDropStatus in lib/links.ts), so two concurrent login attempts with
// the same code can't both succeed.
export async function consumeBackupCodeIfValid(userId: string, code: string): Promise<boolean> {
  const { count } = await prisma.totpBackupCode.updateMany({
    where: { userId, codeHash: hashBackupCode(normalizeBackupCodeInput(code)), usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}
