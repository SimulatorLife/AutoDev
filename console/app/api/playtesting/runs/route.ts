/** Server-only, typed Playtesting run request; Runtime owns approval and execution. */
import type { ControlApiPlaytestingRunRequest } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import { startPlaytestingRun } from "../../../playtesting/playtesting-server.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4096;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const SAFE_FIELD_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const STEP_PATTERN = /^[1-9]\d{0,5}$/u;
const ALLOWED_FIELDS = new Set([
  "workspaceId",
  "scenario",
  "policy",
  "seed",
  "maxSteps"
]);

function sendError(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json(
    { kind: "error", code, message },
    { status, headers: { "cache-control": "no-store" } }
  );
}

function oneField(form: URLSearchParams, key: string): string | null {
  const values = form.getAll(key);
  if (values.length !== 1) return null;
  const value = values[0]!.trim();
  return SAFE_FIELD_PATTERN.test(value) ? value : null;
}

function failureStatus(
  result: Exclude<
    Awaited<ReturnType<typeof startPlaytestingRun>>,
    { kind: "ok" }
  >
): number {
  if (result.kind === "http-error" || result.kind === "unauthorized") {
    return result.status;
  }
  return result.kind === "unreachable" ? 503 : 502;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return sendError(
      403,
      "autodev_console_playtesting_origin_refused",
      "Run requests must come from the Console's same origin."
    );
  }
  const form = await readStrictUrlEncodedFormBody(request, MAX_BODY_BYTES);
  if (!form || [...form.keys()].some((key) => !ALLOWED_FIELDS.has(key))) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "The typed playtest run form is invalid."
    );
  }
  const workspaceId = oneField(form, "workspaceId");
  const scenario = oneField(form, "scenario");
  const policy = oneField(form, "policy");
  const seed = oneField(form, "seed");
  const maxStepsText = form.getAll("maxSteps");
  const maxSteps =
    maxStepsText.length === 1 && STEP_PATTERN.test(maxStepsText[0]!.trim())
      ? Number(maxStepsText[0]!.trim())
      : null;
  if (
    !workspaceId ||
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !scenario ||
    !policy ||
    !seed ||
    maxSteps === null ||
    maxSteps > 100_000
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "Workspace, scenario, policy, seed, and a bounded step budget are required."
    );
  }
  const config = readControlApiConfig();
  if (!config) {
    return sendError(
      503,
      "autodev_console_control_api_unavailable",
      "The server-side Control API credential is not configured."
    );
  }
  const requestBody: ControlApiPlaytestingRunRequest = {
    workspaceId,
    scenario,
    policy,
    seed,
    maxSteps
  };
  const result = await startPlaytestingRun(requestBody, config);
  if (result.kind !== "ok") {
    return sendError(
      failureStatus(result),
      controlApiFailureCode(result),
      result.message
    );
  }
  return NextResponse.json(
    { kind: "ok", data: result.data },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
