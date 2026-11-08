/**
 * Server-only Console provider enablement mutation route.
 *
 * Receives the bounded form submission from a provider row's Disabled toggle,
 * validates its same-origin browser context, and forwards a typed PATCH to
 * Runtime using the server-side Control API credential. The browser never
 * receives that credential and never bypasses Runtime.
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
} from "../../../../src/features/providers/paths.ts";
import { withControlFailure } from "../../../../src/lib/control-failure.ts";
import {
  patchProviderEnabled,
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

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FORM_BODY_BYTES = 4096;

const ROUTE = "/api/providers/[provider]";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

function parseDisabled(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
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
  const resource = `providers/${provider}`;

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed({ cause: "invalid_body" });

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo))
    return failed({ cause: "invalid_return_path" });
  const disabled = parseDisabled(form.get("disabled"));
  if (
    disabled === null ||
    form.get("provider") !== provider ||
    form.size !== 3
  ) {
    return failed({ cause: "invalid_fields", resource }, returnTo);
  }

  const config = readControlApiConfig();
  if (!config)
    return failed({ cause: "control_api_unconfigured", resource }, returnTo);

  const result = await patchProviderEnabled(provider, disabled, config);
  if (result.kind === "ok") return redirectTo(returnTo);
  return failed({ ...runtimeRejection(result), resource }, returnTo);
}
