/**
 * The Control API's public surface.
 *
 * The dispatcher owns the routing; the resource families own their own
 * handlers. This module is the package's entry point, so a consumer reads one
 * import path for the whole Control API instead of the dispatcher file's
 * internal arrangement.
 */

export * from "./diagnostics.ts";
export {
  clearGithubSnapshotCacheForTests,
  githubWorkflowsView,
  setGithubActionsAdapterForTests
} from "./github.ts";
export * from "./request-handler.ts";
