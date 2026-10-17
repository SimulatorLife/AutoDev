/** Server-only recovery of a launch whose POST acknowledgement was uncertain. */
import { type NextRequest, NextResponse } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../../src/lib/server/control-api.ts";
import { fetchPlaytestingRunRequest } from "../../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId")?.trim() ?? "";
  const requestId = params.get("requestId")?.trim() ?? "";
  if (
    [...params.keys()].some(
      (key) => key !== "workspaceId" && key !== "requestId"
    ) ||
    params.getAll("workspaceId").length !== 1 ||
    params.getAll("requestId").length !== 1 ||
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !REQUEST_ID_PATTERN.test(requestId)
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_request",
      "A canonical workspaceId and the original requestId are required."
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
  const result = await fetchPlaytestingRunRequest(
    workspaceId,
    requestId,
    config
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
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}
