#!/usr/bin/env node

import {
  ControlApiUnavailableError,
  verifyControlApiCompatibility
} from "@simulatorlife/autodev-runtime/cli/control-api-compatibility";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { SERVICE_TEMPORARY_FAILURE_EXIT_CODE } from "@simulatorlife/autodev-runtime/shared/service-lifecycle";

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
  // The Control API did not answer. That is not a stale contract and not a
  // rejected credential: the service may well serve on the next attempt, so
  // the exit status says so and the supervisor keeps waiting.
  process.exitCode =
    error instanceof ControlApiUnavailableError
      ? SERVICE_TEMPORARY_FAILURE_EXIT_CODE
      : 1;
}
