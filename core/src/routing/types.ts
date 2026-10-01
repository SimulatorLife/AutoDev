export type ProviderRole = "orchestrator" | "subagent";

export interface RouteDefinition {
  readonly provider: string;
  readonly pattern: string;
  readonly baseUrl: string;
}

export interface RoutingPolicyState {
  readonly disabledOrchestratorProviders: readonly string[];
  readonly disabledSubagentProviders: readonly string[];
}
