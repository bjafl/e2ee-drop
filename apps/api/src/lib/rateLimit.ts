// apps/api/src/lib/rateLimit.ts
//
// Lightweight in-memory, per-key rate limiting for a small number of
// especially sensitive endpoints (see the limiter instances at the bottom
// of this file for the full list and each one's key and reasoning). This is deliberately NOT a general Fastify rate-limit
// plugin applied globally; it's scoped to just the routes that need it.
//
// Implemented as a small in-process Map with TTL-style pruning rather than
// reaching for an external store (e.g. Redis), following this codebase's
// existing pattern for exactly that trade-off — see totpReplayGuard.ts's
// own module-level Map + pruning, and dropEvents.ts's in-process
// EventEmitter instead of a pub/sub broker. The app's spec targets
// single-instance deployment (no distributed state), so a per-process Map
// is sufficient and avoids a new infrastructure dependency; it does mean
// state resets on process restart and isn't shared across instances if
// this app is ever horizontally scaled, which is an accepted limitation
// here (same one totpReplayGuard.ts and dropEvents.ts already accept).
//
// Algorithm: a fixed window counter per key (not a sliding window). Each
// key tracks a count and when its current window started; once `windowMs`
// has elapsed since that start, the next attempt begins a fresh window
// with count 1. Simple, and sufficient for "a handful of attempts per
// short window" — no need for the extra bookkeeping a sliding-window or
// token-bucket implementation would add.

interface WindowEntry {
  count: number;
  windowStart: number;
}

export interface RateLimiter {
  /**
   * Records one attempt for `key` and returns whether it's allowed: true if
   * `key` is still under `maxAttempts` within the current window, false if
   * the limit has been reached (the caller should reject the request, e.g.
   * with 429, and must NOT otherwise treat this as a successful attempt).
   */
  attempt(key: string): boolean;
  /** Test-only: discards all tracked state, as if the process had just started. */
  clear(): void;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxAttempts: number;
}

// Every limiter ever created, so tests can reset all of them at once (see
// clearAllRateLimiters). Only module-level singletons are created in
// practice, so this never grows beyond the handful declared below.
const allLimiters: RateLimiter[] = [];

/**
 * Test-only: clears every limiter's state. Called from the API test setup
 * file (src/test/setup.ts) before each test, because light-my-request's
 * inject() uses the same remoteAddress for every call — without this, e.g.
 * user registrations made by earlier tests in a file would count toward the
 * registration limit and spuriously 429 a later test.
 */
export function clearAllRateLimiters(): void {
  for (const limiter of allLimiters) limiter.clear();
}

export function createRateLimiter({ windowMs, maxAttempts }: RateLimiterOptions): RateLimiter {
  const windows = new Map<string, WindowEntry>();

  // Without pruning, `windows` would retain one entry per distinct key
  // (IP address, or user id) for the lifetime of the process — unbounded
  // growth under sustained traffic from many distinct callers. A full-map
  // sweep is O(distinct keys currently tracked), so it runs at most once
  // per window (not on every attempt()) to keep attempt() itself cheap
  // even with many distinct keys in flight.
  let lastPruneAt = Date.now();

  function pruneExpired(now: number): void {
    if (now - lastPruneAt < windowMs) return;
    lastPruneAt = now;
    for (const [key, entry] of windows) {
      if (now - entry.windowStart >= windowMs) windows.delete(key);
    }
  }

  const limiter: RateLimiter = {
    attempt(key: string): boolean {
      const now = Date.now();
      pruneExpired(now);

      const entry = windows.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        windows.set(key, { count: 1, windowStart: now });
        return true;
      }
      if (entry.count >= maxAttempts) return false;
      entry.count += 1;
      return true;
    },
    clear(): void {
      windows.clear();
      lastPruneAt = Date.now();
    },
  };
  allLimiters.push(limiter);
  return limiter;
}

// POST /api/auth/login, keyed by request.ip (see server.ts's trustProxy
// for how that resolves to the real client IP behind the shipped nginx —
// apps/web/nginx.conf). This is a password-guessing surface even with the
// existing dummy-hash timing mitigation (see auth.ts). 8 attempts per minute is generous
// enough to absorb a legitimate user mistyping their password a couple of
// times (including a TOTP retry) while still blunting automated guessing —
// deliberately simple (no escalating lockout), per this task's scope.
export const loginRateLimiter = createRateLimiter({ windowMs: 60_000, maxAttempts: 8 });

// DELETE /api/account, keyed by the authenticated user's id (not IP — a
// shared IP, e.g. multiple users behind one NAT/VPN, must not collide).
// This route already requires a valid session AND the current authKey as
// re-confirmation (see account.ts); a legitimate user should essentially
// never call it more than once. Kept much stricter than /login's limit:
// 5 attempts per 15 minutes is enough for a genuine mistaken password
// entry or two, without giving an attacker holding a stolen session
// cookie a useful number of guesses at the account password.
export const accountDeletionRateLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 5 });

