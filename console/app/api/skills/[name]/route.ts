/** Same-origin mutation boundary for RuleSync skill role assignment. */

import { type NextRequest, NextResponse } from "next/server.js";

import { saveOutcomeForConvergence } from "../../../../src/features/skills/SkillRoleAssignment.ts";
import { skillsListHref } from "../../../../src/features/skills/skills-list-url.ts";
import {
  patchSkillRoles,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_FORM_BODY_BYTES = 8000;
type SaveOutcome =
  | "conflict"
  | "validation"
  | "not-found"
  | "failed"
  | "pending"
  | "not-observed"
  | "unconfirmed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Assignments are made from `/skills`, which is the only page that knows the
 * contract revision every row was drawn from. A redirect is the whole response
 * because this boundary has no client JavaScript to render a failure with, so
 * `save=` is the only channel back to the operator.
 *
 * The narrowing travels on the request's own query, and the address is
 * rebuilt here rather than followed: the route never takes a path from the
 * request, so there is nothing in the flow that could point anywhere but the
 * skill list. The body carries the desired role set and nothing else.
 */
function redirectToSkills(
  listRole: string,
  saveOutcome?: SaveOutcome
): NextResponse {
  const url = new URL(
    skillsListHref({ role: listRole }),
    "http://skills.invalid"
  );
  if (saveOutcome) url.searchParams.set("save", saveOutcome);
  return new NextResponse(null, {
    status: 303,
    headers: { location: `${url.pathname}${url.search}` }
  });
}

function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchSkillRoles>>
): SaveOutcome {
  if (result.kind !== "http-error") {
    return result.kind === "unauthorized" ? "failed" : "unconfirmed";
  }
  if (result.status >= 500) return "unconfirmed";
  switch (result.code) {
    case "autodev_control_execution_contract_conflict": {
      return "conflict";
    }
    case "autodev_control_execution_contract_invalid":
    case "autodev_control_api_invalid_body": {
      return "validation";
    }
    case "autodev_control_skill_not_found": {
      return "not-found";
    }
    default: {
      return "failed";
    }
  }
}

function saveOutcomeForResult(
  result: Awaited<ReturnType<typeof patchSkillRoles>>
): SaveOutcome | undefined {
  if (result.kind !== "ok") return saveOutcomeForFailure(result);
  return saveOutcomeForConvergence(
    result.data.reconciliation.status.convergence
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const { name } = await context.params;
  // The narrowing the list was at. Read first, because a failure part-way
  // through still has to return the operator to it.
  const listRole = request.nextUrl.searchParams.get("role") ?? "";
  if (!SKILL_NAME_PATTERN.test(name) || !isSameOriginMutation(request)) {
    return redirectToSkills(listRole, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form || !form.has("expectedRevision")) {
    return redirectToSkills(listRole, "failed");
  }

  const expectedRevision = form.get("expectedRevision");
  // Every checked box submits under the same name, and an unassigned skill
  // submits none at all. Both are legitimate complete-desired-set answers, so
  // the role list is read as "whatever was checked" rather than requiring
  // exactly one occurrence -- requiring one would make unassigning impossible
  // to express and would refuse the empty set that clears an assignment.
  const roles = form.getAll("roles");
  if (
    expectedRevision === null ||
    !REVISION_PATTERN.test(expectedRevision) ||
    roles.some((role) => !ROLE_PATTERN.test(role)) ||
    new Set(roles).size !== roles.length
  ) {
    return redirectToSkills(listRole, "failed");
  }

  const config = readControlApiConfig();
  if (!config) return redirectToSkills(listRole, "failed");

  const result = await patchSkillRoles(
    name,
    { expectedRevision, roles },
    config
  );
  return redirectToSkills(listRole, saveOutcomeForResult(result));
}
