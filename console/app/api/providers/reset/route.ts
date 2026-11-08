/**
 * Same-origin, confirmation-bound entry point for resetting provider overrides.
 * The browser sends no Runtime credential or configuration body; this route
 * validates the form and invokes one typed Control API operation server-side.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  isProvidersReturnPath,
  providersPath
} from "../../../../src/features/providers/paths.ts";
import {
  withControlFailure,
  withControlRefusal
} from "../../../../src/lib/control-failure.ts";
import {
  readControlApiConfig,
  resetProviderSettings
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

const MAX_FORM_BODY_BYTES = 4096;

const ROUTE = "/api/providers/reset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const resource = "providers/reset";
  const failed = (
    rejection: Omit<MutationRejection, "route">,
    returnTo: string = providersPath()
  ): NextResponse => {
    logMutationRejection({ route: ROUTE, ...rejection });
    return redirectTo(withControlFailure(returnTo));
  };
  if (!isSameOriginMutation(request)) return failed({ cause: "cross_origin" });

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed({ cause: "invalid_body" });

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo))
    return failed({ cause: "invalid_return_path" });
  if (form.get("confirm") !== "true") {
    logMutationRejection({ route: ROUTE, cause: "invalid_fields", resource });
    return redirectTo(withControlRefusal(returnTo, "confirmation_missing"));
  }
  if (form.size !== 2)
    return failed({ cause: "invalid_fields", resource }, returnTo);

  const config = readControlApiConfig();
  if (!config)
    return failed({ cause: "control_api_unconfigured", resource }, returnTo);

  const result = await resetProviderSettings(config);
  if (result.kind === "ok") return redirectTo(returnTo);
  return failed({ ...runtimeRejection(result), resource }, returnTo);
}
