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
  providersPath,
  withControlFailure
} from "../../../../src/features/providers/paths.ts";
import {
  patchModel,
  readControlApiConfig
} from "../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../src/lib/server/form-mutation.ts";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ model: string }> }
): Promise<NextResponse> {
  const failed = (returnTo: string = providersPath("models")): NextResponse =>
    redirectTo(withControlFailure(returnTo));
  if (!isSameOriginMutation(request)) return failed();

  const { model } = await context.params;
  if (!MODEL_ID_PATTERN.test(model)) return failed();

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo)) return failed();
  const enabled = parseEnabled(form.get("enabled"));
  if (enabled === null || form.get("model") !== model || form.size !== 3) {
    return failed(returnTo);
  }

  const config = readControlApiConfig();
  if (!config) return failed(returnTo);

  const result = await patchModel(model, enabled, config);
  return result.kind === "ok" ? redirectTo(returnTo) : failed(returnTo);
}
