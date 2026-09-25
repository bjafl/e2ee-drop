// apps/api/src/test/setup.ts
//
// Runs before every API test file (vitest.config.ts setupFiles). The rate
// limiters in lib/rateLimit.ts are module-level Maps, and light-my-request's
// inject() uses the same remoteAddress for every call, so without a reset,
// e.g. users registered by earlier tests in a file would count toward the
// per-IP registration limit and spuriously 429 a later test. Tests that
// exercise a limiter still get a fresh window each, and can clear again
// mid-test if they need to.
import { beforeEach } from "vitest";
import { clearAllRateLimiters } from "../lib/rateLimit";

beforeEach(() => {
  clearAllRateLimiters();
});
