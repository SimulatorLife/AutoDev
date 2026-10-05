export const PROVIDER_ROLES = ["orchestrator", "subagent"] as const;

export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export interface RouteDefinition {
  readonly provider: string;
  readonly pattern: string;
  readonly baseUrl: string;
}

/** Operator-controlled routing enablement persisted by the Runtime router. */
export interface RoutingPolicyState {
  readonly disabledOrchestratorProviders: readonly string[];
  readonly disabledSubagentProviders: readonly string[];
  readonly disabledModels: readonly string[];
}
