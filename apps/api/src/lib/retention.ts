//
// Design spec §4.4: retentionDays is always resolved to a concrete value at link creation —
// never left to a later silent env-var fallback (that fallback existed before this file, in
// jobs/cleanup.ts's sweepExpiredDrops, and was removed by plan 1 Task 5 once Link.retentionDays
// became NOT NULL). It must never exceed DROP_RETENTION_DAYS_MAX, and never exceed the link's own
// expiry (a one-time link's content cannot outlive the link itself).
import { env } from "../env";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Callers typically compute `expiresAt` from their own `Date.now() + someWindow` a moment
// before calling this function, which re-reads `Date.now()` itself. Even a sub-millisecond
// gap between those two reads can make (expiresAt.getTime() - Date.now()) a hair under a
// whole number of days, and Math.floor would then collapse an intended "1 day of retention"
// window down to 0 — silently minting an already-expired link. This tolerance absorbs that
// realistic synchronous-code drift (up to a few seconds) while staying negligible relative to
// a day, so it can never turn a real rejection (see retention.test.ts's ~12h-short case) into
// an acceptance.
const RETENTION_CEILING_TOLERANCE_MS = 5_000;

export function resolveRetentionDays(
  requested: number | null | undefined,
  expiresAt: Date | null
): number | { error: string } {
  const maxByExpiry = expiresAt
    ? Math.floor((expiresAt.getTime() - Date.now() + RETENTION_CEILING_TOLERANCE_MS) / MS_PER_DAY)
    : Infinity;
  const ceiling = Math.min(env.DROP_RETENTION_DAYS_MAX, maxByExpiry);

  if (requested === null || requested === undefined) {
    return Math.min(env.DROP_RETENTION_DAYS_DEFAULT, ceiling);
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return { error: "retentionDays must be a positive whole number of days" };
  }
  if (requested > ceiling) {
    return {
      error:
        maxByExpiry < env.DROP_RETENTION_DAYS_MAX
          ? "retentionDays cannot exceed the link's own expiry"
          : `retentionDays cannot exceed ${env.DROP_RETENTION_DAYS_MAX}`,
    };
  }
  return requested;
}
