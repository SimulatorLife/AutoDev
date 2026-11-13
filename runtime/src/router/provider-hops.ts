/**
 * Provider hops: the provider serving an agent/role changed.
 *
 * The router picks a provider per request, so the provider an agent runs on is
 * not fixed for the life of a session. When it changes, the agent's work
 * moved: a turn that started on one provider and was served by another is two
 * different conversations, and a session that quietly stays on a different
 * provider than the one it started on is usually an operator's question rather
 * than the router's.
 *
 * A hop is therefore neither a retry nor a failure. The request that observed
 * it usually succeeded, on the new provider. What makes it worth measuring is
 * the change itself and the reason for it, which is one of:
 *
 * - `fallback` -- the provider the agent was on failed while serving this
 *   request, so the router served it with another one.
 * - `skipped` -- the provider the agent was on was not tried for this request:
 *   it was disabled, cooling down, or could not serve the role.
 * - `reselection` -- the provider changed and nothing the router observed
 *   explains it: the routing configuration changed, or the previous provider
 *   became available again.
 *
 * The tracker owns the agent's current provider, because "the provider changed"
 * is a claim about the agent's history and not about one request. The identity
 * is the agent (its live-activity subject) together with the role it runs
 * under: a session that hands work from its orchestrator to a subagent changes
 * role without changing agent, and that handover is not a hop.
 *
 * The tracker is bounded. It holds the current provider of the most recently
 * served agents, and forgets the oldest beyond that bound, so a long-lived
 * router cannot grow its state with the number of agents it has ever seen.
 */

/** Why the provider serving an agent/role changed. */
export type ProviderHopReason = "fallback" | "skipped" | "reselection";

/**
 * The failure classes a hop may carry.
 *
 * The vocabulary is closed on purpose: the failure class is published as a
 * telemetry attribute, and an attribute whose values are open-ended would make
 * every hop its own series. A class outside this set is reported as a hop
 * without its class rather than as a hop with a new value.
 */
export const PROVIDER_HOP_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "session_limit",
  "quota_exhausted",
  "throttled",
  "capacity",
  "timeout",
  "unavailable",
  "invalid_model",
  "authentication",
  "unsupported_request",
  "upstream_error",
  "request_error",
  "provider_disabled",
  "provider_cannot_delegate",
  "model_disabled",
  "agent_limit_per_session",
  "agent_limit_across_sessions",
  "cooldown",
  "probe_unavailable",
  "missing_credential"
]);

/**
 * What a request saw of a provider it passed over.
 *
 * `failed` means the provider was tried and could not serve the request;
 * `skipped` means it was never tried, because it was disabled, cooling down,
 * or unable to serve the role.
 */
export interface ProviderHopOutcome {
  readonly provider: string;
  readonly kind: "failed" | "skipped";
  readonly failureClass: string | null;
}

/** One observed change of the provider serving an agent/role. */
export interface ProviderHop {
  /** The provider the agent was on before the change. */
  readonly fromProvider: string;
  /** The provider serving the agent after the change. */
  readonly toProvider: string;
  readonly reason: ProviderHopReason;
  /** The bounded failure class that explains the change, when one does. */
  readonly failureClass: string | null;
  readonly role: string | null;
  readonly workspace: string | null;
  /** When the hop was observed. */
  readonly timestamp: string;
}

export interface ProviderHopTrackerOptions {
  /** How many agents the tracker remembers the current provider of. */
  readonly maxTrackedAgents?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_MAX_TRACKED_AGENTS = 4096;

export class ProviderHopTracker {
  private readonly current = new Map<string, string>();
  private readonly maxTrackedAgents: number;
  private readonly now: () => Date;

