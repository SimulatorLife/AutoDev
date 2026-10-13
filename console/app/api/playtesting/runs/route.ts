/** Server-only, typed Playtesting batch request; Runtime owns approval and execution. */
import {
  type ControlApiPlaytestingBatchAssignment,
  type ControlApiPlaytestingRunRequest,
  PLAYTESTS_MAX_ASSIGNMENT_MANIFEST_BYTES,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS
} from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";
import {
  fetchPlaytestingActiveRuns,
  startPlaytestingRun
} from "../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ASSIGNMENTS = PLAYTESTS_MAX_BATCH_ASSIGNMENTS;
const MAX_ASSIGNMENTS_JSON_BYTES = PLAYTESTS_MAX_ASSIGNMENT_MANIFEST_BYTES;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const ALLOWED_FIELDS = new Set(["workspaceId", "assignments"]);

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

/**
 * Workspace-scoped live batch reads for the active-runs view. This is a read
 * of the same typed run owner that starts and cancels runs; the Console never
 * derives batch state from anywhere else.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim() ?? "";
  if (
    [...request.nextUrl.searchParams.keys()].some(
      (key) => key !== "workspaceId"
    ) ||
    !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "A canonical workspaceId is required to read active runs."
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
  const result = await fetchPlaytestingActiveRuns(workspaceId, config);
  if (result.kind !== "ok") {
    return sendError(
      result.kind === "http-error" || result.kind === "unauthorized"
        ? result.status
        : result.kind === "unreachable"
          ? 503
          : 502,
      controlApiFailureCode(result),
      result.message
    );
  }
  return NextResponse.json(
    { kind: "ok", data: result.data },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    hasControlCharacters(value)
  ) {
    return null;
  }
  return value;
}

function parseAssignment(
  value: unknown
): ControlApiPlaytestingBatchAssignment | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const scenario = boundedText(record.scenario, 256);
  const policy = boundedText(record.policy, 256);
  const seed = boundedText(record.seed, 256);
  if (scenario === null || policy === null || seed === null) return null;
  const goal: string | null =
    record.goal === undefined ? null : boundedText(record.goal, 1000);
  if (record.goal !== undefined && goal === null) return null;
  const maxSteps = record.maxSteps;
  if (
    maxSteps !== undefined &&
    (!Number.isSafeInteger(maxSteps) ||
      (maxSteps as number) < 1 ||
      (maxSteps as number) > 100_000)
  ) {
    return null;
  }
  return {
    scenario,
    policy,
    seed,
    ...(goal === null ? {} : { goal }),
    ...(maxSteps === undefined ? {} : { maxSteps: maxSteps as number })
  };
}

function parseAssignments(
  raw: string
): ControlApiPlaytestingBatchAssignment[] | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_ASSIGNMENTS_JSON_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_ASSIGNMENTS
  ) {
    return null;
  }
  const assignments: ControlApiPlaytestingBatchAssignment[] = [];
  for (const entry of parsed) {
    const assignment = parseAssignment(entry);
    if (assignment === null) return null;
    assignments.push(assignment);
  }
  return assignments;
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
      "Batch requests must come from the Console's same origin."
    );
  }
  const form = await readStrictUrlEncodedFormBody(request, MAX_BODY_BYTES);
  if (!form || [...form.keys()].some((key) => !ALLOWED_FIELDS.has(key))) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "The typed playtest batch form is invalid."
    );
  }
  const workspaceValues = form.getAll("workspaceId");
  const assignmentValues = form.getAll("assignments");
  const workspaceId = workspaceValues[0]?.trim() ?? "";
  const assignments =
    workspaceValues.length === 1 && assignmentValues.length === 1
      ? parseAssignments(assignmentValues[0]!)
      : null;
  if (!assignments || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "A canonical workspaceId and 1-" +
        String(MAX_ASSIGNMENTS) +
        " typed assignments are required."
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
    assignments
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
