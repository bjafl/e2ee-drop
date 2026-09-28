// apps/api/src/lib/validation.ts
//
// Small, framework-agnostic input-validation helpers shared across routes.

// Every public key this codebase stores or accepts over the wire (User.publicKey,
// Link.recipientPublicKey, Drop.senderPublicKey) is a base64-encoded nacl.box
// public key, which is always exactly 32 raw bytes. `Buffer.from(str, "base64")`
// is deliberately lenient about malformed input — it silently drops characters
// outside the base64 alphabet and tolerates missing padding, so it never throws
// on garbage. That leniency is exactly why the length check below is load-bearing
// rather than redundant: it is the only thing that rejects a too-short/too-long
// decoding. For example the griefer case this helper exists for — claiming a
// request link with `"AAAA"` as the public key — decodes to 3 bytes, not 32, and
// is caught here before it can ever reach a downstream crypto call (which would
// otherwise fail with an opaque error, or for a claimed request link, no
// unclaim path, permanently brick it).
export function isValidPublicKeyBase64(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return Buffer.from(value, "base64").length === 32;
}

// User.email is `@unique` (packages/db/prisma/schema.prisma) but Postgres
// string equality on a plain text column is case-sensitive by default, so
// without normalization `Bob@x.com` and `bob@x.com` register/collide as two
// different accounts. Applied at every write (register) and every lookup
// (prelogin, login, password-reset request) so all of them agree on the same
// canonical form — normalizing only some of these would just move the
// mismatch elsewhere. No schema migration is needed: this only changes what
// gets written/looked-up going forward, not how `@unique` is enforced.
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
