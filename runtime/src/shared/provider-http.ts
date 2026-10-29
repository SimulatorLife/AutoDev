import type { ServerResponse } from "node:http";

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
 * Whether an upstream body is the typed refusal a bridge answered.
 *
 * The router reads this to tell "this route cannot serve this request" apart
 * from "this provider is broken": the first moves to the next candidate and
 * leaves the provider healthy, the second is a provider failure.
 */
export function providerRequestUnsupported(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !isRecord(parsed.error)) return false;
    return parsed.error.type === PROVIDER_REQUEST_UNSUPPORTED_TYPE;
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
