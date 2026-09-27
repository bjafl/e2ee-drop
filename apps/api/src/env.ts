// apps/api/src/env.ts
import { required, requiredSecret, int, optionalInt, bool, httpUrl, isHttpsUrl } from "./envParsers";

// Evaluated at module load: any missing or invalid value throws here and the
// process refuses to start, naming the offending variable (see envParsers.ts).
const APP_URL = httpUrl("APP_URL", "http://localhost:8080");

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: int("PORT", 3000, { min: 1, max: 65535 }),
  MAX_FILE_SIZE_BYTES: int("MAX_FILE_SIZE_BYTES", 500 * 1024 * 1024, { min: 1 }),
  LINK_EXPIRY_HOURS: int("LINK_EXPIRY_HOURS", 24, { min: 1 }),
  DROP_RETENTION_DAYS_DEFAULT: int("DROP_RETENTION_DAYS_DEFAULT", 1),
  DROP_RETENTION_DAYS_MAX: int("DROP_RETENTION_DAYS_MAX", 7),
  AUDIT_RETENTION_DAYS: int("AUDIT_RETENTION_DAYS", 30),
  // Number of words in a link's verification phrase (lib/codewords.ts). Each
  // word is one byte of a SHA-256 hash indexed into a 256-word list, so N
  // words give 256^N possible phrases (4 words = ~4.3 billion). Floored at 4:
  // below that, the odds of two unrelated, simultaneously active links
  // coincidentally sharing a phrase climb too fast as the total active-link
  // count grows (see the design discussion this constant came from — at 4
  // words that stays comfortably small into the thousands of concurrently
  // active links; at 3 it's already ~3% at just 1,000).
  CODEWORD_WORD_COUNT: int("CODEWORD_WORD_COUNT", 4, { min: 4 }),
  // Internal endpoint for server-to-MinIO calls (bucket setup, deletes).
  MINIO_ENDPOINT: required("MINIO_ENDPOINT"),
  // Browser-reachable endpoint embedded in presigned upload/download URLs.
  // May include a path prefix handled by a reverse proxy (e.g. http://localhost:8080/s3).
  // Falls back to MINIO_ENDPOINT when unset (e.g. local dev hitting MinIO directly).
  MINIO_PUBLIC_ENDPOINT: process.env.MINIO_PUBLIC_ENDPOINT || undefined,
  MINIO_REGION: process.env.MINIO_REGION ?? "us-east-1",
  MINIO_BUCKET: required("MINIO_BUCKET"),
  MINIO_ACCESS_KEY: required("MINIO_ACCESS_KEY"),
  MINIO_SECRET_KEY: required("MINIO_SECRET_KEY"),
  SESSION_SECRET: requiredSecret("SESSION_SECRET"),
  APP_SECRET_KEY: requiredSecret("APP_SECRET_KEY"),
  ALLOW_REGISTRATION: bool("ALLOW_REGISTRATION", true),
  DEFAULT_STORAGE_QUOTA_BYTES: int("DEFAULT_STORAGE_QUOTA_BYTES", 5 * 1024 * 1024 * 1024),
  // Number of reverse-proxy hops in front of the API whose X-Forwarded-For
  // entries are trusted when resolving request.ip (see lib/trustProxy.ts).
  // 1 = the shipped web/nginx container only; 2 = your own proxy in front of it.
  TRUST_PROXY_HOPS: int("TRUST_PROXY_HOPS", 1),
  // The app's public origin, as the browser sees it (used in emailed links).
  APP_URL,
  // Whether the session cookie gets the `Secure` attribute. Derived from
  // APP_URL rather than the request's protocol: TLS terminates at the
  // operator's reverse proxy (README "Fronting with TLS"), so the API itself
  // only ever sees plain HTTP from nginx. An https:// APP_URL means browsers
  // reach this deployment over TLS, so the cookie must never travel in
  // cleartext; an http:// APP_URL (local dev) must NOT set it, or browsers
  // would refuse to send the cookie back and login would silently break.
  SECURE_COOKIES: isHttpsUrl(APP_URL),
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: optionalInt("SMTP_PORT", { min: 1, max: 65535 }),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  SMTP_FROM: process.env.SMTP_FROM,
};
