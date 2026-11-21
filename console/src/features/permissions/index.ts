/**
 * The Permissions feature's public surface.
 *
 * The feature is one page with one policy control, so it has one entrypoint:
 * the page renders `PermissionsView`, which owns the policy control, its
 * return target and its save-outcome notice, and the mutation route shares the
 * canonical path and save-outcome vocabulary through here rather than reaching
 * into the feature's modules.
 */

export {
  type PermissionPolicySaveOutcome,
  permissionPolicySaveOutcomeFromQuery
} from "./configuration.ts";
export { isPermissionsReturnPath, PERMISSIONS_PATH } from "./paths.ts";
export {
  PermissionsView,
  type PermissionsViewProps
} from "./PermissionsView.ts";
