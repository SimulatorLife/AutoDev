/**
 * Control API compatibility handshake shared by the Runtime and Console.
 *
 * Increment `version` when the Console begins requiring a new Control API
 * capability or path, or when an existing payload/authorization contract
 * changes incompatibly. The Console checks this endpoint before serving pages;
 * per-resource schemas remain the validation boundary for each response.
 *
 * v7: the episode detail resource adds a strict `visualAssignment` field bound
 * to the exact frozen visual batch assignment manifest.
 * v8: run receipts and active-run reads expose frozen assignment-to-session
 * references so the Console can open an in-progress session without guessing.
 * v9: episode detail carries the persisted Core-owned player-debrief state and
 * evidence references under episode schema v8.
 * v10: the Providers page header exposes a confirmation-bound
 * \`POST /control/providers/reset\` operation that clears provider Runtime
 * overrides (role assignments, provider disables, model disables, and
 * provider agent limits) to their static-config defaults.
 * v11: the Providers response carries each provider's reconciliation view --
 * the desired generation of the provider's routing configuration, the
 * generation the runtime has observed, and the bounded operation history --
 * so the provider page can show convergence instead of leaving the operator to
 * assume that a saved configuration is a served one.
 * v12: the Runtime's MCP observations are published on their own read path
 * (`GET /control/mcp-runtime`) rather than folded into the MCP catalog. The
 * catalog stays a configuration read, and the MCP page composes the
 * observation onto the declaration rather than blurring the two.
 * v13: the MCP configuration the Runtime published is published on its own
 * read path (`GET /control/mcp-applied`) and reconciled against the canonical
 * declaration through the shared reconciliation contract, so the MCP page can
 * say whether what the operator declared is what the Runtime applied.
 * v14: the canonical MCP declaration carries a revision the Console compares
 * against before it writes, the applied read publishes the declared launch
 * configuration the comparison is made against, and the canonical declaration
 * is written through `PATCH /control/mcps/{name}`, which applies the projection
 * and reports the reconciliation.
 * v15: the canonical hook declaration publishes the effective declaration of
 * the target the Runtime applies -- the shared declaration merged with the
 * target's own, one event at a time -- with the revision a write compares
 * against and the origin of each event, and the canonical declaration is
 * written through `PATCH /control/hooks/{event}`, which applies the hook
 * projection and reports the reconciliation.
 * v16: the canonical workspace catalog publishes the revision a write is
 * compared against, and one workspace's canonical configuration is written
 * through `PATCH /control/workspaces/{owner}/{repository}`, which replaces that
 * entry's enablement, base branch and role scope under the same
 * compare-and-swap the other canonical sources use.
 * v17: the permission policy is published from the canonical source that
 * states it, with the revision a write is compared against, each role's real
 * sandbox mode, and the applied policy read from the composed configuration;
 * the policy is written through `PATCH /control/permissions`, which replaces
 * one setting under the same compare-and-swap the other canonical sources use
 * and reports the reconciliation against the applied configuration.
 * v18: the canonical workspace catalog publishes the shared desired-vs-actual
 * view like every other canonical source, and one workspace's configuration
 * write reports it together with the fields it changed -- so the Workspaces
 * surface says converged, pending or not observed instead of leaving the
 * operator to infer convergence from a write that reported success.
 * v19: the skills and prompts collections declare the canonical write paths
 * they have -- role assignment and source editing for skills, the command's
 * own source for prompts -- so the Console refuses a response that claims
 * those collections are read-only. Both collections published `readOnly: true`
 * from before their write paths existed.
 * v20: the GitHub page's recent runs are null when the Actions read did not
 * happen, beside the `stats` that already said so. An empty list there claimed
 * the workflows had never run, which is a claim about the repository rather
 * than about the read.
 * v21: the skills page's unresolved assignments are null when the catalogue was
 * not read, because the join between the contract's assignments and the
 * catalogue's names was not performed. An empty list there claimed every
 * assignment resolves.
 * v22: the tool catalogue publishes whether the execution contract was read.
 * The contract's accessor falls back to an empty contract when the read fails,
 * so an empty contract and a contract nobody read looked the same to every
 * caller -- and the catalogue's counts and the role exposure of every entry
 * depend on which one it was.
 */
export const CONTROL_API_CONTRACT = {
  path: "/control/contracts",
  schema: "autodev-control-api-contract-v1",
  version: 22
} as const;

export type ControlApiContractResponse = {
  readonly schema: typeof CONTROL_API_CONTRACT.schema;
  readonly version: typeof CONTROL_API_CONTRACT.version;
};
