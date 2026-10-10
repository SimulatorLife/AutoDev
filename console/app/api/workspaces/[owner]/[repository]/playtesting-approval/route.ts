/**
 * Server-only Console workspace playtesting-approval mutation route.
 *
 * Receives the bounded form submission from a workspace's Approve form,
 * validates its same-origin browser context, and forwards a typed POST to
 * Runtime using the server-side Control API credential. The browser never
 * receives that credential and never bypasses Runtime -- this route only
 * assembles the exact-build approval body the Runtime's
 * `/control/workspaces/:id/playtesting-approval` route reads, it never
 * decides whether the approval is accepted.
 *
 * Every field is required: an exact-build approval with an omitted field is
 * not a narrower grant, it is a malformed one, so a missing or malformed
 * field fails the submission closed rather than sending a partial body the
 * Runtime would reject anyway for a less specific reason.
 *
 * Only POST is exported. In-place Console submissions receive a bounded JSON
 * result and, on revision conflict, the latest server-read approval state.
 * Native no-JavaScript form submissions use a redirect fallback to the owning
 * workspace detail page; neither response claims an unconfirmed mutation.
 */

import type { ControlApiWorkspacePlaytestApprovalResponse } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  parseWorkspacePlaytestLimitValue,
  WORKSPACE_PLAYTEST_LIMIT_FIELDS
} from "../../../../../../src/features/workspaces/limits-fields.ts";
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
  fetchWorkspacePlaytestApproval,
  postWorkspacePlaytestApproval,
  readControlApiConfig
} from "../../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../src/lib/server/form-mutation.ts";
import { workspacePlaytestingRefusalFor } from "../../../../../../src/lib/server/workspace-playtesting-refusal.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FORM_BODY_BYTES = 16_384;
const REVISION_PATTERN = /^[1-9]\d*$/u;
const INTEGER_PATTERN = /^\d+$/u;
const ISSUE_REPORTING_VALUES = new Set(["disabled", "review"]);

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
    Awaited<ReturnType<typeof postWorkspacePlaytestApproval>>,
    { readonly kind: "ok" }
  >
): number {
  if (result.kind === "http-error" || result.kind === "unauthorized") {
    return result.status;
  }
  return result.kind === "unreachable" ? 503 : 502;
}

