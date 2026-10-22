/**
 * Same-origin boundary for writing one MCP server's canonical declaration.
 *
 * The route receives the operator's edit, validates its same-origin browser
 * context, and forwards a typed PATCH to Runtime using the server-side Control
 * API credential. The browser never receives that credential and never
 * bypasses Runtime: the declaration is written by the Runtime, which applies
 * the projection and observes what it published.
 *
 * The route answers with a redirect rather than with a body. That is the
 * Console's own mutation boundary: the navigation owner reads the redirect,
 * moves the page to the destination, and the page renders the outcome from the
 * query. A route that answered with a body instead would leave the page
 * holding the state it had before the write, which is how a feature ends up
 * showing two truths about the same declaration.
 *
 * Only POST is exported. A refused write answers with the Runtime's reason --
 * a conflict, a refused declaration or a failed projection are different
 * facts, and the operator is told which one happened.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  type CanonicalSourceSaveOutcome,
  editorBaseRevision
} from "../../../../src/lib/server/canonical-source.ts";
import {
  patchMcpServer,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FORM_BODY_BYTES = 16_384;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The launch keys the edit form carries. */
const LAUNCH_FIELDS = [
  "command",
  "args",
  "cwd",
  "url",
  "bearerTokenEnvVar"
] as const;

/**
 * The redirect back to the server's Configuration tab.
 *
 * The tab is in the destination because the edit surface lives on it: a write
 * that answered with a redirect to the server's Overview would leave the
 * operator on a tab that says nothing about what they just changed.
 */
function redirectToMcpServer(
  name: string,
  outcome?: CanonicalSourceSaveOutcome,
  basedOn?: string
): NextResponse {
  const path = `/mcps/${encodeURIComponent(name)}`;
  const query = new URLSearchParams({ tab: "configuration" });
  if (outcome) query.set("save", outcome);
  if (basedOn) query.set("based", basedOn);
  return new NextResponse(null, {
    status: 303,
    headers: { location: `${path}?${query.toString()}` }
  });
}

/**
 * The launch configuration the form carries.
 *
 * A field the operator cleared is `null`, which removes that key from the
 * declaration. The arguments are one per line, because a launcher is given a
 * list and a list is what an operator reads a list as. The headers are not in
 * the form, so they are not in the write either: a key the form does not carry
 * is a key the write leaves alone.
 */
function readLaunch(form: URLSearchParams): {
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
} | null {
  for (const field of LAUNCH_FIELDS) {
    if (form.getAll(field).length !== 1) return null;
  }
  const text = (key: string): string | null => {
    const value = form.get(key);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : value;
  };
  const rawArgs = form.get("args");
  if (rawArgs === null) return null;
  const args = rawArgs
    .split("\n")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
  return {
    command: text("command"),
    args: args.length === 0 ? null : args,
    cwd: text("cwd"),
    url: text("url"),
    bearerTokenEnvVar: text("bearerTokenEnvVar")
  };
}

/**
 * The outcome a refusal is reported as.
 *
 * A conflict and a refused declaration are different facts: the first says
 * the declaration moved under the write, the second says the write could not
 * be expressed. They get different outcomes, and the reason is the Runtime's.
 */
function saveOutcomeForFailure(
  result: Awaited<ReturnType<typeof patchMcpServer>>
): CanonicalSourceSaveOutcome {
  if (result.kind !== "http-error") return "failed";
  switch (result.code) {
    case "autodev_control_mcp_revision_conflict": {
      return "conflict";
    }
    case "autodev_control_mcp_invalid_declaration":
    case "autodev_control_api_invalid_body": {
      return "validation";
    }
    case "autodev_control_mcp_apply_failed": {
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
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return redirectToMcpServer(name, "failed");
  }
  if (!isSameOriginMutation(request)) {
    return redirectToMcpServer(name, "failed");
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (
    !form ||
    form.size !== LAUNCH_FIELDS.length + 1 ||
    form.getAll("expectedRevision").length !== 1
  ) {
    return redirectToMcpServer(name, "failed");
  }

  const expectedRevision = form.get("expectedRevision");
  if (expectedRevision === null || !REVISION_PATTERN.test(expectedRevision)) {
    return redirectToMcpServer(name, "failed");
  }
  const launch = readLaunch(form);
  if (launch === null) {
    return redirectToMcpServer(name, "validation");
  }

  const config = readControlApiConfig();
  if (!config) {
    return redirectToMcpServer(name, "failed");
  }

  const result = await patchMcpServer(
    name,
    { expectedRevision, launch },
    config
  );
  if (result.kind === "ok") {
    return redirectToMcpServer(name);
  }
  const outcome = saveOutcomeForFailure(result);
  return redirectToMcpServer(
    name,
    outcome,
    editorBaseRevision(outcome, expectedRevision)
  );
}
