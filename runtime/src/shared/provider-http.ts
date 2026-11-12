import type { ServerResponse } from "node:http";

import { SIGN_IN_REQUIRED_FAILURE_CLASS } from "@simulatorlife/autodev-core";

import { writeErrorLine } from "./output.ts";
import type { WorkspaceResolutionError } from "./resolve-workspace.ts";

/**
 * The HTTP surface every provider bridge shares.
 *
 * `claude`, `copilot` and `antigravity` each answered `/v1/responses` on the
 * same socket as the router, and each had grown its own copy of "write a JSON
 * body and close" alongside its own copy of the fail-closed response to a
 * workspace that could not be resolved. The three copies had already drifted
 * apart in type signatures, and the fail-closed contract that
 * `docs/provider-routing.md` specifies and `tests/workspace-resolution.test.ts`
 * relies on was asserted in prose while being re-implemented by hand in each
 * bridge. It is owned here instead, once.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The typed refusal a bridge answers when the request carries content the
 * bridge cannot carry.
 *
 * A CLI-backed bridge turns a turn into a text prompt for its CLI, so it
 * cannot show the model an image. Claude's transcript renderer substitutes
 * the literal text `[image]`; the other bridges drop the part or inline its
 * base64 payload as text. Every one of those answers a question the model was
 * never asked, and the caller reads it as an answer. A refusal names the
 * limit instead, and the router's fallback chain moves on to a route that can
 * serve the request.
 */
export const PROVIDER_REQUEST_UNSUPPORTED_TYPE =
  "provider_request_unsupported" as const;

/**
 * Fail closed on a request this bridge cannot serve.
 *
 * The refusal is typed so the router can tell "this route cannot serve this
 * request" apart from "this provider is broken": the first moves to the next
 * candidate, the second is a provider failure.
 */
export function sendUnsupportedRequestFailure(
  response: ServerResponse,
  provider: string,
  message: string
): void {
  writeErrorLine(`${provider} cannot serve this request: ${message}`);
  sendJson(response, 400, {
    error: { type: PROVIDER_REQUEST_UNSUPPORTED_TYPE, message }
  });
}

/**
 * Answer that the provider's account must be signed in again.
 *
 * A browser-driven bridge serves through the operator's signed-in browser, so
 * a signed-out site is neither a broken provider nor a request it cannot
 * serve: it is an action for the operator. The answer is typed
 * (`sign_in_required`) so the router records it as exactly that, and the
 * Console asks for the sign-in instead of reporting the provider Ready or
 * merely Unavailable.
 */
export function sendSignInRequired(
  response: ServerResponse,
  message: string
): void {
  sendJson(response, 401, signInRequiredBody(message));
}

/** The error body of a sign-in-required answer, for a stream's failure event too. */
export function signInRequiredBody(message: string): {
  readonly error: {
    readonly type: "authentication_error";
    readonly code: typeof SIGN_IN_REQUIRED_FAILURE_CLASS;
    readonly message: string;
  };
} {
  return {
    error: {
      type: "authentication_error",
      code: SIGN_IN_REQUIRED_FAILURE_CLASS,
      message
    }
  };
}

/**
 * The message of a provider body that reports its account must be signed in
 * again, or null for any other body.
 */
export function providerSignInRequiredMessage(body: unknown): string | null {
  if (
    typeof body !== "string" ||
    !body.includes(SIGN_IN_REQUIRED_FAILURE_CLASS)
  )
    return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const error = isRecord(parsed) ? parsed.error : null;
    if (!isRecord(error) || error.code !== SIGN_IN_REQUIRED_FAILURE_CLASS)
      return null;
    return typeof error.message === "string" && error.message
      ? error.message
      : "The provider's account must be signed in again.";
  } catch {
    return null;
  }
}

const CONTEXT_WINDOW_EXCEEDED_PATTERN =
  /context[_ ]?(?:window|length)\b[^\n]{0,60}\b(?:exceed|limit|too (?:large|long))|exceeds? (?:the )?(?:maximum )?context[_ ]?(?:window|length)|maximum context length|prompt is too long|input (?:is too long|exceeds the maximum)|context_length_exceeded|string_above_max_length|request_too_large/i;

/**
 * Whether an upstream body is a request-capability or context-window refusal
 * ("this route cannot serve this request") rather than a broken provider.
 *
 * The router reads this to move on to the next candidate (or wait out a
 * primary stateful bridge's transient cooldown) while leaving the refusing
 * provider healthy for smaller or compatible requests.
 */
export function providerRequestUnsupported(body: unknown): boolean {
  if (typeof body !== "string" || !body) return false;
  if (CONTEXT_WINDOW_EXCEEDED_PATTERN.test(body)) return true;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return false;
    if (isRecord(parsed.error)) {
      if (
        parsed.error.type === PROVIDER_REQUEST_UNSUPPORTED_TYPE ||
        parsed.error.code === "context_length_exceeded" ||
        parsed.error.code === 2013 ||
        parsed.error.code === "2013"
      ) {
        return true;
      }
      if (
        typeof parsed.error.message === "string" &&
        CONTEXT_WINDOW_EXCEEDED_PATTERN.test(parsed.error.message)
      ) {
        return true;
      }
    }
    if (
      isRecord(parsed.base_resp) &&
      (parsed.base_resp.status_code === 2013 ||
        parsed.base_resp.status_code === "2013")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Write one JSON body and close the response.
 *
 * The router has its own `sendJson` in `router/proxy.ts`, which additionally
 * stamps `x-autodev-router-instance-id`. A bridge answers on behalf of a
 * provider, not as the router, so it must not claim that identity; the two are
 * deliberately separate rather than one being a special case of the other.
 *
 * `body` is `unknown` and `extraHeaders` accepts numbers because callers
 * already relied on the widest of the copies they had, so widening here keeps
 * every existing call site compiling unchanged.
 */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string | number> = {}
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    connection: "close",
    ...extraHeaders
  });
  response.end(encoded);
}

/**
 * Fail closed on a request whose workspace could not be resolved.
 *
 * `resolveCwd` refuses to guess, and this is the only place that turns that
 * refusal into a response: log which bridge rejected the request, then answer
 * `400 invalid_request_error` carrying the resolver's own message. Any other
 * failure is not a workspace problem and must keep propagating, so callers
 * still re-throw everything that is not a `WorkspaceResolutionError` before
 * calling this.
 */
export function sendWorkspaceResolutionFailure(
  response: ServerResponse,
  provider: string,
  error: WorkspaceResolutionError
): void {
  writeErrorLine(`${provider} workspace resolution failed: ${error.message}`);
  sendJson(response, 400, {
    error: { type: "invalid_request_error", message: error.message }
  });
}