/** Trimmed, non-empty text, or `null` for a missing/blank field. */
function requiredField(form: URLSearchParams, name: string): string | null {
  const value = form.get(name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A bounded, unique, comma-separated list. Empty after trimming blanks is
 * `null`: an approval naming no scenarios or no command at all is a
 * malformed grant, not an empty one.
 */
function requiredList(
  form: URLSearchParams,
  name: string
): readonly string[] | null {
  const raw = form.get(name);
  if (raw === null) return null;
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0 || items.length > 128) return null;
  return new Set(items).size === items.length ? items : null;
}

/** `null` for the fresh-approval case, the prior revision for a re-approval, or `undefined` when malformed. */
function parseExpectedRevision(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return null;
  return REVISION_PATTERN.test(raw) ? Number(raw) : undefined;
}

interface WorkspaceApprovalSubmission {
  readonly expectedRevision: number | null;
  readonly checkoutRoot: string;
  readonly buildSha: string;
  readonly gameBuild: string;
  readonly playtestConfigHash: string;
  readonly adapterImageDigest: string;
  readonly workingDirectory: string;
  readonly adapterCommand: readonly string[];
  readonly allowedScenarios: readonly string[];
  readonly allowedPolicies: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly retentionDays: number;
  readonly issueReporting: "disabled" | "review";
  readonly humanStudyAllowed: boolean;
}

function parseLimits(
  form: URLSearchParams
): Readonly<Record<string, number>> | null {
  const limits: Record<string, number> = {};
  for (const field of WORKSPACE_PLAYTEST_LIMIT_FIELDS) {
    const value = parseWorkspacePlaytestLimitValue(field, form.get(field.name));
    if (value === null) return null;
    limits[field.name] = value;
  }
  return limits;
}

function parseApprovalSubmission(
  form: URLSearchParams,
  workspaceId: string
): WorkspaceApprovalSubmission | null {
  if (form.get("workspaceId") !== workspaceId) return null;
  const expectedRevision = parseExpectedRevision(form.get("expectedRevision"));
  if (expectedRevision === undefined) return null;

  const checkoutRoot = requiredField(form, "checkoutRoot");
  const buildSha = requiredField(form, "buildSha");
  const gameBuild = requiredField(form, "gameBuild");
  const playtestConfigHash = requiredField(form, "playtestConfigHash");
  const adapterImageDigest = requiredField(form, "adapterImageDigest");
  const workingDirectory = requiredField(form, "workingDirectory");
  const adapterCommand = requiredList(form, "adapterCommand");
  const allowedScenarios = requiredList(form, "allowedScenarios");
  const allowedPolicies = requiredList(form, "allowedPolicies");
  const limits = parseLimits(form);
  const retentionDaysRaw = form.get("retentionDays");
  const retentionDays =
    retentionDaysRaw === null ? Number.NaN : Number(retentionDaysRaw);
  const issueReporting = form.get("issueReporting");
  const humanStudyRaw = form.get("humanStudyAllowed");
  if (
    checkoutRoot === null ||
    buildSha === null ||
    gameBuild === null ||
    playtestConfigHash === null ||
    adapterImageDigest === null ||
    workingDirectory === null ||
    adapterCommand === null ||
    allowedScenarios === null ||
    allowedPolicies === null ||
    limits === null ||
    retentionDaysRaw === null ||
    !INTEGER_PATTERN.test(retentionDaysRaw) ||
    !Number.isSafeInteger(retentionDays) ||
    issueReporting === null ||
    !ISSUE_REPORTING_VALUES.has(issueReporting) ||
    (humanStudyRaw !== "true" && humanStudyRaw !== "false")
  ) {
    return null;
  }
  return {
    expectedRevision,
    checkoutRoot,
    buildSha,
    gameBuild,
    playtestConfigHash,
    adapterImageDigest,
    workingDirectory,
    adapterCommand,
    allowedScenarios,
    allowedPolicies,
    limits,
    retentionDays,
    issueReporting: issueReporting as "disabled" | "review",
    humanStudyAllowed: humanStudyRaw === "true"
  };
}

async function respondToApprovalResult(
  request: NextRequest,
  workspaceId: string,
  returnTo: string,
  config: NonNullable<ReturnType<typeof readControlApiConfig>>,
  result: Awaited<ReturnType<typeof postWorkspacePlaytestApproval>>
): Promise<NextResponse> {
  if (result.kind === "ok") {
    return acceptsJson(request)
      ? sendMutationJson({ kind: "ok", data: result.data })
      : redirectTo(returnTo);
  }
  const refusal = workspacePlaytestingRefusalFor(result);
  if (!acceptsJson(request)) {
    return redirectTo(withControlRefusal(returnTo, refusal));
  }
  let currentApproval: ControlApiWorkspacePlaytestApprovalResponse | undefined;
  if (refusal === "conflicted" || refusal === "forbidden") {
    const current = await fetchWorkspacePlaytestApproval(workspaceId, config);
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
  if (!isSameOriginMutation(request)) {
    return failed(WORKSPACES_PATH, "forbidden", 403);
  }

  const { owner, repository } = await context.params;
  const workspaceId = `${owner}/${repository}`;
  if (!isWorkspaceId(workspaceId)) return failed();
  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();
  const returnTo = form.get("returnTo");
  if (!isWorkspacesReturnPath(returnTo)) return failed();
  const submission = parseApprovalSubmission(form, workspaceId);
  if (submission === null) return failed(returnTo);

  const config = readControlApiConfig();
  if (!config) return failed(returnTo, "unavailable", 503);
  const result = await postWorkspacePlaytestApproval(
    workspaceId,
    submission,
    config
  );
  return respondToApprovalResult(
    request,
    workspaceId,
    returnTo,
    config,
    result
  );
}
