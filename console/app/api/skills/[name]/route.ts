/** Same-origin mutation boundary for RuleSync skill role assignment. */

import { type NextRequest, NextResponse } from "next/server.js";

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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Assignments are made from `/skills`, which is the only page that knows the
 * contract revision every row was drawn from. A redirect is the whole response
 * because this boundary has no client JavaScript to render a failure with, so
 * `save=` is the only channel back to the operator.
 */
function redirectToSkills(
  name: string,
  saveOutcome?: "conflict" | "validation" | "not-found" | "failed"
): NextResponse {
  const query = saveOutcome ? `?save=${saveOutcome}&skill=${encodeURIComponent(name)}` : "";
  return new NextResponse(null, {
    status: 303,
    headers: { location: `/skills${query}` }
  });
}

function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchSkillRoles>>
): "conflict" | "validation" | "not-found" | "failed" {
  if (result.kind !== "http-error") return "failed";
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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const { name } = await context.params;
  if (!SKILL_NAME_PATTERN.test(name) || !isSameOriginMutation(request)) {
    return redirectToSkills(name, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form || !form.has("expectedRevision")) {
    return redirectToSkills(name, "failed");
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
    return redirectToSkills(name, "failed");
  }

  const config = readControlApiConfig();
  if (!config) return redirectToSkills(name, "failed");

  const result = await patchSkillRoles(
    name,
    { expectedRevision, roles },
    config
  );
  return result.kind === "ok"
    ? redirectToSkills(name)
    : redirectToSkills(name, saveOutcomeForFailure(result));
}