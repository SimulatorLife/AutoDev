#!/usr/bin/env node

/**
 * Verify the deployed AutoDev Usage response contract, and report the result
 * as a supervised service's exit status.
 *
 * The Data layer owns the contract -- the response schema, the query it
 * validates, and the class of every outcome. This module owns what each
 * class means for a service that launchd supervises: a Usage API that did
 * not answer is a temporary failure, because the service may well serve on
 * the next attempt, while a stale contract or a rejected credential is not.
 *
 * That distinction is the whole point of the exit status. A supervisor that
 * reads every non-zero status as "broken" declares a crash loop on a Console
 * that was about to serve.
 */

import { verifyUsageContract } from "@simulatorlife/autodev-data";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { SERVICE_TEMPORARY_FAILURE_EXIT_CODE } from "../shared/service-lifecycle.ts";

const outcome = await verifyUsageContract();

switch (outcome.kind) {
  case "ok": {
    writeLine("[openlit] Usage v5 response contract verified.");
    break;
  }
  case "invalid-response": {
    writeErrorLine(
      "[openlit] Usage API returned a response that does not match the required v5 contract. Rebuild/reconcile the patched OpenLIT image."
    );
    process.exitCode = 1;
    break;
  }
  case "unauthorized": {
    writeErrorLine(
      `[openlit] Usage API rejected its server credential with HTTP ${outcome.status}.`
    );
    process.exitCode = 1;
    break;
  }
  case "http-error": {
    writeErrorLine(
      `[openlit] Usage API returned HTTP ${outcome.status} during contract verification.`
    );
    process.exitCode = 1;
    break;
  }
  case "unreachable": {
    // The Usage API did not answer. That is not a stale contract -- it is a
    // backend that has not come up yet, and the supervisor has to be able to
    // tell the two apart.
    writeErrorLine(
      "[openlit] Usage API could not be reached during contract verification."
    );
    process.exitCode = SERVICE_TEMPORARY_FAILURE_EXIT_CODE;
    break;
  }
  case "not-configured": {
    writeErrorLine(
      "[openlit] AUTODEV_OPENLIT_USAGE_TOKEN is required to verify the Usage API."
    );
    process.exitCode = 1;
    break;
  }
}
