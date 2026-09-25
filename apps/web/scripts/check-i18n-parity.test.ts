// apps/web/scripts/check-i18n-parity.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkParity } from "./check-i18n-parity.mjs";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(files: { en: Record<string, unknown>; nb: Record<string, unknown> }) {
  tempDir = mkdtempSync(join(tmpdir(), "i18n-parity-"));
  mkdirSync(join(tempDir, "en"));
  mkdirSync(join(tempDir, "nb"));
  for (const [locale, content] of Object.entries(files)) {
    writeFileSync(join(tempDir, locale, "common.json"), JSON.stringify(content));
  }
  return tempDir;
}

describe("checkParity", () => {
  it("returns no errors when en and nb have identical key sets", () => {
    const dir = writeFixture({
      en: { title: "Hello", nested: { a: "1" } },
      nb: { title: "Hallo", nested: { a: "1" } },
    });
    expect(checkParity(dir)).toEqual([]);
  });

  it("reports a key missing from nb", () => {
    const dir = writeFixture({
      en: { title: "Hello", extra: "x" },
      nb: { title: "Hallo" },
    });
    expect(checkParity(dir)).toContain('common.json: nb is missing key "extra"');
  });

  it("reports a key missing from en", () => {
    const dir = writeFixture({
      en: { title: "Hello" },
      nb: { title: "Hallo", extra: "x" },
    });
    expect(checkParity(dir)).toContain('common.json: en is missing key "extra"');
  });
});
