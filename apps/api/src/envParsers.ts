// apps/api/src/envParsers.ts
//
// Env var parsers used by env.ts. Every parser fails CLOSED: a missing
// required value or a present-but-invalid value throws synchronously, so the
// process refuses to start (env.ts is evaluated at module load) with a
// message naming the variable, instead of booting with NaN or a silently
// wrong value that misbehaves later deep inside unrelated code (e.g.
// `fileSize > NaN` is always false, which disabled the upload size limit).
//
// An unset or empty value means "use the fallback" for optional vars, which
// matches .env.example leaving optional values blank (e.g. `SMTP_PORT=`).

type Source = Record<string, string | undefined>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

// Placeholder values shipped in .env.example. A real, randomly generated
// secret will never equal one of these; if it does, the operator forgot to
// replace it and every session cookie / TOTP secret would be keyed with a
// publicly known string.
const PLACEHOLDER_SECRETS: Record<string, readonly string[]> = {
  SESSION_SECRET: ["change-me-to-a-random-64-char-string"],
  APP_SECRET_KEY: ["change-me-to-another-random-32-byte-string"],
};

export function required(name: string, source: Source = process.env): string {
  const value = source[name];
  if (!value) throw new EnvError(`Missing required env var: ${name}`);
  return value;
}

/** A required secret that must also not be left at its .env.example placeholder. */
export function requiredSecret(name: string, source: Source = process.env): string {
  const value = required(name, source);
  if (PLACEHOLDER_SECRETS[name]?.includes(value)) {
    throw new EnvError(
      `Env var ${name} is still set to the placeholder value from .env.example. ` +
        `Generate a real secret (e.g. \`openssl rand -hex 32\`) and set ${name} to it.`
    );
  }
  return value;
}

export interface IntOptions {
  min?: number;
  max?: number;
}

function parseIntStrict(name: string, raw: string, { min = 0, max = Number.MAX_SAFE_INTEGER }: IntOptions): number {
  const trimmed = raw.trim();
  const parsed = /^-?\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new EnvError(
      `Invalid value for env var ${name}: ${JSON.stringify(raw)}. ` +
        `Expected a whole number between ${min} and ${max}.`
    );
  }
  return parsed;
}

export function int(name: string, fallback: number, options: IntOptions = {}, source: Source = process.env): number {
  const value = source[name];
  return value ? parseIntStrict(name, value, options) : fallback;
}

export function optionalInt(name: string, options: IntOptions = {}, source: Source = process.env): number | undefined {
  const value = source[name];
  return value ? parseIntStrict(name, value, options) : undefined;
}

// Unlike int(), an EMPTY value is not treated as unset here: it keeps its
// historical meaning of `false`. docker-compose.yml passes
// `ALLOW_REGISTRATION: ${ALLOW_REGISTRATION}`, so an operator whose .env
// omits the line gets "" and registration disabled; mapping "" to the
// fallback (true) would silently flip that to enabled.
export function bool(name: string, fallback: boolean, source: Source = process.env): boolean {
  const value = source[name];
  if (value === undefined) return fallback;
  if (value === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new EnvError(
    `Invalid value for env var ${name}: ${JSON.stringify(value)}. Expected "true" or "false".`
  );
}
