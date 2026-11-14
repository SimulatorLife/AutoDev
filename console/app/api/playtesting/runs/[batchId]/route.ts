/** Server-only status read for a Runtime-owned Playtesting run. */
import { type NextRequest, NextResponse } from "next/server.js";

import { jsonErrorResponse } from "../../../../../src/lib/server/api-response.ts";
import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../../src/lib/server/control-api.ts";
import { fetchPlaytestingRunStatus } from "../../../../playtesting/playtesting-server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function failureStatus(
  result: Exclude<
    Awaited<ReturnType<typeof fetchPlaytestingRunStatus>>,
    { kind: "ok" }
  >
): number {
  if (result.kind === "http-error" || result.kind === "unauthorized") {
    return result.status;
  }
  return result.kind === "unreachable" ? 503 : 502;
}

export async function GET(
  request: NextRequest,
  context: { readonly params: Promise<{ readonly batchId: string }> }
): Promise<NextResponse> {
  const { batchId } = await context.params;
  const params = new URL(request.url).searchParams;
  if (
    !BATCH_ID_PATTERN.test(batchId) ||
    [...params.keys()].some((key) => key !== "workspaceId") ||
    params.getAll("workspaceId").length !== 1
  ) {
    return jsonErrorResponse(
      400,
      "autodev_console_playtesting_invalid_status_query",
      "A valid batchId and single workspaceId are required."
    );
  }
  const workspaceId = params.get("workspaceId")!.trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return jsonErrorResponse(
      400,
      "autodev_console_playtesting_invalid_status_query",
      "A canonical workspaceId is required."
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
  const result = await fetchPlaytestingRunStatus(workspaceId, batchId, config);
  if (result.kind !== "ok") {
    return jsonErrorResponse(
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
