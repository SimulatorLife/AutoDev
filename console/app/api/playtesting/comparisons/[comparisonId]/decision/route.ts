/** Same-origin, typed owner decision; Runtime remains the authoritative writer. */
import type { ControlApiPlaytestingComparisonDecisionRequest } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../src/lib/server/form-mutation.ts";
import { recordPlaytestingComparisonDecision } from "../../../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 8192;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const COMPARISON_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const VERSION_PATTERN = /^[1-9]\d{0,15}$/u;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}

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

function failureStatus(
  result: Exclude<
    Awaited<ReturnType<typeof recordPlaytestingComparisonDecision>>,
    { kind: "ok" }
  >
): number {
  if (result.kind === "http-error" || result.kind === "unauthorized") {
    return result.status;
  }
  return result.kind === "unreachable" ? 503 : 502;
}

export async function POST(
  request: NextRequest,
  context: { readonly params: Promise<{ readonly comparisonId: string }> }
): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return sendError(
      403,
      "autodev_console_playtesting_origin_refused",
      "Comparison decisions must come from the Console's same origin."
    );
  }
  const { comparisonId } = await context.params;
  const form = await readStrictUrlEncodedFormBody(request, MAX_BODY_BYTES);
  const requiredFields = [
    "workspaceId",
    "expectedVersion",
    "disposition",
    "reason"
  ];
  if (
    !COMPARISON_ID_PATTERN.test(comparisonId) ||
    !form ||
    [...form.keys()].some((key) => !requiredFields.includes(key)) ||
    requiredFields.some((key) => form.getAll(key).length !== 1)
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_decision_request",
      "A comparison ID and one value for each typed decision field are required."
    );
  }
  const workspaceId = form.get("workspaceId")!.trim();
  const expectedVersionValue = form.get("expectedVersion")!;
  const disposition = form.get("disposition")!;
  const reason = form.get("reason")!;
  const expectedVersion = Number(expectedVersionValue);
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !VERSION_PATTERN.test(expectedVersionValue) ||
    !Number.isSafeInteger(expectedVersion) ||
    (disposition !== "promote" && disposition !== "hold") ||
    reason.trim().length === 0 ||
    reason.length > 4000 ||
    hasControlCharacters(reason)
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_decision_request",
      "The comparison decision fields are malformed or outside their limits."
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
  const decision: ControlApiPlaytestingComparisonDecisionRequest = {
    workspaceId,
    comparisonId,
    expectedVersion,
    disposition,
    reason
  };
  const result = await recordPlaytestingComparisonDecision(decision, config);
  if (result.kind !== "ok") {
    return sendError(
      failureStatus(result),
      controlApiFailureCode(result),
      result.message
    );
  }
  return NextResponse.json(
    { kind: "ok", data: result.data },
    { headers: { "cache-control": "no-store" } }
  );
}
