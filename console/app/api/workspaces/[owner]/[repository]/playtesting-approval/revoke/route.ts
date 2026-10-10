/**
 * Server-only Console workspace playtesting-approval revocation route.
 *
 * Receives the bounded form submission from a workspace's Revoke form,
 * validates its same-origin browser context, and forwards a typed POST to
 * Runtime's `/control/workspaces/:id/playtesting-approval/revoke` route using
 * the server-side Control API credential. Unlike approval, revocation is not
 * blocked by a disabled workspace -- an operator must be able to retire a
 * risky approval whether or not the workspace is currently enabled -- so this
 * route forwards the request and lets Runtime decide.
 *
 * The approval id and expected revision ride as hidden fields set from the
 * approval the operator was looking at when they submitted, so a revocation
 * aimed at an approval that has since changed comes back a conflict rather
 * than silently retiring a different one.
 *
 * Only POST is exported. In-place Console submissions receive a bounded JSON
 * result and, on revision conflict, the latest server-read approval state.
 * Native no-JavaScript form submissions use a redirect fallback; the Console
 * never claims a mutation succeeded before receiving the Runtime response.
 */

import type { ControlApiWorkspacePlaytestApprovalResponse } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  isWorkspaceId,
  isWorkspacesReturnPath,
  WORKSPACES_PATH
} from "../../../../../../../src/features/workspaces/paths.ts";
import {
  type ControlRefusalReason,
  withControlFailure,
  withControlRefusal
} from "../../../../../../../src/lib/control-failure.ts";
import {
  fetchWorkspacePlaytestApproval,
  postWorkspacePlaytestRevocation,
  readControlApiConfig
} from "../../../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../../src/lib/server/form-mutation.ts";
import { workspacePlaytestingRefusalFor } from "../../../../../../../src/lib/server/workspace-playtesting-refusal.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FORM_BODY_BYTES = 4096;
const REVISION_PATTERN = /^[1-9]\d*$/u;
const MAX_REASON_LENGTH = 1024;

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

function acceptsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.includes("application/json") === true;
}

function sendMutationJson(
  body: unknown,
  status = 200
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function responseStatus(
  result: Exclude<
    Awaited<ReturnType<typeof postWorkspacePlaytestRevocation>>,
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
    params: Promise<{ owner: string; repository: string }>;
  }
): Promise<NextResponse> {
  const failed = (
    returnTo: string = WORKSPACES_PATH,
    refusal: ControlRefusalReason = "request_invalid",
    status = 400
  ): NextResponse =>
    acceptsJson(request)
      ? sendMutationJson({ kind: "refused", refusal }, status)
      : redirectTo(withControlFailure(returnTo));
  if (!isSameOriginMutation(request))
    return failed(WORKSPACES_PATH, "forbidden", 403);

  const { owner, repository } = await context.params;
  const id = `${owner}/${repository}`;
  if (!isWorkspaceId(id)) return failed();

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();

  const returnTo = form.get("returnTo");
  if (!isWorkspacesReturnPath(returnTo)) return failed();
  if (form.get("workspaceId") !== id) return failed(returnTo);

  const expectedRevisionRaw = form.get("expectedRevision");
  if (
    expectedRevisionRaw === null ||
    !REVISION_PATTERN.test(expectedRevisionRaw)
  ) {
    return failed(returnTo);
  }
  const expectedRevision = Number(expectedRevisionRaw);

  const approvalId = form.get("approvalId")?.trim() ?? "";
  if (approvalId === "" || approvalId.length > 256) return failed(returnTo);

  const reason = form.get("reason")?.trim() ?? "";
  if (reason === "" || reason.length > MAX_REASON_LENGTH)
    return failed(returnTo);

  const config = readControlApiConfig();
  if (!config) return failed(returnTo, "unavailable", 503);

  const result = await postWorkspacePlaytestRevocation(
    id,
    { expectedRevision, approvalId, reason },
    config
  );
  if (result.kind !== "ok") {
    const refusal = workspacePlaytestingRefusalFor(result);
    if (!acceptsJson(request)) {
      return redirectTo(withControlRefusal(returnTo, refusal));
    }
    let currentApproval:
      ControlApiWorkspacePlaytestApprovalResponse | undefined;
    if (refusal === "conflicted" || refusal === "forbidden") {
      const current = await fetchWorkspacePlaytestApproval(id, config);
      if (current.kind === "ok") currentApproval = current.data;
    }
    return sendMutationJson(
      {
        kind: "refused",
        refusal,
        ...(currentApproval === undefined ? {} : { currentApproval })
      },
      responseStatus(result)
    );
  }
  return acceptsJson(request)
    ? sendMutationJson({ kind: "ok", data: result.data })
    : redirectTo(returnTo);
}
