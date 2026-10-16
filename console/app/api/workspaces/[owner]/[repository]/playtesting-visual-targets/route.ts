/** Server-only mutation route for Workspaces' separate visual target approval. */
import {
  assertWorkspaceVisualPlaytestLimits,
  WORKSPACE_VISUAL_PLAYTEST_ENTRY_REQUIREMENTS,
  WORKSPACE_VISUAL_PLAYTEST_INPUTS,
  WORKSPACE_VISUAL_PLAYTEST_TIMING_CLASSES,
  type WorkspaceVisualPlaytestLimits
} from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  isWorkspaceId,
  isWorkspacesReturnPath,
  WORKSPACES_PATH
} from "../../../../../../src/features/workspaces/paths.ts";
import {
  type ControlRefusalReason,
  withControlFailure,
  withControlRefusal
} from "../../../../../../src/lib/control-failure.ts";
import {
  fetchWorkspaceVisualPlaytestTargets,
  postWorkspaceVisualPlaytestTarget,
  readControlApiConfig
} from "../../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../src/lib/server/form-mutation.ts";
import { workspacePlaytestingRefusalFor } from "../../../../../../src/lib/server/workspace-playtesting-refusal.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 12_000;
const REVISION_PATTERN = /^[1-9]\d*$/u;
const INTEGER_PATTERN = /^\d+$/u;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FORM_KEYS = new Set([
  "returnTo",
  "workspaceId",
  "expectedRevision",
  "targetId",
  "name",
  "entryUrl",
  "additionalOrigins",
  "inputCapabilities",
  "controlTimingClass",
  "entryRequirements",
  "episodeCount",
  "maxStepsPerEpisode",
  "wallTimeMs",
  "smartRequestsPerEpisode",
  "smartTokensPerEpisode",
  "screenshotCountPerEpisode",
  "artifactBytesPerEpisode"
]);

interface TargetSubmission {
  readonly expectedRevision: number | null;
  readonly targetId: string;
  readonly name: string;
  readonly entryUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly inputCapabilities: readonly string[];
  readonly controlTimingClass: string;
  readonly entryRequirements: string;
  readonly limits: WorkspaceVisualPlaytestLimits;
}

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

function acceptsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("application/json") === true;
}

