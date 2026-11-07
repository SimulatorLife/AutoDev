/**
 * Server-only Console provider re-check route.
 *
 * Receives the bounded form submission from the refresh control on a provider
 * row's Unavailable Status badge, validates its same-origin browser context,
 * and asks Runtime to re-check the provider (its live probe and model listing)
 * with the server-side Control API credential. The browser never receives that
 * credential and never reaches Runtime directly.
 *
 * Only POST is exported. The response redirects back to the Providers page the
 * control was rendered on, where the refreshed Status is authoritative; a
 * request Runtime did not answer adds the could-not-be-confirmed notice. A
 * check that ran and found the provider still unavailable is not a failed
 * request: the redirected page shows that verdict.
 */

import { type NextRequest, NextResponse } from "next/server.js";

import {
  isProvidersReturnPath,
  providersPath
} from "../../../../../src/features/providers/paths.ts";
import { withControlFailure } from "../../../../../src/lib/control-failure.ts";
import {
  checkProvider,
  readControlApiConfig
} from "../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../src/lib/server/form-mutation.ts";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FORM_BODY_BYTES = 4096;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectTo(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
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
  if (form.get("provider") !== provider || form.size !== 2) {
    return failed(returnTo);
  }

  const config = readControlApiConfig();
  if (!config) return failed(returnTo);

  const result = await checkProvider(provider, config);
  return result.kind === "ok" ? redirectTo(returnTo) : failed(returnTo);
}
