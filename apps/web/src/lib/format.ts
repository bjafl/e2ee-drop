// apps/web/src/lib/format.ts
//
// Locale-aware display formatting (Flode: SI units, space as thousands separator
// and decimal comma in Norwegian UI, dates as 25.10.2026). Uses Intl with the
// active i18next language so en/nb both read naturally.
import i18n from "@/i18n";

function locale(): string {
  return i18n.language?.startsWith("nb") ? "nb-NO" : "en-GB";
}

/** Decimal (SI) byte sizes: 1 kB = 1000 B. 1234567 → "1,2 MB" (nb) / "1.2 MB" (en). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "–";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(value);
  return `${number} ${units[unit]}`;
}

export function formatDate(epochMs: number): string {
  return new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric" }).format(epochMs);
}

export function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(epochMs);
}

/** "25.10.2026 kl. 14:15" / "25/10/2026 at 14:15". */
export function formatDateTime(epochMs: number): string {
  return i18n.t("common:dateAt", { date: formatDate(epochMs), time: formatTime(epochMs) });
}

/**
 * Time left until `epochMs`, coarse: "om 21 t", "om 12 min", "om 3 dager".
 * Used where freshness is the point (link expiry); exact dates elsewhere.
 */
export function formatTimeLeft(epochMs: number, now: number = Date.now()): string {
  const diff = epochMs - now;
  if (diff <= 0) return i18n.t("common:relative.expired");
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return i18n.t("common:relative.justNow");
  if (minutes < 60) return i18n.t("common:relative.inMinutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return i18n.t("common:relative.inHours", { count: hours });
  return i18n.t("common:relative.inDays", { count: Math.round(hours / 24) });
}
