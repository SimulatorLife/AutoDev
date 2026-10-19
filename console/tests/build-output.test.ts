import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER
} from "next/constants.js";

import {
  CONSOLE_BUILD_DIST_DIR,
  CONSOLE_DEV_DIST_DIR,
  consoleDistDir
} from "../src/lib/build-output.ts";

test("Console build, dev, and production server artifacts have distinct ownership", () => {
  assert.equal(consoleDistDir(PHASE_DEVELOPMENT_SERVER), CONSOLE_DEV_DIST_DIR);
  assert.equal(
    consoleDistDir(PHASE_PRODUCTION_BUILD, ".next-staging-123"),
    ".next-staging-123"
  );
  assert.equal(
    consoleDistDir(PHASE_PRODUCTION_BUILD, "../outside"),
    CONSOLE_BUILD_DIST_DIR
  );
  assert.equal(
    consoleDistDir(PHASE_PRODUCTION_SERVER, ".next-staging-123"),
    CONSOLE_BUILD_DIST_DIR
  );
  assert.equal(
    consoleDistDir(PHASE_PRODUCTION_SERVER, undefined, ".next-staging-e2e-123"),
    ".next-staging-e2e-123"
  );
  assert.equal(
    consoleDistDir(PHASE_PRODUCTION_SERVER, undefined, "../outside"),
    CONSOLE_BUILD_DIST_DIR
  );
});
