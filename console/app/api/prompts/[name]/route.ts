/** Same-origin mutation boundary for canonical RuleSync slash commands. */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  patchPromptCommand,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";

const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FORM_BODY_BYTES = 160_000;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectToPrompt(
  name: string,
  saveOutcome?: "conflict" | "validation" | "apply-failed" | "failed"
): NextResponse {
  const path = `/prompts/${encodeURIComponent(name)}`;
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: saveOutcome ? `${path}?save=${saveOutcome}` : path
    }
  });
}

function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchPromptCommand>>
): "conflict" | "validation" | "apply-failed" | "failed" {
  if (result.kind !== "http-error") return "failed";
  switch (result.code) {
    case "autodev_control_prompt_revision_conflict": {
      return "conflict";
    }
    case "autodev_control_prompt_invalid_source": {
      return "validation";
    }
    case "autodev_control_prompt_apply_failed": {
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
  if (!COMMAND_NAME_PATTERN.test(name) || !isSameOriginMutation(request)) {
    return redirectToPrompt(name, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (
    !form ||
    form.size !== 2 ||
    form.getAll("content").length !== 1 ||
    form.getAll("expectedRevision").length !== 1
  ) {
    return redirectToPrompt(name, "failed");
  }

  const content = form.get("content");
  const expectedRevision = form.get("expectedRevision");
  if (
    content === null ||
    expectedRevision === null ||
    !REVISION_PATTERN.test(expectedRevision)
  ) {
    return redirectToPrompt(name, "failed");
  }

  const config = readControlApiConfig();
  if (!config) return redirectToPrompt(name, "failed");

  const result = await patchPromptCommand(
    name,
    { content, expectedRevision },
    config
  );
  return result.kind === "ok"
    ? redirectToPrompt(name)
    : redirectToPrompt(name, saveOutcomeForFailure(result));
}
