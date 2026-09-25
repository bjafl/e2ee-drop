// apps/api/src/lib/totpReplayGuard.ts
//
// In-memory, per-user TOTP replay guard (spec §13: single-instance
// deployment, no external store required). Two login-adjacent entry points
// into `verifyTotpCode` (lib/totp.ts) share this one module-level store:
// POST /api/auth/login (Task 10) and 2FA enable (Task 12) — sharing it
// means a code accepted by one flow can't be replayed against the other,
// for the same user, which is the whole point of a *durable* per-user
// store (verifyTotpCode's own doc comment flags a fresh-Set-per-call as
// insufficient).
//
// A TOTP code is only ever valid for a short window (30s step, ±1 step
// tolerance in verifyTotpCode ⇒ ~90s total). Without any cleanup,
// `usedCodesByUser` would retain every code any user ever submitted for
// the lifetime of the running process — unbounded growth. That's
// low-severity here (short strings, a small self-hosted app, infrequent
// logins) but it's still a genuine "never cleans up" bug, and the fix is
// cheap enough that leaving it as a documented limitation isn't
// warranted. Each used code is timestamped and opportunistically pruned
// once it's older than TOTP_CODE_TTL_MS — pruning runs on every call into
// this module, piggybacking on login/enable traffic, so no background
// timer/interval is needed.
const TOTP_CODE_TTL_MS = 5 * 60 * 1000; // generous vs. the ~90s validity window

const usedCodesByUser = new Map<string, Map<string, number>>();

function pruneExpired(timestamps: Map<string, number>): void {
  const cutoff = Date.now() - TOTP_CODE_TTL_MS;
  for (const [code, usedAt] of timestamps) {
    if (usedAt < cutoff) timestamps.delete(code);
  }
}

// A thin Set<string> that mirrors adds back into the durable, timestamped
// store behind it — this is what lets `getUsedCodesForUser`'s return type
// stay a plain `Set<string>` (matching `verifyTotpCode`'s existing
// `usedCodes: Set<string>` parameter) while still recording *when* each
// code was used, for pruning.
class TrackedCodeSet extends Set<string> {
  private readonly timestamps: Map<string, number>;

  constructor(timestamps: Map<string, number>) {
    // Deliberately NOT `super(timestamps.keys())`: Set's own constructor
    // populates itself by calling `this.add()` for each item in the given
    // iterable, synchronously, *before* this subclass's own constructor
    // body (and thus the `this.timestamps = timestamps` assignment below)
    // has run — so the overridden `add()` below would dereference
    // `this.timestamps` while it's still undefined. Calling `super()` with
    // no argument, then assigning `this.timestamps`, then seeding entries
    // via `super.add()` (bypassing the override, so seeding doesn't bump
    // timestamps) avoids that ordering hazard entirely.
    super();
    this.timestamps = timestamps;
    for (const code of timestamps.keys()) {
      super.add(code);
    }
  }

  override add(code: string): this {
    super.add(code);
    this.timestamps.set(code, Date.now());
    return this;
  }
}

export function getUsedCodesForUser(userId: string): Set<string> {
  let timestamps = usedCodesByUser.get(userId);
  if (!timestamps) {
    timestamps = new Map();
    usedCodesByUser.set(userId, timestamps);
  }
  pruneExpired(timestamps);
  return new TrackedCodeSet(timestamps);
}
