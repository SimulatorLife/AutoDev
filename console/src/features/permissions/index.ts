/**
The Permissions feature's public surface.

The feature is one read-only page over a repository-owned policy, so it has
one entrypoint: the page renders `PermissionsView`.
*/

export { PERMISSIONS_PATH } from "./paths.ts";
export {
  PermissionsView,
  type PermissionsViewProps
} from "./PermissionsView.ts";
