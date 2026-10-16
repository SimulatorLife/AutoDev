/** Same-origin, server-bound view of the Data-owned Playtesting schema readiness. */
import { type NextRequest, NextResponse } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import { isSameOriginMutation } from "../../../../src/lib/server/form-mutation.ts";
import { fetchPlaytestingReadiness } from "../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const ALLOWED_QUERY_KEYS = new Set(["workspaceId"]);

function errorResponse(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json(
    { kind: "error", code, message },
    { status, headers: { "cache-control": "no-store" } }
  );
}

async function handle(
  request: NextRequest,
  retry: boolean
): Promise<NextResponse> {
  const workspaceId =
    request.nextUrl.searchParams.get("workspaceId")?.trim() ?? "";
  if (
    [...request.nextUrl.searchParams.keys()].some(
      (key) => !ALLOWED_QUERY_KEYS.has(key)
    ) ||
    !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    return errorResponse(
      400,
      "autodev_console_playtesting_invalid_request",
      "A canonical workspaceId is required to check Playtesting readiness."
    );
  }
  const config = readControlApiConfig();
  if (!config) {
    return errorResponse(
      503,
      "autodev_console_control_api_unavailable",
      "The server-side Control API credential is not configured."
    );
  }
  const result = await fetchPlaytestingReadiness(workspaceId, config, {
    retry
  });
  if (result.kind !== "ok") {
    return errorResponse(
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

export function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request, false);
}

export function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return Promise.resolve(
      errorResponse(
        403,
        "autodev_console_cross_origin_mutation",
        "Retrying Playtesting initialization requires a same-origin request."
      )
    );
  }
  return handle(request, true);
}
