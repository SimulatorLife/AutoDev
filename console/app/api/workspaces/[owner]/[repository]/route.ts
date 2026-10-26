/**
 * Same-origin boundary for writing one workspace's canonical configuration.
 *
 * The route receives the operator's edit, validates its same-origin browser
 * context, and forwards a typed PATCH to Runtime using the server-side Control
 * API credential. The browser never receives that credential and never
 * bypasses Runtime: the canonical catalog is written by the Runtime, which
 * compares the revision the edit was decided on and refuses a write the
 * catalog has moved past.
 *
 * The route answers with a redirect rather than with a body. That is the
 * Console's own mutation boundary: the navigation owner reads the redirect,
 * moves the page to the destination, and the page renders the outcome from the
 * query. A route that answered with a body instead would leave the page
 * holding the state it had before the write, which is how a feature ends up
 * showing two truths about the same catalog.
 *
 * Only POST is exported. A refused write answers with the Runtime's reason --
 * a conflict, a refused update or an unconfirmed result are different facts,
 * and the operator is told which one happened.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import { type WorkspaceConfigurationSaveOutcome } from "../../../../../src/features/workspaces/configuration.ts";
import {
  isWorkspacesReturnPath,
  WORKSPACES_PATH
} from "../../../../../src/features/workspaces/paths.ts";
import { editorBaseRevision } from "../../../../../src/lib/server/canonical-source.ts";
import {
  patchWorkspace,
  readControlApiConfig
} from "../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../src/lib/server/form-mutation.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FORM_BODY_BYTES = 16_384;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const WORKSPACE_OWNER_PATTERN = /^[^/\s]+$/u;
const WORKSPACE_REPOSITORY_PATTERN = /^[^/\s]+$/u;

/**
 * The redirect back to the surface the write came from.
 *
 * The control is on the list and on the workspace's own page, so the write
 * answers to whichever of the two the operator used: a write that answered
 * somewhere else would leave the operator looking at a page that says nothing
 * about the configuration they just changed.
 *
 * The destination is a bounded Workspaces path and not one the browser chose,
 * so a write can never redirect off this Console.
 */
function redirectToWorkspaces(
  returnTo: string,
  workspaceId: string,
  outcome?: WorkspaceConfigurationSaveOutcome,
  basedOn?: string
): NextResponse {
  const query = new URLSearchParams();
  if (outcome) query.set("save", outcome);
  if (basedOn) query.set("based", basedOn);
  // The list names the workspace it is showing the outcome for; the
  // workspace's own page has it in its path, and repeating it in the query
  // would be a second place for the same fact to disagree.
  if (returnTo === WORKSPACES_PATH) query.set("workspace", workspaceId);
  const suffix = query.toString();
  return new NextResponse(null, {
    status: 303,
    headers: { location: `${returnTo}${suffix.length > 0 ? `?${suffix}` : ""}` }
  });
}

/**
 * The outcome a refusal is reported as.
 *
 * A conflict and a refused update are different facts: the first says the
 * catalog moved under the write, the second says the write could not be
 * expressed. They get different outcomes, and the reason is the Runtime's.
 */
function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchWorkspace>>
): WorkspaceConfigurationSaveOutcome {
  if (result.kind !== "http-error") return "failed";
  switch (result.code) {
    case "autodev_control_workspace_revision_conflict": {
      return "conflict";
    }
    case "autodev_control_workspace_invalid_update":
    case "autodev_control_api_invalid_body": {
      return "validation";
    }
    default: {
      return "failed";
    }
  }
}

/**
 * The role scope the form carries.
 *
 * A scope that is not configured and a scope that names no role are different
 * facts, so the form says which one it means and the list is read from the
 * names it carries.
 */
type RoleScope =
  | { readonly ok: true; readonly agentRoles: readonly string[] | null }
  | { readonly ok: false };

function readRoleScope(form: URLSearchParams): RoleScope {
  const mode = form.get("agentRolesMode");
  if (mode === "unscoped") return { ok: true, agentRoles: null };
  if (mode !== "scoped") return { ok: false };
  const text = (form.get("agentRoles") ?? "").trim();
  return {
    ok: true,
    agentRoles:
      text.length === 0 ? [] : text.split(",").map((role) => role.trim())
  };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ owner: string; repository: string }> }
): Promise<NextResponse> {
  const { owner, repository } = await context.params;
  if (
    !WORKSPACE_OWNER_PATTERN.test(owner) ||
    !WORKSPACE_REPOSITORY_PATTERN.test(repository)
  ) {
    return redirectToWorkspaces(
      WORKSPACES_PATH,
      `${owner}/${repository}`,
      "failed"
    );
  }
  const workspaceId = `${owner}/${repository}`;
  if (!isSameOriginMutation(request)) {
    return redirectToWorkspaces(WORKSPACES_PATH, workspaceId, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form || form.getAll("expectedRevision").length !== 1) {
    return redirectToWorkspaces(WORKSPACES_PATH, workspaceId, "failed");
  }

  // Where the write answers to. The control carries it and the route checks it
  // against the Workspaces paths, so the destination is the surface the
  // operator wrote from and nothing else.
  const requestedReturnTo = form.get("returnTo");
  const returnTo = isWorkspacesReturnPath(requestedReturnTo)
    ? requestedReturnTo
    : WORKSPACES_PATH;

  const expectedRevision = form.get("expectedRevision");
  if (expectedRevision === null || !REVISION_PATTERN.test(expectedRevision)) {
    return redirectToWorkspaces(returnTo, workspaceId, "failed");
  }
  const enabled = form.get("enabled");
  if (enabled !== "true" && enabled !== "false") {
    return redirectToWorkspaces(returnTo, workspaceId, "validation");
  }
  const baseBranch = (form.get("baseBranch") ?? "").trim();
  if (baseBranch.length === 0) {
    return redirectToWorkspaces(returnTo, workspaceId, "validation");
  }
  const scope = readRoleScope(form);
  if (!scope.ok) {
    return redirectToWorkspaces(returnTo, workspaceId, "validation");
  }

  const config = readControlApiConfig();
  if (!config) {
    return redirectToWorkspaces(returnTo, workspaceId, "failed");
  }

  const result = await patchWorkspace(
    owner,
    repository,
    {
      expectedRevision,
      enabled: enabled === "true",
      baseBranch,
      agentRoles: scope.agentRoles
    },
    config
  );
  if (result.kind === "ok") {
    return redirectToWorkspaces(returnTo, workspaceId);
  }
  const outcome = saveOutcomeForFailure(result);
  return redirectToWorkspaces(
    returnTo,
    workspaceId,
    outcome,
    editorBaseRevision(outcome, expectedRevision)
  );
}
