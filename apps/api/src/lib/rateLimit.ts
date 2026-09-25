// apps/api/src/lib/rateLimit.ts
//
// Lightweight in-memory, per-key rate limiting for a small number of
// especially sensitive endpoints (currently: POST /api/auth/login, keyed by
// IP, and DELETE /api/account, keyed by user id — see auth.ts and
// account.ts). This is deliberately NOT a general Fastify rate-limit
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

  return {
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
}

// POST /api/auth/login, keyed by request.ip (see server.ts's trustProxy
// for how that resolves to the real client IP behind the shipped nginx —
// apps/web/nginx.conf). This is a password-guessing surface even with the
// existing dummy-hash timing mitigation (see auth.ts), so it's the one
// unauthenticated route in this pair. 8 attempts per minute is generous
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

// Consistent with this codebase's other rejected-request bodies, e.g.
// { error: "Authentication required" } (plugins/auth.ts) and
// { error: "Incorrect password" } (account.ts).
export function rateLimitExceededBody(): { error: string } {
  return { error: "Too many attempts. Please try again later." };
}
