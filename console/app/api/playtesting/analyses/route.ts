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
  listPlaytestingAnalyses,
  requestPlaytestingAnalysis
} from "../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const EPISODE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const ALLOWED_FIELDS = new Set([
  "workspaceId",
  "episodeIds",
  "requireFindings"
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

/**
 * Request analysis over an explicit selection of sessions. Runtime owns
 * eligibility, the critique cap and which sessions produced no packet; this
 * route only authorizes the operator's same-origin request and forwards it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return sendError(
      403,
      "autodev_console_playtesting_same_origin_required",
      "Playtesting analysis requires a same-origin request."
    );
  }
  const form = await readStrictUrlEncodedFormBody(request, MAX_BODY_BYTES);
  if (
    form === null ||
    [...form.keys()].some((key) => !ALLOWED_FIELDS.has(key))
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "The playtesting analysis form is invalid."
    );
  }
  const params = form;
  const workspaceId = params.get("workspaceId")?.trim() ?? "";
  const rawSelection = params.get("episodeIds");
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || rawSelection === null) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "A canonical workspaceId and an explicit session selection are required."
    );
  }
  let episodeIds: readonly string[];
  try {
    const parsed: unknown = JSON.parse(rawSelection);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every(
        (id) => typeof id === "string" && EPISODE_ID_PATTERN.test(id)
      )
    ) {
      return sendError(
        400,
        "autodev_console_playtesting_invalid_request",
        "The session selection is malformed."
      );
    }
    episodeIds = parsed;
  } catch {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "The session selection is malformed."
    );
  }
  // A findings request is a different job from a hypothesis review, so the
  // operator states which one they want. The flag is read strictly: a value
  // that is neither "true" nor "false" is a malformed request, not a
  // request for a hypothesis review.
  const rawRequireFindings = params.get("requireFindings");
  if (
    rawRequireFindings !== null &&
    rawRequireFindings !== "true" &&
    rawRequireFindings !== "false"
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "The findings request flag is malformed."
    );
  }
  const requireFindings = rawRequireFindings === "true";
  const config = readControlApiConfig();
  if (!config) {
    return sendError(
      503,
      "autodev_console_control_api_unavailable",
      "The server-side Control API credential is not configured."
    );
  }
  const result = await requestPlaytestingAnalysis(
    workspaceId,
    episodeIds,
    config,
    { requireFindings }
  );
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
    {
      status: result.data.analysis === null ? 200 : 202,
      headers: { "cache-control": "no-store" }
    }
  );
}

/** Workspace-scoped status for the Runtime-owned analyst task list. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const values = request.nextUrl.searchParams.getAll("workspaceId");
  const workspaceId = values[0]?.trim() ?? "";
  if (
    values.length !== 1 ||
    [...request.nextUrl.searchParams.keys()].some(
      (key) => key !== "workspaceId"
    ) ||
    !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "A canonical workspaceId is required to read analyst review status."
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
  const result = await listPlaytestingAnalyses(workspaceId, config);
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
