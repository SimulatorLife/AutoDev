#!/usr/bin/env node

import { verifyControlApiCompatibility } from "@simulatorlife/autodev-runtime/cli/control-api-compatibility";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { readDevControlApiConfig } from "./dev.ts";

try {
  await verifyControlApiCompatibility(readDevControlApiConfig());
  writeLine("[console] AutoDev Control API compatibility verified.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeErrorLine(`[console] Startup blocked: ${message}`);
  process.exitCode = 1;
}
