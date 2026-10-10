/** Server-only, same-origin cancellation request for an active Playtesting run. */
import { type NextRequest, NextResponse } from "next/server.js";

import {
  controlApiFailureCode,
  readControlApiConfig
} from "../../../../../../src/lib/server/control-api.ts";
import { cancelPlaytestingRun } from "../../../../../playtesting/playtesting-server.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../src/lib/server/form-mutation.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

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
    Awaited<ReturnType<typeof cancelPlaytestingRun>>,
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
  context: { readonly params: Promise<{ readonly batchId: string }> }
): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return sendError(
      403,
      "autodev_console_playtesting_origin_refused",
      "Cancellation requests must come from the Console's same origin."
    );
  }
  const { batchId } = await context.params;
  const form = await readStrictUrlEncodedFormBody(request, MAX_BODY_BYTES);
  if (
    !BATCH_ID_PATTERN.test(batchId) ||
    !form ||
    [...form.keys()].some((key) => key !== "workspaceId") ||
    form.getAll("workspaceId").length !== 1
  ) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_cancel_request",
      "A valid batchId and single workspaceId are required."
    );
  }
  const workspaceId = form.get("workspaceId")!.trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return sendError(
      400,
      "autodev_console_playtesting_invalid_cancel_request",
      "A canonical workspaceId is required."
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
  const result = await cancelPlaytestingRun(workspaceId, batchId, config);
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
