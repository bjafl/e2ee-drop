// apps/web/src/lib/passwordPolicy.ts
//
// Minimum-length policy for any password the user SETS (registration and both
// password-reset completion paths). Deliberately length-only: no composition
// rules (uppercase/digit/symbol), per NIST SP 800-63B, which recommends
// against them — length is what actually buys guessing resistance.
//
// WHY THIS IS CLIENT-SIDE ONLY: the server never receives the password. It
// receives authKey = Argon2id(password, ...) (see keyWrapping.ts), a fixed
// 32-byte value whose length says nothing about the password behind it, and
// it cannot recover the password to measure it — that is the whole point of
// the zero-knowledge design. A server-side "password length" check would need
// the client to send the length (or the password) alongside, which (a) leaks
// information that narrows an offline attack and (b) is a client-asserted
// claim that anyone bypassing this UI can simply lie about, so it would add
// no enforcement. The party this policy protects is the account holder
// themself (whose key material a weak password exposes to an offline attack
// after a DB compromise); someone deliberately bypassing the client to pick a
// weak password for their OWN account is only harming themselves.
//
// WHY 12 (not NIST's 8 baseline): here the password is the sole protection of
// passwordWrappedPrivateKey against an OFFLINE attack once the database leaks
// — the wrapped key and its passwordSalt are both stored server-side, so an
// attacker can trial-decrypt at their own pace with no rate limit, and 2FA
// does not help (TOTP gates login, not the key wrapping). NIST's 8-character
// floor assumes online throttling or an additional factor; the relevant
// benchmarks for an offline-attackable, effectively single-factor secret are
// higher (NIST SP 800-63B-4: 15 for single-factor passwords; OWASP ASVS
// 4.0.3 V2.1.1: 12). 12 roughly squares the search space of an 8-character
// password of the same alphabet while still being easy to meet with a
// passphrase; Argon2id's per-guess cost (m=19 MiB, t=2) covers the rest.
export const MIN_PASSWORD_LENGTH = 12;

// Counts Unicode code points, not UTF-16 code units (NIST SP 800-63B: each
// code point counts as one character), so e.g. an emoji is one character,
// not two — a user is never told "long enough" on the strength of surrogate
// halves, nor rejected for a genuinely 12-character non-BMP password.
export function passwordLength(password: string): number {
  return Array.from(password).length;
}

export function isPasswordLongEnough(password: string): boolean {
  return passwordLength(password) >= MIN_PASSWORD_LENGTH;
}
