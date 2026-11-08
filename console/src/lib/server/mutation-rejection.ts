/**
 * Server-only record of a Console mutation that did not land.
 *
 * A mutation route answers every rejection with a redirect carrying the
 * bounded "could not be confirmed" notice, and the Runtime audits only the
 * requests that reach it. A change the Console turned away itself -- a
 * cross-origin submission, a form missing a field, no Control API
 * credential -- therefore left no trace anywhere: an operator set Claude's
 * orchestrator role to Disabled, the Runtime never saw the request, and the
 * next session was routed to Claude with nothing to say why.
 *
 * Every rejection is written to the Console's stderr (its launchd error log)
 * as one JSON line naming the route, the resource and the cause. The line
 * carries codes and statuses, never form values or messages from the
 * request, so nothing an attacker submits is echoed into the log.
 */

import type { ControlApiResult } from "./control-api.ts";

export const MUTATION_REJECTION_SCHEMA = "autodev-console-mutation-rejected-v1";

/** Why a mutation route did not forward a change, or what came back. */
export type MutationRejectionCause =
  /** Not a same-origin browser form submission. */
  | "cross_origin"
  /** The path names no valid provider, role, model or agent. */
  | "invalid_target"
  /** The body is not a bounded url-encoded form. */
  | "invalid_body"
  /** The return path is not one this route redirects to. */
  | "invalid_return_path"
  /** The form's fields are missing, extra, or out of range. */
  | "invalid_fields"
  /** The Console has no Control API base URL or service credential. */
  | "control_api_unconfigured"
  /** The Runtime answered with a refusal or failure. */
  | "runtime_rejected"
  /** The Runtime could not be reached. */
  | "runtime_unreachable";

export interface MutationRejection {
  /** The Console route, e.g. `/api/providers/[provider]/roles/[role]`. */
  readonly route: string;
  readonly cause: MutationRejectionCause;
  /** The resource the change was for, when the path named a valid one. */
  readonly resource?: string | undefined;
  readonly status?: number | undefined;
  /** The Runtime's error code, never its message. */
  readonly code?: string | undefined;
}

/** Bounded, so a log line cannot be inflated by what a request named. */
const MAX_FIELD_CHARS = 200;

function bounded(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, MAX_FIELD_CHARS);
}

export function logMutationRejection(rejection: MutationRejection): void {
  process.stderr.write(
    `${JSON.stringify({
      schema: MUTATION_REJECTION_SCHEMA,
      timestamp: new Date().toISOString(),
      route: rejection.route,
      cause: rejection.cause,
      resource: bounded(rejection.resource) ?? null,
      status: rejection.status ?? null,
      code: bounded(rejection.code) ?? null
    })}\n`
  );
}

/** The cause and evidence a failed Control API result gives. */
export function runtimeRejection(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): Pick<MutationRejection, "cause" | "status" | "code"> {
  if (result.kind === "unreachable") return { cause: "runtime_unreachable" };
  return {
    cause: "runtime_rejected",
    ...("status" in result ? { status: result.status } : {}),
    code: result.code
  };
}
