/**
 * Same-origin boundary for writing the canonical permission policy.
 *
 * The route receives the operator's edit, validates its same-origin browser
 * context, and forwards a typed PATCH to Runtime using the server-side Control
 * API credential. The browser never receives that credential and never
 * bypasses Runtime: the canonical policy is written by the Runtime, which
 * compares the revision the edit was decided on and refuses a write the
 * canonical source has moved past.
 *
 * The route answers with a redirect rather than with a body. That is the
 * Console's own mutation boundary: the navigation owner reads the redirect,
 * moves the page to the destination, and the page renders the outcome from the
 * query. A route that answered with a body instead would leave the page
 * holding the state it had before the write, which is how a feature ends up
 * showing two truths about the same policy.
 *
 * Only POST is exported. A refused write answers with the Runtime's reason --
 * a conflict, a refused update or an unconfirmed result are different facts,
 * and the operator is told which one happened.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import { type PermissionPolicySaveOutcome } from "../../../src/features/permissions/configuration.ts";
import {
  isPermissionsReturnPath,
  PERMISSIONS_PATH
} from "../../../src/features/permissions/paths.ts";
import { editorBaseRevision } from "../../../src/lib/server/canonical-source.ts";
import {
  patchPermissions,
  readControlApiConfig
} from "../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../src/lib/server/form-mutation.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FORM_BODY_BYTES = 16_384;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const APPROVAL_POLICIES = new Set(["never", "always", "on-demand"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "unrestricted"]);

/**
 * The redirect back to the surface the write came from.
 *
 * The destination is a bounded Permissions path and not one the browser chose,
 * so a write can never redirect off this Console.
 */
function redirectToPermissions(
  returnTo: string,
  outcome?: PermissionPolicySaveOutcome,
  basedOn?: string
): NextResponse {
  const query = new URLSearchParams();
  if (outcome) query.set("save", outcome);
  if (basedOn) query.set("based", basedOn);
  const suffix = query.toString();
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: `${returnTo}${suffix.length > 0 ? `?${suffix}` : ""}`
    }
  });
}

/**
 * The outcome a refusal is reported as.
 *
 * A conflict and a refused update are different facts: the first says the
 * canonical policy moved under the write, the second says the write could not
 * be expressed. They get different outcomes, and the reason is the Runtime's.
 */
function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchPermissions>>
): PermissionPolicySaveOutcome {
  if (result.kind !== "http-error") return "failed";
  switch (result.code) {
    case "autodev_control_permission_policy_revision_conflict": {
      return "conflict";
    }
    case "autodev_control_permission_policy_invalid_update":
    case "autodev_control_api_invalid_body": {
      return "validation";
    }
    case "autodev_control_permission_policy_apply_failed": {
      // The canonical policy was written; the composed configuration could not
      // be refreshed from it. That is not the same as a write that did not
      // land, and the page says so.
      return "apply-failed";
    }
    default: {
      return "failed";
    }
  }
}

/**
 * The policy settings the form carries.
 *
 * The form carries the whole policy, because the control that made it shows
 * the whole policy. The Runtime writes only the settings that differ, so a
 * setting the operator did not touch keeps the file's own bytes.
 */
interface PolicyUpdate {
  readonly approvalPolicy?: "never" | "always" | "on-demand";
  readonly sandboxMode?: "read-only" | "workspace-write" | "unrestricted";
  readonly approvalsReviewer?: string;
  readonly networkAccess?: boolean;
  readonly webSearch?: boolean;
}

/**
 * One setting, as the form carries it.
 *
 * Absent is not the same as invalid: a form that does not carry the setting
 * leaves it alone, and a form that carries it wrongly is refused. The three
 * states are three answers, so they are three cases.
 */
type SettingRead<T> =
  | { readonly present: false }
  | { readonly present: true; readonly ok: true; readonly value: T }
  | { readonly present: true; readonly ok: false };

const ABSENT: SettingRead<never> = { present: false };
const INVALID: SettingRead<never> = { present: true, ok: false };

/**
 * The approval policy the form carries.
 */
function readApprovalPolicy(value: string | null): SettingRead<string> {
  if (value === null) return ABSENT;
  if (!APPROVAL_POLICIES.has(value)) return INVALID;
  return { present: true, ok: true, value };
}

