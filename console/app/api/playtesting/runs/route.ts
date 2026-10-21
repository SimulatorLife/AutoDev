/** Server-only, typed Playtesting batch request; Runtime owns approval and execution. */
import {
  assertWorkspaceVisualPlaytestLimits,
  isPlaytestVisualPolicyId,
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestVisualPolicyId,
  type WorkspaceVisualPlaytestLimits,
  type PlaytestLaunchAssignment,
  type PlaytestLaunchRequest,
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
const MAX_LAUNCH_JSON_BYTES = PLAYTESTS_MAX_ASSIGNMENT_MANIFEST_BYTES;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CAPABILITY_REVISION_PATTERN = /^[a-f\d]{64}$/u;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ALLOWED_VISUAL_RECORD_KEYS = new Set([
  "schema",
  "mode",
  "workspaceId",
  "requestId",
  "capabilityRevision",
  "targetId",
  "policyId",
  "areasOfFocus",
  "limits"
]);
function parseVisualLimits(
  limits: unknown
): WorkspaceVisualPlaytestLimits | null {
  try {
    assertWorkspaceVisualPlaytestLimits(limits);
    return limits;
  } catch {
    return null;
  }
}

function parseVisualLaunchRequest(
  record: Record<string, unknown>
): PlaytestLaunchRequest | null {
  if (
    Object.keys(record).length !== 9 ||
    Object.keys(record).some((key) => !ALLOWED_VISUAL_RECORD_KEYS.has(key)) ||
    typeof record.targetId !== "string" ||
    !TARGET_ID_PATTERN.test(record.targetId) ||
    !isPlaytestVisualPolicyId(record.policyId)
  ) {
    return null;
  }
  if (
    record.areasOfFocus !== null &&
    (typeof record.areasOfFocus !== "string" ||
      record.areasOfFocus.length > 2000 ||
      hasControlCharacters(record.areasOfFocus))
  ) {
    return null;
  }
  const limits = parseVisualLimits(record.limits);
  if (limits === null) return null;
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "autonomous-visual",
    workspaceId: record.workspaceId as string,
    requestId: record.requestId as string,
    capabilityRevision: record.capabilityRevision as string,
    targetId: record.targetId,
    policyId: record.policyId as PlaytestVisualPolicyId,
    areasOfFocus: record.areasOfFocus,
    limits
  };
}
const ALLOWED_FIELDS = new Set(["launchRequest"]);

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
  const workspaceId =
    request.nextUrl.searchParams.get("workspaceId")?.trim() ?? "";
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

function parseAssignment(value: unknown): PlaytestLaunchAssignment | null {
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

function parseAssignments(value: unknown): PlaytestLaunchAssignment[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ASSIGNMENTS
  ) {
    return null;
  }
  const assignments: PlaytestLaunchAssignment[] = [];
  for (const entry of value) {
    const assignment = parseAssignment(entry);
    if (assignment === null) return null;
    assignments.push(assignment);
  }
  return assignments;
}

/**
 * Bound and shape-check the versioned launch request. Runtime's
 * PlaytestRunControl owner remains the authoritative validator for every
 * mode, approval, budget and capability; the Console never substitutes a
 * different mode when Runtime refuses one.
 */
function parseLaunchRequest(raw: string): PlaytestLaunchRequest | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_LAUNCH_JSON_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schema !== PLAYTEST_LAUNCH_REQUEST_SCHEMA ||
    typeof record.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(record.workspaceId) ||
    typeof record.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(record.requestId) ||
    typeof record.capabilityRevision !== "string" ||
    !CAPABILITY_REVISION_PATTERN.test(record.capabilityRevision)
  ) {
    return null;
  }
  if (record.mode === "autonomous-visual") {
    return parseVisualLaunchRequest(record);
  }
  if (record.mode === "scripted-regression") {
    return record as unknown as PlaytestLaunchRequest;
  }
  if (record.mode !== "adapter-accelerated") {
    return null;
  }
  const operation = record.operation;
  if (
    typeof operation !== "object" ||
    operation === null ||
    Array.isArray(operation) ||
    (operation as Record<string, unknown>).kind !== "batch" ||
    Object.keys(operation).some(
      (key) => key !== "kind" && key !== "assignments"
    ) ||
    Object.keys(record).some(
      (key) =>
        ![
          "schema",
          "mode",
          "workspaceId",
          "requestId",
          "capabilityRevision",
          "operation"
        ].includes(key)
    )
  ) {
    return null;
  }
  const assignments = parseAssignments(
    (operation as Record<string, unknown>).assignments
  );
  if (assignments === null) return null;
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated",
    workspaceId: record.workspaceId,
    requestId: record.requestId,
    capabilityRevision: record.capabilityRevision,
    operation: { kind: "batch", assignments }
  };
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
  const launchValues = form.getAll("launchRequest");
  const launchRequest =
    launchValues.length === 1 ? parseLaunchRequest(launchValues[0]!) : null;
  if (!launchRequest) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "A versioned PlaytestLaunchRequest with a canonical workspaceId and 1-" +
        String(MAX_ASSIGNMENTS) +
        " typed adapter assignments is required."
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
  const result = await startPlaytestingRun(launchRequest, config);
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
