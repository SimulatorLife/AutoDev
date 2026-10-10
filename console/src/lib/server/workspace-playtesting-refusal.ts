import type { ControlRefusalReason } from "../control-failure.ts";
import type { ControlApiResult } from "./control-api.ts";

/**
 * The refusal an operator is told about, given what the Runtime's workspace
 * playtesting-approval route answered.
 *
 * Mapped onto the Console's shared refusal vocabulary rather than a new one:
 * `conflicted` already says "this changed since you read it; reload and
 * decide again", which is exactly the revision-conflict case the exact-build
 * approval boundary depends on, and `forbidden` already says "you are not
 * permitted to do this", which covers both a non-operator credential and a
 * disabled workspace refusing to accept a new approval -- the workspace is
 * not, right now, something this action is permitted against.
 */
export function workspacePlaytestingRefusalFor(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): ControlRefusalReason {
  if (result.kind === "unreachable") return "unavailable";
  const code = "code" in result ? result.code : "";
  switch (code) {
    case "autodev_workspace_playtesting_conflict": {
      return "conflicted";
    }
    case "autodev_workspace_playtesting_forbidden":
    case "autodev_workspace_playtesting_disabled": {
      return "forbidden";
    }
    case "autodev_workspace_not_found": {
      return "not_found";
    }
    case "autodev_workspace_playtesting_invalid_body":
    case "autodev_workspace_playtesting_invalid_approval":
    case "autodev_workspace_playtesting_invalid_revocation":
    case "autodev_workspace_playtesting_invalid_query": {
      return "request_invalid";
    }
    case "autodev_workspace_playtesting_store_unavailable":
    case "autodev_workspace_catalog_unavailable": {
      return "unavailable";
    }
    default: {
      return "runtime_refused";
    }
  }
}