/**
 * The sandbox mode the form carries.
 */
function readSandboxMode(value: string | null): SettingRead<string> {
  if (value === null) return ABSENT;
  if (!SANDBOX_MODES.has(value)) return INVALID;
  return { present: true, ok: true, value };
}

/**
 * The reviewer the form carries.
 */
function readApprovalsReviewer(value: string | null): SettingRead<string> {
  if (value === null) return ABSENT;
  const reviewer = value.trim();
  if (reviewer.length === 0) return INVALID;
  return { present: true, ok: true, value: reviewer };
}

/**
 * The boolean the form carries.
 */
function readBoolean(value: string | null): SettingRead<boolean> {
  if (value === null) return ABSENT;
  if (value === "true") return { present: true, ok: true, value: true };
  if (value === "false") return { present: true, ok: true, value: false };
  return INVALID;
}

/**
 * The policy the form carries.
 *
 * Null when the form carries nothing to write, or when it carries a setting
 * outside the vocabulary the policy has.
 */
function policyUpdateFromForm(form: URLSearchParams): PolicyUpdate | null {
  const update: {
    approvalPolicy?: "never" | "always" | "on-demand";
    sandboxMode?: "read-only" | "workspace-write" | "unrestricted";
    approvalsReviewer?: string;
    networkAccess?: boolean;
    webSearch?: boolean;
  } = {};
  let fields = 0;

  const approvalPolicy = readApprovalPolicy(form.get("approvalPolicy"));
  if (approvalPolicy.present) {
    if (!approvalPolicy.ok) return null;
    update.approvalPolicy = approvalPolicy.value as
      "never" | "always" | "on-demand";
    fields += 1;
  }
  const sandboxMode = readSandboxMode(form.get("sandboxMode"));
  if (sandboxMode.present) {
    if (!sandboxMode.ok) return null;
    update.sandboxMode = sandboxMode.value as
      "read-only" | "workspace-write" | "unrestricted";
    fields += 1;
  }
  const approvalsReviewer = readApprovalsReviewer(
    form.get("approvalsReviewer")
  );
  if (approvalsReviewer.present) {
    if (!approvalsReviewer.ok) return null;
    update.approvalsReviewer = approvalsReviewer.value;
    fields += 1;
  }
  const networkAccess = readBoolean(form.get("networkAccess"));
  if (networkAccess.present) {
    if (!networkAccess.ok) return null;
    update.networkAccess = networkAccess.value;
    fields += 1;
  }
  const webSearch = readBoolean(form.get("webSearch"));
  if (webSearch.present) {
    if (!webSearch.ok) return null;
    update.webSearch = webSearch.value;
    fields += 1;
  }
  if (fields === 0) return null;
  return update;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginMutation(request)) {
    return redirectToPermissions(PERMISSIONS_PATH, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form || form.getAll("expectedRevision").length !== 1) {
    return redirectToPermissions(PERMISSIONS_PATH, "failed");
  }

  // Where the write answers to. The control carries it and the route checks it
  // against the Permissions path, so the destination is the surface the
  // operator wrote from and nothing else.
  const requestedReturnTo = form.get("returnTo");
  const returnTo = isPermissionsReturnPath(requestedReturnTo)
    ? requestedReturnTo
    : PERMISSIONS_PATH;

  const expectedRevision = form.get("expectedRevision");
  if (expectedRevision === null || !REVISION_PATTERN.test(expectedRevision)) {
    return redirectToPermissions(returnTo, "failed");
  }

  const update = policyUpdateFromForm(form);
  // A form that carries a setting outside the vocabulary is refused, and so is
  // a form that carries no setting at all: there is nothing to write.
  if (update === null) {
    return redirectToPermissions(returnTo, "validation");
  }

  const config = readControlApiConfig();
  if (!config) {
    return redirectToPermissions(returnTo, "failed");
  }

  const result = await patchPermissions(
    { expectedRevision, ...update },
    config
  );
  if (result.kind === "ok") {
    return redirectToPermissions(returnTo);
  }
  const outcome = saveOutcomeForFailure(result);
  return redirectToPermissions(
    returnTo,
    outcome,
    editorBaseRevision(outcome, expectedRevision)
  );
}
