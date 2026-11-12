/**
 * Server-only Console agent-model mutation route.
 *
 * Receives the bounded form submission from an agent-model control on a
 * provider's page, validates its same-origin browser context, and forwards a
 * typed PATCH to Runtime using the server-side Control API credential. An
 * empty `model` returns the role to its tier's model.
 *
 * Only POST is exported. The response redirects back to the page the control
 * was rendered on, with a could-not-be-confirmed or refusal notice on failure.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  isProvidersReturnPath,
  providersPath
} from "../../../../../../src/features/providers/paths.ts";
import {
  withControlFailure,
  withControlRefusal
} from "../../../../../../src/lib/control-failure.ts";
import {
  patchAgentModel,
  readControlApiConfig
} from "../../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../src/lib/server/form-mutation.ts";
import {
  logMutationRejection,
  type MutationRejection,
  runtimeRejection
} from "../../../../../../src/lib/server/mutation-rejection.ts";
import { providerMutationRefusalFor } from "../../../../../../src/lib/server/provider-mutation-refusal.ts";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AGENT_ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_FORM_BODY_BYTES = 4096;

const ROUTE = "/api/providers/[provider]/agents/[role]";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string; role: string }> }
): Promise<NextResponse> {
  const failed = (
    rejection: Omit<MutationRejection, "route">,
    returnTo: string = providersPath()
  ): NextResponse => {
    logMutationRejection({ route: ROUTE, ...rejection });
    return redirectTo(withControlFailure(returnTo));
  };
  if (!isSameOriginMutation(request)) return failed({ cause: "cross_origin" });

  const { provider, role } = await context.params;
  const resource = `providers/${provider}/agents/${role}`;
  if (!PROVIDER_ID_PATTERN.test(provider) || !AGENT_ROLE_PATTERN.test(role)) {
    return failed({ cause: "invalid_target" });
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed({ cause: "invalid_body" });

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo))
    return failed({ cause: "invalid_return_path" });
  const rawModel = form.get("model");
  if (
    form.size !== 4 ||
    rawModel === null ||
    form.get("provider") !== provider ||
    form.get("role") !== role
  ) {
    return failed({ cause: "invalid_fields", resource }, returnTo);
  }

  const config = readControlApiConfig();
  if (!config)
    return failed({ cause: "control_api_unconfigured", resource }, returnTo);

  const result = await patchAgentModel(
    provider,
    role,
    rawModel.length > 0 ? rawModel : null,
    config
  );
  if (result.kind === "ok") return redirectTo(returnTo);
  logMutationRejection({ route: ROUTE, ...runtimeRejection(result), resource });
  const refusal = providerMutationRefusalFor(result);
  return redirectTo(
    refusal === undefined
      ? withControlFailure(returnTo)
      : withControlRefusal(returnTo, refusal)
  );
}
