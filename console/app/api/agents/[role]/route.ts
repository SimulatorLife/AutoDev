/**
 * Server-only Console Agent enablement mutation route. The browser submits a
 * bounded same-origin form; only this server route holds the Control API
 * credential and forwards the revision-checked PATCH to Runtime.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import { isAgentsReturnPath } from "../../../../src/features/agents/paths.ts";
import {
  withControlFailure,
  withControlRefusal
} from "../../../../src/lib/control-failure.ts";
import {
  patchAgentEnablement,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";
import {
  logMutationRejection,
  type MutationRejection,
  runtimeRejection
} from "../../../../src/lib/server/mutation-rejection.ts";

const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FORM_BODY_BYTES = 4096;

const ROUTE = "/api/agents/[role]";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

function parseEnabled(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function parseRevision(raw: string | null): string | null {
  return raw !== null && raw.length > 0 && raw.length <= 256 ? raw : null;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ role: string }> }
): Promise<NextResponse> {
  const failed = (
    rejection: Omit<MutationRejection, "route">,
    returnTo: string = "/agents"
  ): NextResponse => {
    logMutationRejection({ route: ROUTE, ...rejection });
    return redirectTo(withControlFailure(returnTo));
  };
  if (!isSameOriginMutation(request)) return failed({ cause: "cross_origin" });

  const { role } = await context.params;
  if (!ROLE_PATTERN.test(role)) return failed({ cause: "invalid_target" });
  const resource = `agents/${role}`;
  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed({ cause: "invalid_body" });

  const returnTo = form.get("returnTo");
  if (!isAgentsReturnPath(returnTo))
    return failed({ cause: "invalid_return_path" });
  const enabled = parseEnabled(form.get("enabled"));
  const expectedRevision = parseRevision(form.get("expectedRevision"));
  if (
    enabled === null ||
    expectedRevision === null ||
    form.get("role") !== role ||
    form.size !== 4
  ) {
    return failed({ cause: "invalid_fields", resource }, returnTo);
  }

  const config = readControlApiConfig();
  if (!config)
    return failed({ cause: "control_api_unconfigured", resource }, returnTo);
  const result = await patchAgentEnablement(
    role,
    { enabled, expectedRevision },
    config
  );
  if (result.kind === "ok") return redirectTo(returnTo);
  // A stale revision is a conflict, and the operator's next move is different
  // from every other refusal: the enablement changed after this page was
  // read, so the answer is to reload and decide again rather than to send the
  // same write again. The generic notice would not say that, and would leave
  // the first operator retrying an identical request.
  if (result.kind === "http-error" && result.status === 409) {
    logMutationRejection({
      route: ROUTE,
      ...runtimeRejection(result),
      resource
    });
    return redirectTo(withControlRefusal(returnTo, "conflicted"));
  }
  return failed({ ...runtimeRejection(result), resource }, returnTo);
}
