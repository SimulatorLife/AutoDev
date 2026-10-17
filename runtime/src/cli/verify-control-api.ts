#!/usr/bin/env node

import { verifyControlApiCompatibility } from "@simulatorlife/autodev-runtime/cli/control-api-compatibility";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { readDevControlApiConfig } from "./dev.ts";

// When launchd starts or restarts `com.codex.model-router` and
// `com.codex.autodev-console` together, the Console preflight can run before
// the Router finishes binding its Control API port. Retry transient connection
// refusal up to the startup budget while failing immediately on auth or
// contract mismatches.
const DEFAULT_STARTUP_WAIT_MS = 30_000;
const startupWaitMs = parseNonNegativeInteger(
  process.env.AUTODEV_CONTROL_API_STARTUP_WAIT_MS,
  DEFAULT_STARTUP_WAIT_MS
);

try {
  await verifyControlApiCompatibility(
    readDevControlApiConfig(),
    globalThis.fetch,
    { timeoutMs: startupWaitMs }
  );
  writeLine("[console] AutoDev Control API compatibility verified.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeErrorLine(`[console] Startup blocked: ${message}`);
  process.exitCode = 1;
}
