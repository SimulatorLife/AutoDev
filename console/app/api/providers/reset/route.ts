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

const MAX_FORM_BODY_BYTES = 4096;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const failed = (returnTo: string = providersPath()): NextResponse =>
    redirectTo(withControlFailure(returnTo));
  if (!isSameOriginMutation(request)) return failed();

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo)) return failed();
  if (form.get("confirm") !== "true") {
    return redirectTo(withControlRefusal(returnTo, "confirmation_missing"));
  }
  if (form.size !== 2) return failed(returnTo);

  const config = readControlApiConfig();
  if (!config) return failed(returnTo);

  const result = await resetProviderSettings(config);
  return result.kind === "ok" ? redirectTo(returnTo) : failed(returnTo);
}
