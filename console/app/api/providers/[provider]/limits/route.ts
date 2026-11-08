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

import { type NextRequest, NextResponse } from "next/server.js";

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
import {
  logMutationRejection,
  type MutationRejection,
  runtimeRejection
} from "../../../../../src/lib/server/mutation-rejection.ts";

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
  { readonly ok: true; readonly value: number | null } | { readonly ok: false };

/**
 * The single change a submission makes, as a partial limits pair. A malformed
 * change fails the route closed.
 */
type SubmittedChange =
  | {
      readonly ok: true;
      readonly next: {
        readonly perSession?: number | null;
        readonly acrossSessions?: number | null;
      };
    }
  | { readonly ok: false };

const MALFORMED_LIMIT: SubmittedLimit = { ok: false };
const MALFORMED_CHANGE: SubmittedChange = { ok: false };

const ROUTE = "/api/providers/[provider]/limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

/**
 * Read the current value of one axis. "unlimited" is an explicit decision;
 * anything else must be a positive integer within the bound the steppers can
 * produce. A missing or malformed value fails the route rather than inventing a
 * limit.
 */
function parseAxis(raw: string | null): SubmittedLimit {
  if (raw === "unlimited") return { ok: true, value: null };
  if (raw === null || !AGENT_LIMIT_PATTERN.test(raw)) return MALFORMED_LIMIT;
  const value = Number(raw);
  return value >= 1 && value <= MAX_AGENT_LIMIT
    ? { ok: true, value }
    : MALFORMED_LIMIT;
}

/**
 * The single change this submission makes.
 *
 * The steppers and the Unlimited control are submit buttons carrying the value
 * they would set, under names distinct from the hidden fields holding the state
 * they would change. Exactly one of them must be present: without an override
 * the submission describes no change, and with two it is ambiguous which one the
 * operator meant.
 */
function readOverride(form: URLSearchParams): SubmittedChange {
  const unlimited = form.get("setUnlimited");
  if (unlimited !== null) {
    return unlimited === "true"
      ? { ok: true, next: { perSession: null, acrossSessions: null } }
      : MALFORMED_CHANGE;
  }
  const perSession = form.get("setPerSession");
  const acrossSessions = form.get("setAcrossSessions");
  const named = [perSession, acrossSessions].filter((value) => value !== null);
  if (named.length !== 1) return MALFORMED_CHANGE;
  // `named.length === 1` above means exactly one axis was submitted, so this
  // names the other one by elimination. Stated in the positive form because
  // `unicorn/no-negated-condition` treats a negated ternary as a smell, and
  // "which axis is absent" is the question this line is actually answering.
  const axis = perSession === null ? "acrossSessions" : "perSession";
  const parsed = parseAxis(named[0] ?? null);
  return parsed.ok
    ? { ok: true, next: { [axis]: parsed.value } }
    : MALFORMED_CHANGE;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> }
): Promise<NextResponse> {
  const failed = (
    rejection: Omit<MutationRejection, "route">,
    returnTo: string = providersPath()
  ): NextResponse => {
    logMutationRejection({ route: ROUTE, ...rejection });
    return redirectTo(withControlFailure(returnTo));
  };
  if (!isSameOriginMutation(request)) return failed({ cause: "cross_origin" });

  const { provider } = await context.params;
  if (!PROVIDER_ID_PATTERN.test(provider))
    return failed({ cause: "invalid_target" });
  const resource = `providers/${provider}/limits`;

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed({ cause: "invalid_body" });

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo))
    return failed({ cause: "invalid_return_path" });
  const perSession = parseAxis(form.get("perSession"));
  const acrossSessions = parseAxis(form.get("acrossSessions"));
  const override = readOverride(form);
  if (
    !perSession.ok ||
    !acrossSessions.ok ||
    !override.ok ||
    form.get("provider") !== provider
  ) {
    return failed({ cause: "invalid_fields", resource }, returnTo);
  }

  const config = readControlApiConfig();
  if (!config)
    return failed({ cause: "control_api_unconfigured", resource }, returnTo);

  // The unchanged axis travels with the submission so both are always sent, but
  // the operator's change is the one that moves: an axis they did not touch
  // keeps exactly the value the form carried.
  const result = await patchProviderLimits(
    provider,
    {
      perSession:
        override.next.perSession === undefined
          ? perSession.value
          : override.next.perSession,
      acrossSessions:
        override.next.acrossSessions === undefined
          ? acrossSessions.value
          : override.next.acrossSessions
    },
    config
  );
  if (result.kind === "ok") return redirectTo(returnTo);
  return failed({ ...runtimeRejection(result), resource }, returnTo);
}
