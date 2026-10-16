/**
 * Control API compatibility handshake shared by the Runtime and Console.
 *
 * Increment `version` when the Console begins requiring a new Control API
 * capability or path, or when an existing payload/authorization contract
 * changes incompatibly. The Console checks this endpoint before serving pages;
 * per-resource schemas remain the validation boundary for each response.
 */
export const CONTROL_API_CONTRACT = {
  path: "/control/contracts",
  schema: "autodev-control-api-contract-v1",
  version: 5
} as const;

export type ControlApiContractResponse = {
  readonly schema: typeof CONTROL_API_CONTRACT.schema;
  readonly version: typeof CONTROL_API_CONTRACT.version;
};
