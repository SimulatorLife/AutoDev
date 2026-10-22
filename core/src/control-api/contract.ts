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
 */
export const CONTROL_API_CONTRACT = {
  path: "/control/contracts",
  schema: "autodev-control-api-contract-v1",
  version: 14
} as const;

export type ControlApiContractResponse = {
  readonly schema: typeof CONTROL_API_CONTRACT.schema;
  readonly version: typeof CONTROL_API_CONTRACT.version;
};