function jsonResult(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function failure(
  request: NextRequest,
  returnTo: string,
  refusal: ControlRefusalReason,
  status: number
): NextResponse {
  return acceptsJson(request)
    ? jsonResult({ kind: "refused", refusal }, status)
    : redirectTo(withControlRefusal(returnTo, refusal));
}

function parseExpectedRevision(
  value: string | null
): number | null | undefined {
  if (value === null || value === "") return null;
  return REVISION_PATTERN.test(value) ? Number(value) : undefined;
}

function boundedList(
  value: string | null | readonly string[],
  maximum: number
): readonly string[] | null {
  let source: readonly string[];
  if (typeof value === "string") source = value.split(",");
  else if (value === null) source = [];
  else source = value;
  const items = source
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length <= maximum && new Set(items).size === items.length
    ? items
    : null;
}

function boundedInteger(value: string | null): number | null {
  if (value === null || !INTEGER_PATTERN.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseLimits(
  form: URLSearchParams
): WorkspaceVisualPlaytestLimits | null {
  const limits: Record<string, number> = {};
  for (const name of [
    "episodeCount",
    "maxStepsPerEpisode",
    "wallTimeMs",
    "smartRequestsPerEpisode",
    "smartTokensPerEpisode",
    "screenshotCountPerEpisode",
    "artifactBytesPerEpisode"
  ] as const) {
    const value = boundedInteger(form.get(name));
    if (value === null) return null;
    limits[name] = value;
  }
  try {
    assertWorkspaceVisualPlaytestLimits(limits);
    return limits;
  } catch {
    return null;
  }
}

function parseSubmission(
  form: URLSearchParams,
  workspaceId: string
): TargetSubmission | null {
  if (
    [...form.keys()].some((key) => !FORM_KEYS.has(key)) ||
    [...new Set(form.keys())].some(
      (key) => key !== "inputCapabilities" && form.getAll(key).length !== 1
    )
  ) {
    return null;
  }
  if (form.get("workspaceId") !== workspaceId) return null;
  const expectedRevision = parseExpectedRevision(form.get("expectedRevision"));
  const targetId = form.get("targetId")?.trim() ?? "";
  const name = form.get("name")?.trim() ?? "";
  const entryUrl = form.get("entryUrl")?.trim() ?? "";
  const additionalOrigins = boundedList(form.get("additionalOrigins"), 15);
  const inputCapabilities = boundedList(form.getAll("inputCapabilities"), 3);
  const controlTimingClass = form.get("controlTimingClass") ?? "";
  const entryRequirements = form.get("entryRequirements") ?? "";
  const limits = parseLimits(form);
  if (
    expectedRevision === undefined ||
    !TARGET_ID_PATTERN.test(targetId) ||
    name.length === 0 ||
    name.length > 160 ||
    entryUrl.length === 0 ||
    entryUrl.length > 2048 ||
    additionalOrigins === null ||
    inputCapabilities === null ||
    inputCapabilities.length === 0 ||
    !inputCapabilities.every((value) =>
      (WORKSPACE_VISUAL_PLAYTEST_INPUTS as readonly string[]).includes(value)
    ) ||
    !(WORKSPACE_VISUAL_PLAYTEST_TIMING_CLASSES as readonly string[]).includes(
      controlTimingClass
    ) ||
    !(
      WORKSPACE_VISUAL_PLAYTEST_ENTRY_REQUIREMENTS as readonly string[]
    ).includes(entryRequirements) ||
    limits === null
  ) {
    return null;
  }
  let entryOrigin: string;
  try {
    entryOrigin = new URL(entryUrl).origin;
  } catch {
    return null;
  }
  const allowedOrigins = [...new Set([entryOrigin, ...additionalOrigins])];
  return {
    expectedRevision,
    targetId,
    name,
    entryUrl,
    allowedOrigins,
    inputCapabilities,
    controlTimingClass,
    entryRequirements,
    limits
  };
}

function responseStatus(
  result: Exclude<
    Awaited<ReturnType<typeof postWorkspaceVisualPlaytestTarget>>,
    { readonly kind: "ok" }
  >
): number {
  if (result.kind === "http-error" || result.kind === "unauthorized") {
    return result.status;
  }
  return result.kind === "unreachable" ? 503 : 502;
}

export async function POST(
  request: NextRequest,
  context: {
    readonly params: Promise<{
      readonly owner: string;
      readonly repository: string;
    }>;
  }
): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return failure(request, WORKSPACES_PATH, "forbidden", 403);
  }
  const { owner, repository } = await context.params;
  const workspaceId = `${owner}/${repository}`;
  if (!isWorkspaceId(workspaceId)) {
    return failure(request, WORKSPACES_PATH, "request_invalid", 400);
  }
  const form = await readStrictUrlEncodedFormBody(request, MAX_BODY_BYTES);
  if (!form) return failure(request, WORKSPACES_PATH, "request_invalid", 400);
  const returnTo = form.get("returnTo");
  if (!isWorkspacesReturnPath(returnTo)) {
    return failure(request, WORKSPACES_PATH, "request_invalid", 400);
  }
  const submission = parseSubmission(form, workspaceId);
  if (!submission) return failure(request, returnTo, "request_invalid", 400);
  const config = readControlApiConfig();
  if (!config) return failure(request, returnTo, "unavailable", 503);
  const result = await postWorkspaceVisualPlaytestTarget(
    workspaceId,
    submission,
    config
  );
  if (result.kind === "ok") {
    return acceptsJson(request)
      ? jsonResult({ kind: "ok", data: result.data })
      : redirectTo(returnTo);
  }
  const refusal = workspacePlaytestingRefusalFor(result);
  if (!acceptsJson(request)) {
    return redirectTo(withControlFailure(returnTo));
  }
  let currentTargets;
  if (refusal === "conflicted" || refusal === "forbidden") {
    const current = await fetchWorkspaceVisualPlaytestTargets(
      workspaceId,
      config
    );
    if (current.kind === "ok") currentTargets = current.data;
  }
  return jsonResult(
    {
      kind: "refused",
      refusal,
      ...(currentTargets === undefined ? {} : { currentTargets })
    },
    responseStatus(result)
  );
}
