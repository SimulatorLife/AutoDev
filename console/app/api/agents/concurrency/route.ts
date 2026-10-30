/**
 * Server-only Console orchestrator concurrency limit mutation route.
 *
 * Receives the bounded form submission from the concurrency stepper, Unlimited
 * control, or reset button, validates its same-origin browser context, and
 * forwards a typed PATCH to Runtime using the server-side Control API credential.
 *
 * Only POST is exported. The response redirects back to the Agents page or
 * Agent detail page the control was rendered on; any error or conflict attaches
 * a refusal/failure query parameter.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  AGENTS_PATH,
  isAgentsReturnPath
} from "../../../../src/features/agents/paths.ts";
import {
  withControlFailure,
  withControlRefusal
} from "../../../../src/lib/control-failure.ts";
import {
  patchConcurrencyLimit,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";

const CONCURRENCY_LIMIT_PATTERN = /^\d{1,3}$/u;
const REVISION_PATTERN = /^[1-9]\d{0,15}$/u;
const MAX_FORM_BODY_BYTES = 4096;
const MAX_CONCURRENCY_LIMIT = 999;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

function parseRevision(
  raw: string | null
):
  | { readonly valid: true; readonly revision?: number }
  | { readonly valid: false } {
  if (raw === null || raw === "") {
    return { valid: true };
  }
  if (!REVISION_PATTERN.test(raw)) {
    return { valid: false };
  }
  return { valid: true, revision: Number(raw) };
}

interface ConcurrencyMutationPayload {
  readonly maxConcurrentThreadsPerSession?: number | null;
  readonly resetToConfigFile?: boolean;
  readonly revision?: number;
}

function resolvePayload(
  form: URLSearchParams,
  revision: number | undefined
): ConcurrencyMutationPayload | null {
  const revisionEntry = revision === undefined ? {} : { revision };
  if (form.get("resetToConfigFile") === "true") {
    return { resetToConfigFile: true, ...revisionEntry };
  }
  const setLimit = form.get("setLimit") ?? form.get("limit");
  if (form.get("setUnlimited") === "true" || setLimit === "unlimited") {
    return { maxConcurrentThreadsPerSession: null, ...revisionEntry };
  }
  if (setLimit !== null && CONCURRENCY_LIMIT_PATTERN.test(setLimit)) {
    const limitNum = Number(setLimit);
    if (limitNum >= 0 && limitNum <= MAX_CONCURRENCY_LIMIT) {
      return { maxConcurrentThreadsPerSession: limitNum, ...revisionEntry };
    }
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const failed = (returnTo: string = AGENTS_PATH): NextResponse =>
    redirectTo(withControlFailure(returnTo));

  if (!isSameOriginMutation(request)) return failed();

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();

  const returnTo = form.get("returnTo");
  if (!isAgentsReturnPath(returnTo)) return failed();

  const parsedRevision = parseRevision(form.get("revision"));
  if (!parsedRevision.valid) return failed(returnTo);
  const revision = parsedRevision.revision;

  const requestPayload = resolvePayload(form, revision);
  if (!requestPayload) return failed(returnTo);

  const config = readControlApiConfig();
  if (!config) return failed(returnTo);

  const result = await patchConcurrencyLimit(requestPayload, config);
  if (result.kind === "ok") {
    // The Runtime published its reconciliation view with the write, so the
    // route can say whether the limit it is enforcing is the one that was
    // asked for. A write that was accepted but not observed is neither a
    // refusal nor a failure, and saying so is what keeps the redirect from
    // claiming a limit the Runtime has not confirmed.
    if (result.data.reconciliation.status.convergence !== "converged") {
      return redirectTo(withControlRefusal(returnTo, "not_observed"));
    }
    return redirectTo(returnTo);
  }

  if (result.kind === "http-error") {
    if (result.status === 409) {
      return redirectTo(withControlRefusal(returnTo, "conflicted"));
    }
    if (result.status === 403) {
      return redirectTo(withControlRefusal(returnTo, "forbidden"));
    }
  }

  return failed(returnTo);
}