  constructor(options: ProviderHopTrackerOptions = {}) {
    const max = options.maxTrackedAgents ?? DEFAULT_MAX_TRACKED_AGENTS;
    this.maxTrackedAgents = Math.max(1, max);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Record that `provider` served the agent, and report the hop when the
   * agent's provider changed.
   *
   * `passedOver` is what this request saw of the providers it moved past, in
   * the order it moved past them. It is what turns a change into a reason: a
   * provider the agent was on that failed is a `fallback`, one that was not
   * tried is a `skipped`, and a change with neither is a `reselection`.
   */
  observeServed(input: {
    readonly subject: string | null | undefined;
    readonly role: string | null | undefined;
    readonly workspace: string | null | undefined;
    readonly provider: string;
    readonly passedOver?: readonly ProviderHopOutcome[] | undefined;
  }): ProviderHop | null {
    const provider = input.provider.trim();
    if (!provider) return null;
    const key = this.keyFor(input.subject, input.role);
    const current = key === null ? undefined : this.current.get(key);
    const hop = this.hopFor(
      current,
      provider,
      input.passedOver ?? [],
      input.role,
      input.workspace
    );
    if (key !== null) this.remember(key, provider);
    return hop;
  }

  /** Forget every agent's current provider. */
  reset(): void {
    this.current.clear();
  }

  private keyFor(
    subject: string | null | undefined,
    role: string | null | undefined
  ): string | null {
    const agent = typeof subject === "string" ? subject.trim() : "";
    if (!agent) return null;
    const agentRole = typeof role === "string" ? role.trim() : "";
    return `${agent}\u0000${agentRole}`;
  }

  private remember(key: string, provider: string): void {
    this.current.delete(key);
    this.current.set(key, provider);
    while (this.current.size > this.maxTrackedAgents) {
      const oldest = this.current.keys().next().value;
      if (oldest === undefined) break;
      this.current.delete(oldest);
    }
  }

  private hopFor(
    current: string | undefined,
    provider: string,
    passedOver: readonly ProviderHopOutcome[],
    role: string | null | undefined,
    workspace: string | null | undefined
  ): ProviderHop | null {
    if (current !== undefined && current !== provider) {
      const outcome =
        passedOver.find((entry) => entry.provider === current) ?? null;
      return this.hop(current, provider, outcome, role, workspace);
    }
    if (current === undefined) {
      // The agent has no provider yet, so there is no previous one to change
      // from. The provider the route intended is the one it passed over
      // first: that is the provider this agent would have run on.
      const intended = passedOver[0];
      if (intended && intended.provider !== provider) {
        return this.hop(intended.provider, provider, intended, role, workspace);
      }
    }
    return null;
  }

  private hop(
    fromProvider: string,
    toProvider: string,
    outcome: ProviderHopOutcome | null,
    role: string | null | undefined,
    workspace: string | null | undefined
  ): ProviderHop {
    return {
      fromProvider,
      toProvider,
      reason:
        outcome === null
          ? "reselection"
          : outcome.kind === "failed"
            ? "fallback"
            : "skipped",
      failureClass:
        outcome !== null &&
        outcome.failureClass !== null &&
        PROVIDER_HOP_FAILURE_CLASSES.has(outcome.failureClass)
          ? outcome.failureClass
          : null,
      role: typeof role === "string" && role.trim() ? role.trim() : null,
      workspace:
        typeof workspace === "string" && workspace.trim()
          ? workspace.trim()
          : null,
      timestamp: this.now().toISOString()
    };
  }
}

let defaultTracker: ProviderHopTracker | null = null;

export function getDefaultProviderHopTracker(): ProviderHopTracker {
  if (!defaultTracker) defaultTracker = new ProviderHopTracker();
  return defaultTracker;
}

export function setDefaultProviderHopTracker(
  tracker: ProviderHopTracker | null
): void {
  defaultTracker = tracker;
}

/**
 * Record that a provider served an agent/role, and report the hop if the
 * agent's provider changed.
 *
 * The hop is returned rather than published here: publishing it is the
 * telemetry module's job, because it owns the attribute names and the rules
 * about what may become a telemetry attribute.
 */
export function observeProviderServed(input: {
  readonly subject: string | null | undefined;
  readonly role: string | null | undefined;
  readonly workspace: string | null | undefined;
  readonly provider: string;
  readonly passedOver?: readonly ProviderHopOutcome[] | undefined;
}): ProviderHop | null {
  return getDefaultProviderHopTracker().observeServed(input);
}
