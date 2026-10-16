/** Server-only revocation route for a Workspaces-owned visual target. */
import type { ControlApiWorkspaceVisualPlaytestTargetsResponse } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  isWorkspaceId,
  isWorkspacesReturnPath,
  WORKSPACES_PATH
} from "../../../../../../../../src/features/workspaces/paths.ts";
import {
  type ControlRefusalReason,
  withControlFailure,
  withControlRefusal
} from "../../../../../../../../src/lib/control-failure.ts";
import {
  fetchWorkspaceVisualPlaytestTargets,
  postWorkspaceVisualPlaytestTargetRevocation,
  readControlApiConfig
} from "../../../../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../../../src/lib/server/form-mutation.ts";
import { workspacePlaytestingRefusalFor } from "../../../../../../../../src/lib/server/workspace-playtesting-refusal.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4096;
const REVISION_PATTERN = /^[1-9]\d*$/u;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function acceptsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("application/json") === true;
}

function jsonResult(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function responseStatus(
  result: Exclude<
    Awaited<ReturnType<typeof postWorkspaceVisualPlaytestTargetRevocation>>,
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
      readonly targetId: string;
    }>;
  }
): Promise<NextResponse> {
  const failed = (
    returnTo = WORKSPACES_PATH,
    refusal: ControlRefusalReason = "request_invalid",
    status = 400
  ): NextResponse =>
    acceptsJson(request)
      ? jsonResult({ kind: "refused", refusal }, status)
      : new NextResponse(null, {
          status: 303,
          headers: { location: withControlFailure(returnTo) }
        });
  if (!isSameOriginMutation(request)) {
    return failed(WORKSPACES_PATH, "forbidden", 403);
  }
  const { owner, repository, targetId } = await context.params;
  const workspaceId = `${owner}/${repository}`;
  if (!isWorkspaceId(workspaceId) || !TARGET_ID_PATTERN.test(targetId)) {
    return failed();
  }
  const form = await readStrictUrlEncodedFormBody(request, MAX_BODY_BYTES);
  if (
    !form ||
    [...form.keys()].some(
      (key) =>
        ![
          "returnTo",
          "workspaceId",
          "expectedRevision",
          "approvalId",
          "reason"
        ].includes(key)
    ) ||
    [...new Set(form.keys())].some((key) => form.getAll(key).length !== 1)
  ) {
    return failed();
  }
  const returnTo = form.get("returnTo");
  if (
    !isWorkspacesReturnPath(returnTo) ||
    form.get("workspaceId") !== workspaceId
  ) {
    return failed();
  }
  const revisionRaw = form.get("expectedRevision");
  const approvalId = form.get("approvalId")?.trim() ?? "";
  const reason = form.get("reason")?.trim() ?? "";
  if (
    revisionRaw === null ||
    !REVISION_PATTERN.test(revisionRaw) ||
    approvalId.length === 0 ||
    approvalId.length > 128 ||
    reason.length === 0 ||
    reason.length > 1024
  ) {
    return failed(returnTo);
  }
  const config = readControlApiConfig();
  if (!config) return failed(returnTo, "unavailable", 503);
  const result = await postWorkspaceVisualPlaytestTargetRevocation(
    workspaceId,
    targetId,
    {
      expectedRevision: Number(revisionRaw),
      approvalId,
      reason
    },
    config
  );
  if (result.kind === "ok") {
    return acceptsJson(request)
      ? jsonResult({ kind: "ok", data: result.data })
      : new NextResponse(null, {
          status: 303,
          headers: { location: returnTo }
        });
  }
  const refusal = workspacePlaytestingRefusalFor(result);
  if (!acceptsJson(request)) {
    return new NextResponse(null, {
      status: 303,
      headers: { location: withControlRefusal(returnTo, refusal) }
    });
  }
  let currentTargets:
    ControlApiWorkspaceVisualPlaytestTargetsResponse | undefined;
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
