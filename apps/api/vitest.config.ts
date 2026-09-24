import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Route tests share a single Postgres database and each file's
    // beforeEach truncates the Link/Drop tables directly. Running test
    // files in parallel (vitest's default) lets one file's truncation
    // race another file's in-flight assertions, causing flaky failures.
    // Serialize file execution so DB-touching suites don't collide.
    fileParallelism: false,
  },
});
