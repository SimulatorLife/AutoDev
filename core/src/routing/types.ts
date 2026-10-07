/**
 * The fixed provider roles an operator assigns a provider to.
 *
 * These are the canonical roles a provider can serve, and they are fixed: a
 * provider's participation in each is expressed by its priority, not by an
 * open-ended capability set. `default` and `smart` are the two routing roles the
 * Runtime has always resolved; `orchestrator` and `subagent` are the agent
 * execution roles.
 */
export const PROVIDER_ROLES = [
  "default",
  "smart",
  "orchestrator",
  "subagent"
] as const;

export type ProviderRole = (typeof PROVIDER_ROLES)[number];

/**
 * Priority a provider holds in a role. `Disabled` is a member of the enum
 * rather than a separate enablement flag, so a role's participation is one
 * value: there is no way to hold a priority and be disabled at the same time.
 */
export type ProviderRolePriority = 1 | 2 | 3 | "disabled";

export interface RouteDefinition {
  readonly provider: string;
  readonly pattern: string;
  readonly baseUrl: string;
}

/**
 * One provider's assignment for one role: the priority it competes at and the
 * model it serves that role with. A `disabled` priority keeps its `model` so
 * re-enabling restores the previous choice instead of forcing it to be re-picked.
 */
export interface ProviderRoleAssignment {
  readonly priority: ProviderRolePriority;
  readonly model: string | null;
}

/**
 * Provider-wide concurrent-agent limits. `null` means unlimited, which is a
 * configured choice rather than an absent value — the Console renders it as an
 * explicit `Unlimited` option rather than an empty field.
 */
export interface ProviderAgentLimits {
  /** Max concurrent agents for one session on this provider; `null` is unlimited. */
  readonly perSession: number | null;
  /** Max concurrent agents across all sessions on this provider; `null` is unlimited. */
  readonly acrossSessions: number | null;
}

/** Operator-controlled routing state persisted by the Runtime router. */
export interface RoutingPolicyState {
  /**
   * Per-provider, per-role priority and model assignment.
   *
   * A role is present only when an operator actually assigned it. This is not a
   * complete four-role record per provider, and the type used to claim it was:
   * `setProviderAssignment` writes one role at a time onto whatever exists for
   * that provider, so a provider configured for `subagent` alone carries one key.
   * The persisted state file is written from this same live map, so the shape
   * that reaches disk is the partial one too — declaring all four roles made
   * every reader index a key that need not exist, and nothing failed until a
   * consumer did.
   */
  readonly roleAssignments: Readonly<
    Record<
      string,
      Readonly<Partial<Record<ProviderRole, ProviderRoleAssignment>>>
    >
  >;
  /**
   * Providers disabled globally. This is independent of the per-role
   * assignments: disabling a provider suppresses it for every role while
   * preserving those assignments, so re-enabling restores the same
   * configuration.
   */
  readonly disabledProviders: readonly string[];
  readonly disabledModels: readonly string[];
  /** Per-provider concurrency limits; absent providers are unconstrained. */
  readonly providerLimits: Readonly<Record<string, ProviderAgentLimits>>;
}
