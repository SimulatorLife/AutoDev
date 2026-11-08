/**
 * Server-only Console model enablement route.
 *
 * Receives the bounded form submission from a model toggle on a Providers
 * page, validates its same-origin browser context, and forwards a typed PATCH
 * to Runtime using the server-side Control API credential.
 *
 * Only POST is exported. The response redirects back to the Providers page
 * the toggle was rendered on, adding a could-not-be-confirmed notice when the
 * submission is invalid or Runtime rejects it.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  isProvidersReturnPath,
  providersPath
} from "../../../../src/features/providers/paths.ts";
import { withControlFailure } from "../../../../src/lib/control-failure.ts";
import {
  patchModel,
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

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FORM_BODY_BYTES = 4096;

const ROUTE = "/api/models/[model]";

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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ model: string }> }
): Promise<NextResponse> {
  const failed = (
    rejection: Omit<MutationRejection, "route">,
    returnTo: string = providersPath("models")
  ): NextResponse => {
    logMutationRejection({ route: ROUTE, ...rejection });
    return redirectTo(withControlFailure(returnTo));
  };
  if (!isSameOriginMutation(request)) return failed({ cause: "cross_origin" });

  const { model } = await context.params;
  if (!MODEL_ID_PATTERN.test(model)) return failed({ cause: "invalid_target" });
  const resource = `models/${model}`;

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed({ cause: "invalid_body" });

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo))
    return failed({ cause: "invalid_return_path" });
  const enabled = parseEnabled(form.get("enabled"));
  if (enabled === null || form.get("model") !== model || form.size !== 3) {
    return failed({ cause: "invalid_fields", resource }, returnTo);
  }

  const config = readControlApiConfig();
  if (!config)
    return failed({ cause: "control_api_unconfigured", resource }, returnTo);

  const result = await patchModel(model, enabled, config);
  if (result.kind === "ok") return redirectTo(returnTo);
  return failed({ ...runtimeRejection(result), resource }, returnTo);
}
