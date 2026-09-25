// apps/web/scripts/check-i18n-parity.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function flattenKeys(obj, prefix = "") {
  let keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys = keys.concat(flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

export function checkParity(localesDir) {
  const enDir = join(localesDir, "en");
  const nbDir = join(localesDir, "nb");
  const enFiles = new Set(readdirSync(enDir).filter((f) => f.endsWith(".json")));
  const nbFiles = new Set(readdirSync(nbDir).filter((f) => f.endsWith(".json")));

  const errors = [];
  for (const file of enFiles) {
    if (!nbFiles.has(file)) errors.push(`nb is missing locale file: ${file}`);
  }
  for (const file of nbFiles) {
    if (!enFiles.has(file)) errors.push(`en is missing locale file: ${file}`);
  }

  for (const file of enFiles) {
    if (!nbFiles.has(file)) continue;
    const enKeys = new Set(flattenKeys(JSON.parse(readFileSync(join(enDir, file), "utf-8"))));
    const nbKeys = new Set(flattenKeys(JSON.parse(readFileSync(join(nbDir, file), "utf-8"))));
    for (const key of enKeys) {
      if (!nbKeys.has(key)) errors.push(`${file}: nb is missing key "${key}"`);
    }
    for (const key of nbKeys) {
      if (!enKeys.has(key)) errors.push(`${file}: en is missing key "${key}"`);
    }
  }
  return errors;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const localesDir = fileURLToPath(new URL("../src/locales/", import.meta.url));
  const errors = checkParity(localesDir);
  if (errors.length > 0) {
    console.error("i18n parity check failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("i18n parity check passed.");
}
