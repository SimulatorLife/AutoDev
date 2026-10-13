import { NextResponse, type NextRequest } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";
import { requestPlaytestingAnalysis } from "../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const EPISODE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const ALLOWED_FIELDS = new Set(["workspaceId", "episodeIds"]);

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
  if (form === null || [...form.keys()].some((key) => !ALLOWED_FIELDS.has(key))) {
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
  const config = readControlApiConfig();
  if (!config) {
    return sendError(
      503,
      "autodev_console_control_api_unavailable",
      "The server-side Control API credential is not configured."
    );
  }
  const result = await requestPlaytestingAnalysis(workspaceId, episodeIds, config);
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