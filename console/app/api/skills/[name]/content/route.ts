/** Same-origin mutation boundary for canonical RuleSync skill content. */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  type CanonicalSourceSaveOutcome,
  editorBaseRevision
} from "../../../../../src/lib/server/canonical-source.ts";
import {
  patchSkillContent,
  readControlApiConfig
} from "../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../src/lib/server/form-mutation.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FORM_BODY_BYTES = 160_000;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectToSkill(
  name: string,
  outcome?: CanonicalSourceSaveOutcome,
  basedOn?: string
): NextResponse {
  const path = `/skills/${encodeURIComponent(name)}`;
  const query = new URLSearchParams();
  if (outcome) query.set("save", outcome);
  if (basedOn) query.set("based", basedOn);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return new NextResponse(null, {
    status: 303,
    headers: { location: `${path}${suffix}` }
  });
}

function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchSkillContent>>
): CanonicalSourceSaveOutcome {
  if (result.kind !== "http-error") return "failed";
  switch (result.code) {
    case "autodev_control_skill_content_conflict": {
      return "conflict";
    }
    case "autodev_control_skill_source_invalid":
    case "autodev_control_api_invalid_body": {
      return "validation";
    }
    case "autodev_control_skill_apply_failed": {
      return "apply-failed";
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
    return redirectToSkill(name, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (
    !form ||
    form.size !== 2 ||
    form.getAll("content").length !== 1 ||
    form.getAll("expectedRevision").length !== 1
  ) {
    return redirectToSkill(name, "failed");
  }

  const content = form.get("content");
  const expectedRevision = form.get("expectedRevision");
  if (
    content === null ||
    expectedRevision === null ||
    !REVISION_PATTERN.test(expectedRevision)
  ) {
    return redirectToSkill(name, "failed");
  }

  const config = readControlApiConfig();
  if (!config) return redirectToSkill(name, "failed");

  const result = await patchSkillContent(
    name,
    { content, expectedRevision },
    config
  );
  if (result.kind === "ok") return redirectToSkill(name);
  const outcome = saveOutcomeForFailure(result);
  return redirectToSkill(
    name,
    outcome,
    editorBaseRevision(outcome, expectedRevision)
  );
}
