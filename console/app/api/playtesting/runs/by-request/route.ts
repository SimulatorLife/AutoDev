/**
Server-only recovery of a launch whose POST acknowledgement was uncertain.
*/
import type { NextRequest, NextResponse } from "next/server.js";

import {
  controlApiReadResponse,
  jsonErrorResponse
} from "../../../../../src/lib/server/api-response.ts";
import { readControlApiConfig } from "../../../../../src/lib/server/control-api.ts";
import { fetchPlaytestingRunRequest } from "../../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parameters = request.nextUrl.searchParams;
  const workspaceId = parameters.get("workspaceId")?.trim() ?? "";
  const requestId = parameters.get("requestId")?.trim() ?? "";
  if (
    [...parameters.keys()].some(
      (key) => key !== "workspaceId" && key !== "requestId"
    ) ||
    parameters.getAll("workspaceId").length !== 1 ||
    parameters.getAll("requestId").length !== 1 ||
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !REQUEST_ID_PATTERN.test(requestId)
  ) {
    return jsonErrorResponse(
      400,
      "autodev_console_playtesting_invalid_request",
      "A canonical workspaceId and the original requestId are required."
    );
  }
  const config = readControlApiConfig();
  if (!config) {
    return jsonErrorResponse(
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
  return controlApiReadResponse(result);
}
