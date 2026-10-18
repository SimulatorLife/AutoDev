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
 */
export const CONTROL_API_CONTRACT = {
  path: "/control/contracts",
  schema: "autodev-control-api-contract-v1",
  version: 9
} as const;

export type ControlApiContractResponse = {
  readonly schema: typeof CONTROL_API_CONTRACT.schema;
  readonly version: typeof CONTROL_API_CONTRACT.version;
};
