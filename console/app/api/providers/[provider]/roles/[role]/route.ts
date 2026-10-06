/**
 * Server-only Console provider-role mutation route.
 *
 * Receives the bounded form submission from a provider-role toggle on a
 * Providers page, validates its same-origin browser context, and forwards a
 * typed PATCH to Runtime using the server-side Control API credential. The
 * browser never receives that credential and never bypasses Runtime.
 *
 * Only POST is exported. The response redirects back to the Providers page
 * the toggle was rendered on; any missing/invalid evidence or failed request
 * adds a could-not-be-confirmed notice instead of a success claim, because the
 * refreshed role value is authoritative.
 */

import { PROVIDER_ROLES, type ProviderRole } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  isProvidersReturnPath,
  providersPath
} from "../../../../../../src/features/providers/paths.ts";
import { withControlFailure } from "../../../../../../src/lib/control-failure.ts";
import {
  patchProviderRole,
  readControlApiConfig
} from "../../../../../../src/lib/server/control-api.ts";
import {
  isSameOriginMutation,
  readStrictUrlEncodedFormBody
} from "../../../../../../src/lib/server/form-mutation.ts";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FORM_BODY_BYTES = 4096;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isProviderRole(value: string): value is ProviderRole {
  return PROVIDER_ROLES.includes(value as ProviderRole);
}

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
  context: { params: Promise<{ provider: string; role: string }> }
): Promise<NextResponse> {
  const failed = (returnTo: string = providersPath()): NextResponse =>
    redirectTo(withControlFailure(returnTo));
  if (!isSameOriginMutation(request)) return failed();

  const { provider, role } = await context.params;
  if (!PROVIDER_ID_PATTERN.test(provider) || !isProviderRole(role)) {
    return failed();
  }

  const form = await readStrictUrlEncodedFormBody(request, MAX_FORM_BODY_BYTES);
  if (!form) return failed();

  const returnTo = form.get("returnTo");
  if (!isProvidersReturnPath(returnTo)) return failed();
  const enabled = parseEnabled(form.get("enabled"));
  if (
    enabled === null ||
    form.get("provider") !== provider ||
    form.get("role") !== role ||
    form.size !== 4
  ) {
    return failed(returnTo);
  }

  const config = readControlApiConfig();
  if (!config) return failed(returnTo);

  const result = await patchProviderRole(provider, role, enabled, config);
  return result.kind === "ok" ? redirectTo(returnTo) : failed(returnTo);
}