// POST /api/auth/2fa/enable and POST /api/auth/2fa/disable (one shared
// limiter across both routes), keyed by the authenticated user's id — same
// reasoning as accountDeletionRateLimiter for why not IP. Both routes verify
// a 6-digit TOTP code, and verifyTotpCode (lib/totp.ts) accepts ±1 time step,
// so ~3 of the 1,000,000 codes are valid at any moment; unthrottled, an
// attacker holding a stolen session cookie could brute-force /2fa/disable
// (stripping the account's second factor) in well under an hour. 5 attempts
// per 15 minutes caps that at ~480 guesses/day (~0.14% daily success odds),
// while a legitimate user — who types one code, maybe retries once or twice
// — never notices. Shared across both routes because they're mutually
// exclusive states (enable requires 2FA off, disable requires it on), so
// separate buckets would only add attacker budget, never legitimate headroom.
export const twoFactorRateLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 5 });

// POST /api/auth/register, keyed by request.ip (unauthenticated — same
// reasoning as loginRateLimiter). Each attempt runs a real Argon2id hash
// (~19 MiB memory-hard, lib/passwordAuth.ts) and can create a user row, so
// unthrottled registration is both a CPU/memory-exhaustion and a
// row-spam vector. A legitimate user registers once, perhaps retrying a
// few times after a validation error (e.g. a taken username); 10 per 15
// minutes leaves room for that (and for a few people behind one NAT) while
// capping a single IP at 40 hashes/accounts per hour.
export const registerRateLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 10 });

// POST /api/auth/password-reset/request, keyed by request.ip. Stops one
// caller from email-bombing a registered address (each accepted request
// sends a real email when a mailer is configured) or flooding the
// PasswordResetToken table. Deliberately keyed by the CALLER's IP, never by
// the submitted email: the limit is consumed identically whether or not the
// email belongs to an account, so a 429 carries no information about which
// emails are registered (preserving the route's anti-enumeration design).
// Requesting a reset more than a couple of times in quick succession is
// already unusual for a real user, hence stricter than login/register.
export const passwordResetRequestRateLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 5 });

// TOTP-code guesses on POST /api/auth/password-reset/complete and
// /complete-fresh (one shared limiter across both routes), keyed by the
// reset token's user id — NOT by IP or by token. A requiresTotp / wrong-code
// rejection deliberately does NOT consume the reset token (see
// routes/passwordReset.ts), so without this cap an attacker holding only the
// emailed token could brute-force the 6-digit code (~3 of 1,000,000 valid at
// any moment, per verifyTotpCode's ±1 step) for the token's full hour.
// Keying by user id means requesting more reset emails, or rotating IPs,
// buys no extra guesses. Same budget and reasoning as twoFactorRateLimiter:
// 5 per 15 minutes (~0.14% daily success odds), which a legitimate user
// mistyping a code once or twice never hits. Only attempts that actually
// submit a code count; a bare "code required" prompt does not.
export const passwordResetTotpRateLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 5 });

// POST /api/auth/verify-email/resend, keyed by the authenticated caller's user id
// (not IP — unlike passwordResetRequestRateLimiter, this is an authenticated
// action and the caller already knows their own email, so there's no
// enumeration concern to key around). Each accepted call sends a real email
// when a mailer is configured; 3 per 15 minutes is enough for a legitimate
// "I didn't get it, resend" click or two without letting a bored user (or a
// stolen session) email-bomb an address.
export const emailVerificationResendRateLimiter = createRateLimiter({ windowMs: 15 * 60_000, maxAttempts: 3 });

// POST /api/links/:slug/upload-url, keyed by request.ip (the unauthenticated
// sender), NOT by the link or its owner: a public inbox is legitimately hit
// by many different senders, and keying by the target would let one abusive
// caller lock every other sender out of that link. Each call on an owned
// link reserves fileSize + overhead against the owner's quota for up to
// UPLOAD_RESERVATION_WINDOW_MS (lib/quota.ts) whether or not anything is
// ever uploaded, so this bounds how fast one IP can create such
// reservations. (How MANY bytes one sender may hold in reservations against
// one owner at a time is capped separately, by assertWithinSenderShare in
// lib/quota.ts — a request-rate limit alone can't stop a slow, patient
// reservation flood.) The web client (UploadPage.tsx) makes one call per file, so
// 20 per minute absorbs retries after network hiccups and a small office
// NAT's worth of senders without affecting normal use.
export const uploadUrlRateLimiter = createRateLimiter({ windowMs: 60_000, maxAttempts: 20 });

// Consistent with this codebase's other rejected-request bodies, e.g.
// { error: "Authentication required" } (plugins/auth.ts) and
// { error: "Incorrect password" } (account.ts).
export function rateLimitExceededBody(): { error: string } {
  return { error: "Too many attempts. Please try again later." };
}
