import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
// jsdom has no native Worker implementation. @vitest/web-worker patches the
// global Worker constructor so `new Worker(new URL(...), { type: "module" })`
// actually loads and executes the referenced module (in-thread), letting
// hook tests exercise the real crypto.worker.ts instead of a hand-rolled
// mock. See apps/web/src/hooks/useFileEncryption.test.ts.
import "@vitest/web-worker";

// @testing-library/react only self-registers its afterEach(cleanup) when it
// detects a global `afterEach` (see its dist/index.js: `if (typeof afterEach
// === 'function') { afterEach(cleanup) }`). This project's vitest.config.ts
// does not set `test.globals: true`, so `afterEach` is never a global here
// and that auto-registration never fires. Without this, render() calls
// across multiple `it()` blocks in the same test file accumulate DOM nodes
// instead of being torn down, causing intermittent "found multiple
// elements" failures. Register it explicitly instead.
afterEach(() => {
  cleanup();
});
