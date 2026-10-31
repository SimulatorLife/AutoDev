import type { ControlRefusalReason } from "../control-failure.ts";
import type { ControlApiResult } from "./control-api.ts";

/**
 * The refusal each Runtime code earns, as a table rather than a chain of
 * branches so a code added on the Runtime side shows up as a case this table
 * does not cover.
 *
 * The Runtime states its reasons with machine-readable codes, and each asks for
 * a different next move, so a code the route drops on the floor leaves the
 * operator with a notice that says only "could not be confirmed". A code this
 * build does not know keeps the generic notice: the generic notice makes no
 * claim about the Runtime's reason, which is the only honest thing to say
 * about a reason this build has not read.
 */
const REFUSAL_BY_CODE: Readonly<Record<string, ControlRefusalReason>> = {
  // The Runtime rejected the request as invalid before doing any work: the body
  // the route assembled does not describe a change it can make.
  autodev_control_api_bad_body: "request_invalid",
  autodev_control_api_invalid_body: "request_invalid",
  autodev_control_api_unknown_provider: "not_found",
  autodev_control_api_viewer_forbidden: "forbidden",
  autodev_control_api_persistence_failed: "operation_failed"
};

export function providerMutationRefusalFor(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): ControlRefusalReason | undefined {
  if (result.kind === "unreachable") return "unavailable";
  if (result.kind === "unauthorized") return "forbidden";
  const code = "code" in result ? result.code : "";
  return REFUSAL_BY_CODE[code];
}
