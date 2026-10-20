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

const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FORM_BODY_BYTES = 4096;

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
  const failed = (returnTo: string = "/agents"): NextResponse =>
    redirectTo(withControlFailure(returnTo));
  if (!isSameOriginMutation(request)) return failed();

  const { role } = await context.params;
  if (!ROLE_PATTERN.test(role)) return failed();
  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();

  const returnTo = form.get("returnTo");
  if (!isAgentsReturnPath(returnTo)) return failed();
  const enabled = parseEnabled(form.get("enabled"));
  const expectedRevision = parseRevision(form.get("expectedRevision"));
  if (
    enabled === null ||
    expectedRevision === null ||
    form.get("role") !== role ||
    form.size !== 4
  ) {
    return failed(returnTo);
  }

  const config = readControlApiConfig();
  if (!config) return failed(returnTo);
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
    return redirectTo(withControlRefusal(returnTo, "conflicted"));
  }
  return failed(returnTo);
}
