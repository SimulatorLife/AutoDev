/**
 * Server-only Console provider-role mutation route.
 *
 * Receives the bounded form submission from the canonical Agents surface,
 * validates its same-origin browser context, and forwards a typed PATCH to
 * Runtime using the server-side Control API credential. The browser never
 * receives that credential and never bypasses Runtime.
 *
 * Only POST is exported. Any missing/invalid evidence or failed request
 * returns a 303 failure notice. A successful request returns to the Agents
 * page without a query-derived success claim; the refreshed role value is
 * authoritative.
 */

import { PROVIDER_ROLES, type ProviderRole } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  patchProviderRole,
  readControlApiConfig
} from "../../../../../../src/lib/server/control-api.ts";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTENT_LENGTH_PATTERN = /^\d+$/u;
const MAX_FORM_BODY_BYTES = 4096;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isProviderRole(value: string): value is ProviderRole {
  return PROVIDER_ROLES.includes(value as ProviderRole);
}

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    return (
      parsedOrigin.origin === origin &&
      parsedOrigin.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isSameOriginFetch(request: NextRequest): boolean {
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function redirectWithFailure(): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location: "/agents?providerRole=failed" }
  });
}

function redirectToAgents(): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location: "/agents" }
  });
}

async function readStrictFormBody(
  request: NextRequest
): Promise<URLSearchParams | null> {
  const contentType = (request.headers.get("content-type") ?? "")
    .trim()
    .toLowerCase();
  if (
    contentType !== FORM_CONTENT_TYPE &&
    contentType !== FORM_CONTENT_TYPE + "; charset=utf-8" &&
    contentType !== FORM_CONTENT_TYPE + ";charset=utf-8"
  ) {
    return null;
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!CONTENT_LENGTH_PATTERN.test(contentLength)) return null;
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > MAX_FORM_BODY_BYTES
    ) {
      return null;
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      // Read sequentially so the streamed byte cap also bounds memory.
      // eslint-disable-next-line no-await-in-loop -- Sequential reads enforce the streaming byte cap.
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_FORM_BODY_BYTES) {
        // Stop consuming the body as soon as the byte cap is exceeded.
        // eslint-disable-next-line no-await-in-loop -- Cancel the same stream before releasing its reader.
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) return null;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    return null;
  }
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
  if (!isSameOriginRequest(request) || !isSameOriginFetch(request)) {
    return redirectWithFailure();
  }

  const { provider, role } = await context.params;
  if (!PROVIDER_ID_PATTERN.test(provider) || !isProviderRole(role)) {
    return redirectWithFailure();
  }

  const form = await readStrictFormBody(request);
  if (!form) return redirectWithFailure();

  const enabled = parseEnabled(form.get("enabled"));
  if (
    enabled === null ||
    form.get("provider") !== provider ||
    form.get("role") !== role ||
    form.size !== 3
  ) {
    return redirectWithFailure();
  }

  const config = readControlApiConfig();
  if (!config) return redirectWithFailure();

  const result = await patchProviderRole(provider, role, enabled, config);
  return result.kind === "ok" ? redirectToAgents() : redirectWithFailure();
}
