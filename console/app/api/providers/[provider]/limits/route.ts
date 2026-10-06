/**
 * Server-only Console provider agent-limit mutation route.
 *
 * Receives the bounded form submission from a provider row's Per session /
 * Across sessions steppers or its Unlimited checkbox, validates its same-origin
 * browser context, and forwards a typed PATCH to Runtime using the server-side
 * Control API credential. The browser never receives that credential and never
 * bypasses Runtime.
 *
 * Both axes are always sent, including one the operator did not change: an
 * omitted axis is unobserved, and Runtime would read that as "leave it alone"
 * while the Console's own read of the row is what the operator is looking at.
 * An axis the operator explicitly cleared sends `unlimited`, which is a
 * decision and must not be confused with an axis that was not submitted.
 *
 * Only POST is exported. The response redirects back to the Providers page the
 * control was rendered on; any missing/invalid evidence or failed request adds
 * a could-not-be-confirmed notice instead of a success claim, because the
 * refreshed provider state is authoritative.
 */

import { type NextRequest,NextResponse } from "next/server.js";

import {
  isProvidersReturnPath,
  providersPath
} from "../../../../../src/features/providers/paths.ts";
import { withControlFailure } from "../../../../../src/lib/control-failure.ts";
import {
  patchProviderLimits,
  readControlApiConfig
} from "../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../src/lib/server/form-mutation.ts";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AGENT_LIMIT_PATTERN = /^\d{1,3}$/u;
const MAX_FORM_BODY_BYTES = 4096;
const MAX_AGENT_LIMIT = 999;

/**
 * One submitted limit axis. `ok: false` means the submission is malformed and
 * the route must fail closed; a successful `value` of `null` is the explicit
 * Unlimited decision, which is a different thing and must not be conflated
 * with a malformed value.
 */
type SubmittedLimit =
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false };

const MALFORMED_LIMIT: SubmittedLimit = { ok: false };

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

/**
 * Read one limit axis. "unlimited" is an explicit decision; anything else must
 * be a positive integer within the bound the steppers can produce. A missing or
 * malformed value fails the route rather than inventing a limit.
 */
function parseLimit(raw: string | null): SubmittedLimit {
  if (raw === "unlimited") return { ok: true, value: null };
  if (raw === null || !AGENT_LIMIT_PATTERN.test(raw)) return MALFORMED_LIMIT;
  const value = Number(raw);
  return value >= 1 && value <= MAX_AGENT_LIMIT
    ? { ok: true, value }
    : MALFORMED_LIMIT;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> }
): Promise<NextResponse> {
  const failed = (returnTo: string = providersPath()): NextResponse =>
    redirectTo(withControlFailure(returnTo));
  if (!isSameOriginMutation(request)) return failed();

  const { provider } = await context.params;
  if (!PROVIDER_ID_PATTERN.test(provider)) return failed();

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo)) return failed();
  const perSession = parseLimit(form.get("perSession"));
  const acrossSessions = parseLimit(form.get("acrossSessions"));
  if (
    !perSession.ok ||
    !acrossSessions.ok ||
    form.get("provider") !== provider ||
    form.size !== 4
  ) {
    return failed(returnTo);
  }

  const config = readControlApiConfig();
  if (!config) return failed(returnTo);

  const result = await patchProviderLimits(
    provider,
    { perSession: perSession.value, acrossSessions: acrossSessions.value },
    config
  );
  return result.kind === "ok" ? redirectTo(returnTo) : failed(returnTo);
}