import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ANTIGRAVITY_PROVIDERS,
  type ControlApiDiscoveredProviderModel,
  PROVIDER_ROLES,
  type ProviderAgentLimits,
  type ProviderRole,
  type ProviderRoleAssignment,
  type RoutingPolicyState
} from "@simulatorlife/autodev-core";
import {
  providerInjectsRoleMcp,
  roleScopedMcp
} from "@simulatorlife/autodev-runtime/shared/execution-contract";
import {
  ANTIGRAVITY_PROVIDER_PATTERNS,
  CLAUDE_MODEL_PATTERN,
  CODEX_MODEL_PATTERN,
  MINIMAX_MODEL_PATTERN,
  OPENCLI_CHATGPT_MODEL_PATTERN,
  OPENCLI_GEMINI_MODEL_PATTERN
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { providerCapabilities } from "./subagents.ts";

export const ROLE_NAMES = [
  "default",
  "docs-researcher",
  "browser-tester",
  "explorer",
  "worker",
  "validator",
  "smart",
  "playtester",
  "playtest-analyst"
] as const;

export interface RawRouteConfig {
  pattern: string;
  baseUrl: string;
  healthUrl?: string;
  envKey?: string | null;
  /** Maximum simultaneous requests for this provider; absent means unlimited. */
  maxConcurrentRequests?: number;
}

export interface ProviderRoute {
  provider: string;
  pattern: RegExp;
  baseUrl: string;
  healthUrl?: string;
  envKey?: string | null;
  /** Maximum simultaneous requests for this provider; absent means unlimited. */
  maxConcurrentRequests?: number;
}

/** External operator links for one provider; each is an absolute https URL. */
export interface ProviderLinksConfig {
  usage?: string;
  documentation?: string;
}

export interface ProviderModelsConfig {
  models: Record<string, string>;
  links?: ProviderLinksConfig;
  [key: string]: unknown;
}

export interface RoutingRoleConfig {
  tier: string;
  [key: string]: unknown;
}

export interface OrchestratorConfig {
  alias: string;
  tier: string;
  reasoningEffort?: Record<string, string>;
  [key: string]: unknown;
}

export interface RoutingConfig {
  providerGroups: Record<string, string[][]>;
  routes?: Record<string, RawRouteConfig>;
  providers: Record<string, ProviderModelsConfig>;
  roles: Record<string, RoutingRoleConfig>;
  orchestrator: OrchestratorConfig;
  [key: string]: unknown;
}

export interface CatalogModel {
  slug: string;
}

export interface Candidate extends ProviderRoute {
  model: string;
  reasoningEffort?: string | null;
}

export interface OrchestratorCandidate extends Candidate {
  reasoningEffort: string | null;
}

export interface RoutingRuntime {
  providerFailureStreak?: (provider: string) => number;
  liveProviderCount?: (provider: string) => number;
}

/**
 * A limit is either a positive integer or `null` for unlimited. Anything else —
 * a negative number, a float, a string — normalises to `null` rather than being
 * stored, so an unrecognised persisted value cannot become an active limit.
 */
function normaliseLimit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * Why a provider/model route may not serve a role right now.
 *
 * `provider_cannot_delegate` is a capability, not a switch: the provider is
 * enabled and ranked for the role, and no operator action can make it serve
 * that tier, because the orchestrator's whole job is delegating.
 */
export type RouteDisabledReason =
  "provider_disabled" | "model_disabled" | "provider_cannot_delegate";

export interface ConfiguredModel {
  model: string;
  provider: string;
  tiers: string[];
}

export interface DiscoveredProviderModel extends ControlApiDiscoveredProviderModel {
  readonly provider: string;
}

const ORCHESTRATOR_ALIAS_PATTERN = /^autodev\/[a-z0-9-]+$/u;
const AUTODEV_ROLE_PATTERN = /^autodev\/([a-z0-9-]+)$/iu;
const ROUTING_MODEL_COLLATOR = new Intl.Collator();
const PERSISTED_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

const DEFAULT_ROUTES: readonly ProviderRoute[] = [
  {
    provider: "claude",
    // Anthropic model ids are lowercase, hyphen-separated: never `claude-opus-5.5`.
    // The shared pattern also excludes agy's effort-suffixed Claude ids, which
    // belong to Antigravity -- see provider-model-ids.ts for why the id alone
    // has to name its provider regardless of route order.
    pattern: CLAUDE_MODEL_PATTERN,
    baseUrl: "http://127.0.0.1:4000/v1",
    healthUrl: "http://127.0.0.1:4000/health/liveliness",
    envKey: "LITELLM_API_KEY"
  },
  {
    provider: "minimax",
    pattern: MINIMAX_MODEL_PATTERN,
    baseUrl: "http://127.0.0.1:18765/v1",
    healthUrl: "http://127.0.0.1:18765/health",
    envKey: "MINIMAX_API_KEY"
  },
  // One provider per Antigravity quota (Gemini, Argon, Claude/GPT-OSS), all
  // served by the one agy bridge.
  ...ANTIGRAVITY_PROVIDERS.map((provider) => ({
    provider,
    pattern: ANTIGRAVITY_PROVIDER_PATTERNS[provider],
    baseUrl: "http://127.0.0.1:4002/v1",
    healthUrl: "http://127.0.0.1:4002/health/liveliness",
    envKey: "LITELLM_API_KEY"
  })),
  {
    provider: "codex",
    pattern: CODEX_MODEL_PATTERN,
    baseUrl:
      process.env.CODEX_ROUTER_GPT_BASE_URL ??
      "https://chatgpt.com/backend-api/codex",
    envKey: null
  },
  {
    provider: "copilot",
    pattern: /^copilot$/,
    baseUrl: "http://127.0.0.1:4003/v1",
    healthUrl: "http://127.0.0.1:4003/health/liveliness",
    envKey: "CODEX_ROUTER_COPILOT_API_KEY"
  },
  {
    // Web chat sites driven through the user's signed-in browser; both are
    // served by the one opencli bridge, which runs each site's turns in as
    // many browser tabs as its route takes concurrent requests. ChatGPT
    // answers in background tabs; Gemini's model picker does not render in
    // one, so it keeps a single tab.
    provider: "opencli-chatgpt",
    pattern: OPENCLI_CHATGPT_MODEL_PATTERN,
    baseUrl: "http://127.0.0.1:4004/v1",
    healthUrl:
      "http://127.0.0.1:4004/health/liveliness?provider=opencli-chatgpt",
    envKey: "CODEX_ROUTER_OPENCLI_API_KEY",
    maxConcurrentRequests: 3
  },
  {
    provider: "opencli-gemini",
    pattern: OPENCLI_GEMINI_MODEL_PATTERN,
    baseUrl: "http://127.0.0.1:4004/v1",
    healthUrl:
      "http://127.0.0.1:4004/health/liveliness?provider=opencli-gemini",
    envKey: "CODEX_ROUTER_OPENCLI_API_KEY",
    maxConcurrentRequests: 1
  }
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read one persisted role assignment, or `null` when the stored value is not
 * one. Rejecting a malformed entry rather than coercing it keeps an unreadable
 * persisted value from becoming an active routing decision.
 */
function readRoleAssignment(value: unknown): ProviderRoleAssignment | null {
  if (!isRecord(value)) return null;
  const { priority } = value;
  if (
    priority !== 1 &&
    priority !== 2 &&
    priority !== 3 &&
    priority !== "disabled"
  )
    return null;
  const reasoningEffort = nonEmptyString(value.reasoningEffort)
    ? value.reasoningEffort.trim()
    : null;
  return {
    priority,
    model: nonEmptyString(value.model) ? value.model.trim() : null,
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

interface ProviderModelsEntry {
  models: Record<string, unknown>;
  [key: string]: unknown;
}

function isProviderModelsEntry(value: unknown): value is ProviderModelsEntry {
  return isRecord(value) && isRecord(value.models);
}

function rawConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Routing config must be an object.");
  return value;
}

function validateTierGroups(
  providerGroups: Record<string, unknown>,
  providers: Record<string, unknown>,
  tier: string
): void {
  const groups = providerGroups[tier];
  if (!Array.isArray(groups) || groups.length === 0)
    throw new Error(`Routing config tier ${tier} must define provider groups.`);
  for (const group of groups) {
    if (
      !Array.isArray(group) ||
      group.length === 0 ||
      !group.every(nonEmptyString)
    ) {
      throw new Error(
        `Routing config tier ${tier} contains an invalid provider group.`
      );
    }
    for (const provider of group) {
      if (!Object.hasOwn(providers, provider))
        throw new Error(
          `Routing config tier ${tier} references unknown provider ${provider}.`
        );
    }
  }
}

function validateRoutesBlock(
  routes: unknown,
  providers: Record<string, unknown>
): void {
  if (routes === undefined) return;
  if (!isRecord(routes))
    throw new Error("Routing config routes must be an object.");
  for (const provider of Object.keys(providers)) {
    const route = routes[provider];
    if (
      !isRecord(route) ||
      !nonEmptyString(route.pattern) ||
      !nonEmptyString(route.baseUrl)
    ) {
      throw new Error(
        `Routing config provider ${provider} must define a route with pattern and baseUrl.`
      );
    }
    if (route.healthUrl !== undefined && typeof route.healthUrl !== "string")
      throw new Error(
        `Routing config provider ${provider} route healthUrl must be a string.`
      );
    if (
      route.envKey !== undefined &&
      route.envKey !== null &&
      typeof route.envKey !== "string"
    )
      throw new Error(
        `Routing config provider ${provider} route envKey must be a string or null.`
      );
    if (
      route.maxConcurrentRequests !== undefined &&
      (typeof route.maxConcurrentRequests !== "number" ||
        !Number.isSafeInteger(route.maxConcurrentRequests) ||
        route.maxConcurrentRequests < 1)
    )
      throw new Error(
        `Routing config provider ${provider} route maxConcurrentRequests must be a positive integer.`
      );
  }
}

/**
 * Every configured model must route to the provider it is listed under. A
 * mistyped id otherwise loads fine and only fails at the provider, turn by
 * turn, looking like an outage.
 */
function validateProviderModelRoutes(
  routesInput: unknown,
  providers: Record<string, ProviderModelsEntry>
): void {
  const routes: [string, RegExp][] = isRecord(routesInput)
    ? Object.entries(routesInput).map(([provider, route]) => [
        provider,
        new RegExp(String((route as Record<string, unknown>).pattern))
      ])
    : DEFAULT_ROUTES.map((route) => [route.provider, route.pattern]);
  for (const [provider, { models }] of Object.entries(providers)) {
    // A provider without any route is never selected; route checks own that.
    if (!routes.some(([routeProvider]) => routeProvider === provider)) continue;
    for (const [tier, model] of Object.entries(models)) {
      if (!nonEmptyString(model))
        throw new Error(
          `Routing config provider ${provider} ${tier} model must be a non-empty string.`
        );
      const owner = routes.find(([, pattern]) =>
        pattern.test(model.trim())
      )?.[0];
      if (owner !== provider)
        throw new Error(
          `Routing config provider ${provider} ${tier} model "${model}" ${owner ? `routes to ${owner}` : "matches no provider route"}; use a ${provider} model id.`
        );
    }
  }
}

const PROVIDER_LINK_KINDS = ["usage", "documentation"] as const;

function isHttpsUrl(value: unknown): boolean {
  if (!nonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateProviderLinks(provider: string, links: unknown): void {
  if (links === undefined) return;
  if (!isRecord(links))
    throw new Error(
      `Routing config provider ${provider} links must be an object.`
    );
  for (const key of Object.keys(links)) {
    if (!(PROVIDER_LINK_KINDS as readonly string[]).includes(key))
      throw new Error(
        `Routing config provider ${provider} has unknown link ${key}.`
      );
    if (!isHttpsUrl(links[key]))
      throw new Error(
        `Routing config provider ${provider} link ${key} must be an https URL.`
      );
  }
}

function validateProvidersBlock(
  providers: Record<string, unknown>
): Record<string, ProviderModelsEntry> {
  const validated: Record<string, ProviderModelsEntry> = {};
  for (const [provider, info] of Object.entries(providers)) {
    if (!isProviderModelsEntry(info))
      throw new Error(
        `Routing config provider ${provider} must define a models object.`
      );
    if (!nonEmptyString(info.models.default))
      throw new Error(
        `Routing config provider ${provider} must define a default model.`
      );
    validateProviderLinks(provider, info.links);
    validated[provider] = info;
  }
  return validated;
}

function validateRolesBlock(
  providerGroups: Record<string, unknown>,
  providers: Record<string, unknown>,
  roles: Record<string, unknown>
): void {
  for (const role of ROLE_NAMES) {
    const roleConfig = roles[role];
    if (!isRecord(roleConfig) || !nonEmptyString(roleConfig.tier))
      throw new Error(`Routing config role ${role} must define a tier.`);
    validateTierGroups(providerGroups, providers, roleConfig.tier);
  }
}

function validateOrchestratorBlock(
  providerGroups: Record<string, unknown>,
  providers: Record<string, unknown>,
  orchestrator: Record<string, unknown>
): void {
  if (
    !nonEmptyString(orchestrator.alias) ||
    !ORCHESTRATOR_ALIAS_PATTERN.test(orchestrator.alias.trim())
  ) {
    throw new Error(
      "Routing config orchestrator.alias must be an autodev/<name> alias."
    );
  }
  if (!nonEmptyString(orchestrator.tier))
    throw new Error("Routing config orchestrator must define a tier.");
  validateTierGroups(providerGroups, providers, orchestrator.tier);
  if (orchestrator.reasoningEffort === undefined) return;
  if (!isRecord(orchestrator.reasoningEffort))
    throw new Error(
      "Routing config orchestrator.reasoningEffort must be an object mapping providers to effort strings."
    );
  for (const [provider, effort] of Object.entries(
    orchestrator.reasoningEffort
  )) {
    if (!Object.hasOwn(providers, provider))
      throw new Error(
        `Routing config orchestrator.reasoningEffort references unknown provider ${provider}.`
      );
    if (!nonEmptyString(effort))
      throw new Error(
        `Routing config orchestrator.reasoningEffort.${provider} must be a non-empty string.`
      );
  }
}

export function validateRoutingConfig(value: unknown): RoutingConfig {
  const config = rawConfig(value);
  if (!isRecord(config.providerGroups))
    throw new Error("Routing config requires providerGroups.");
  if (!isRecord(config.providers))
    throw new Error("Routing config requires providers.");
  validateRoutesBlock(config.routes, config.providers);
  if (!isRecord(config.roles))
    throw new Error("Routing config requires roles.");
  if (!isRecord(config.orchestrator))
    throw new Error("Routing config requires an orchestrator block.");
  const providers = validateProvidersBlock(config.providers);
  validateProviderModelRoutes(config.routes, providers);
  validateRolesBlock(config.providerGroups, config.providers, config.roles);
  validateOrchestratorBlock(
    config.providerGroups,
    config.providers,
    config.orchestrator
  );
  const orchestratorAlias =
    typeof config.orchestrator.alias === "string"
      ? config.orchestrator.alias.trim()
      : "";
  const orchestratorRole = orchestratorAlias
    .match(AUTODEV_ROLE_PATTERN)?.[1]
    ?.toLowerCase();
  if (orchestratorRole && Object.hasOwn(config.roles, orchestratorRole))
    throw new Error(
      `Routing config orchestrator.alias conflicts with the configured role alias autodev/${orchestratorRole}.`
    );
  return config as unknown as RoutingConfig;
}

function resolveConfigPath(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.CODEX_ROUTER_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  const repositoryRoot = resolveRuntimeSourceRoot(
    import.meta.dirname,
    environment.AUTODEV_REPO_ROOT
  );
  const repositorySource = path.join(
    repositoryRoot,
    "config",
    "model-routing.json"
  );
  if (existsSync(repositorySource)) return repositorySource;
  const installedSource = `${environment.CODEX_HOME ?? `${environment.HOME ?? process.cwd()}/.codex`}/codex-model-routing.json`;
  if (existsSync(installedSource)) return installedSource;
  return repositorySource;
}

export function loadRoutingConfig(
  environment: NodeJS.ProcessEnv = process.env
): { file: string; config: RoutingConfig } {
  const file = resolveConfigPath(environment);
  return {
    file,
    config: validateRoutingConfig(
      JSON.parse(readFileSync(file, "utf8")) as unknown
    )
  };
}

function buildRoutes(
  config: RoutingConfig,
  environment: NodeJS.ProcessEnv
): ProviderRoute[] {
  if (!config.routes) return DEFAULT_ROUTES.map((route) => ({ ...route }));
  return Object.entries(config.routes).map(([provider, route]) => ({
    provider,
    pattern: new RegExp(route.pattern),
    baseUrl:
      provider === "codex" && environment.CODEX_ROUTER_GPT_BASE_URL
        ? environment.CODEX_ROUTER_GPT_BASE_URL
        : route.baseUrl,
    ...(route.healthUrl === undefined ? {} : { healthUrl: route.healthUrl }),
    ...(route.envKey === undefined ? {} : { envKey: route.envKey }),
    ...(route.maxConcurrentRequests === undefined
      ? {}
      : { maxConcurrentRequests: route.maxConcurrentRequests })
  }));
}

function defaultRoleAliases(config: RoutingConfig): string[] {
  return [
    ...ROLE_NAMES.map((role) => `autodev/${role}`),
    config.orchestrator.alias.trim()
  ];
}

/**
 * Bounded counts of provider Runtime overrides cleared by
 * `RoutingPolicy.resetProviderOverrides`, reported to the Control API audit
 * trail in place of replaying the (potentially large) cleared state.
 */
export interface ProviderOverrideResetCounts {
  readonly roleAssignments: number;
  readonly disabledProviders: number;
  readonly disabledModels: number;
  readonly providerLimits: number;
  readonly agentModels: number;
}

export class RoutingPolicy {
  readonly config: RoutingConfig;
  readonly routes: readonly ProviderRoute[];
  readonly configFile: string;
  private runtime: RoutingRuntime;
  /**
   * Per-provider, per-role priority and model. A provider absent from this map
   * has never been configured for a role, which is a different answer from
   * having been configured as `disabled` — the first is unobserved, the second
   * is a decision the operator made.
   */
  private readonly roleAssignments = new Map<
    string,
    Partial<Record<ProviderRole, ProviderRoleAssignment>>
  >();
  private readonly disabledProviders = new Set<string>();
  private readonly disabledModels = new Set<string>();
  private readonly discoveredProviderModels = new Map<
    string,
    Map<string, DiscoveredProviderModel>
  >();
  private readonly disabledAgentRoles = new Set<string>();
  private readonly agentEnablementRevisions = new Map<string, number>();
  private readonly providerLimits = new Map<string, ProviderAgentLimits>();
  /**
   * Per-provider, per-agent-role model preference. Agent roles that share a
   * tier share its model; an entry here lets one of them (an explorer, say)
   * run a different model of the same provider than its siblings.
   */
  private readonly agentModels = new Map<string, Record<string, string>>();

  constructor(
    config: RoutingConfig,
    configFile: string,
    environment: NodeJS.ProcessEnv = process.env,
    runtime: RoutingRuntime = {}
  ) {
    this.config = config;
    this.routes = buildRoutes(config, environment);
    this.configFile = configFile;
    this.runtime = runtime;
  }

  setRuntime(runtime: RoutingRuntime): void {
    this.runtime = runtime;
  }

  private providerKey(provider: string): string {
    return provider.toLowerCase().trim();
  }

  isProviderEnabled(provider: unknown): boolean {
    if (typeof provider !== "string" || provider.trim().length === 0)
      return false;
    return !this.disabledProviders.has(this.providerKey(provider));
  }

  /**
   * A provider serves a role when it is not globally disabled and its
   * assignment for that role is not `disabled`. An unobserved assignment counts
   * as enabled: a provider that was never configured away must keep routing,
   * which is the same default the previous per-role disable lists had.
   */
  isProviderEnabledForRole(provider: unknown, role: ProviderRole): boolean {
    if (!this.isProviderEnabled(provider)) return false;
    const assignment = this.assignmentFor(provider, role);
    return assignment?.priority !== "disabled";
  }

  /**
   * The capability a provider needs to serve a role at all.
   *
   * The orchestrator's job is delegating, so a provider that cannot create
   * Codex children cannot serve the orchestrator tier however it is enabled and
   * ranked. This is deliberately a separate fact from enablement: the Console
   * and the router status used to report a provider as enabled for the
   * orchestrator while the router refused to route to it, so an operator
   * disabled every other provider on the strength of that report and was then
   * told no provider was enabled -- when the one that was enabled could never
   * have served the role. Enablement answers "did the operator switch this
   * on?"; this answers "can it serve at all?".
   */
  providerRoleCapabilityReason(
    provider: unknown,
    role: ProviderRole
  ): "provider_cannot_delegate" | null {
    if (role !== "orchestrator") return null;
    if (typeof provider !== "string" || provider.trim().length === 0)
      return "provider_cannot_delegate";
    // The same contract reading the router status reports, so the two cannot
    // disagree, and one that honours CODEX_EXECUTION_CONTRACT_FILE and reloads.
    return providerCapabilities(provider).subagentSpawn
      ? null
      : "provider_cannot_delegate";
  }

  /**
   * Whether a provider can serve a role right now: enabled for it, and able to.
   *
   * The router's own filter and every surface that reports a provider's role
   * participation read this one predicate, so "the Console shows it as
   * enabled" and "the router will route to it" cannot drift apart.
   */
  canProviderServeRole(provider: unknown, role: ProviderRole): boolean {
    return (
      this.isProviderEnabledForRole(provider, role) &&
      this.providerRoleCapabilityReason(provider, role) === null
    );
  }

  /**
   * Why a provider cannot serve a role, as one sentence, or null when it can.
   *
   * One source for the wording: the Console's refusal and the router's
   * rejection both name the same cause, so an operator who reads one of them
   * is not sent to a different explanation by the other.
   */
  providerRoleCapabilityExplanation(
    provider: unknown,
    role: ProviderRole
  ): string | null {
    if (this.providerRoleCapabilityReason(provider, role) === null) return null;
    const name =
      typeof provider === "string" && provider.trim().length > 0
        ? provider.trim()
        : "This provider";
    return `${name} cannot serve the ${role} role: it has no delegation path, so it cannot create the child agents an orchestrator needs.`;
  }

  /** The provider's assignment for a role, or `undefined` when unobserved. */
  assignmentFor(
    provider: unknown,
    role: ProviderRole
  ): ProviderRoleAssignment | undefined {
    const assignments =
      typeof provider === "string" && provider.trim().length > 0
        ? this.roleAssignments.get(this.providerKey(provider))
        : undefined;
    return assignments?.[role];
  }

  setProviderAssignment(
    provider: unknown,
    role: ProviderRole,
    assignment: ProviderRoleAssignment
  ): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    const key = this.providerKey(provider);
    if (!Object.hasOwn(this.config.providers, key)) return;
    const existing = this.roleAssignments.get(key) ?? {};
    // The model is preserved when a role is disabled so re-enabling restores
    // the previous choice rather than forcing the operator to re-pick it.
    existing[role] = {
      priority: assignment.priority,
      model: assignment.model,
      ...(assignment.reasoningEffort
        ? { reasoningEffort: assignment.reasoningEffort }
        : {})
    };
    this.roleAssignments.set(key, existing);
  }

  /**
   * Forget a provider's assignment for one role, returning it to the
   * unobserved default. This is the counterpart a rollback needs: restoring
   * "no assignment" is not the same as writing back the assignment the change
   * was replacing, because leaving the rejected assignment in place would let a
   * change that never persisted keep affecting routing.
   */
  clearProviderAssignment(provider: unknown, role: ProviderRole): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    const key = this.providerKey(provider);
    const assignments = this.roleAssignments.get(key);
    if (!assignments || !Object.hasOwn(assignments, role)) return;
    const next = { ...assignments };
    delete next[role];
    if (Object.keys(next).length === 0) this.roleAssignments.delete(key);
    else this.roleAssignments.set(key, next);
  }

  isProviderDisabled(provider: unknown): boolean {
    return !this.isProviderEnabled(provider);
  }

  setProviderEnabled(provider: unknown, enabled: boolean): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    const key = this.providerKey(provider);
    if (!Object.hasOwn(this.config.providers, key)) return;
    if (enabled) this.disabledProviders.delete(key);
    else this.disabledProviders.add(key);
  }

  resetDisabledProviders(): void {
    this.disabledProviders.clear();
  }

  /**
   * Clear one role's assignments across every provider, returning those
   * providers to the unobserved default. This is the counterpart of
   * `resetDisabledProviders`/`resetDisabledModels`: a role is a dimension of
   * the same state, so resetting one dimension must be possible independently.
   */
  resetRoleAssignment(role: ProviderRole): void {
    for (const [provider, assignments] of this.roleAssignments) {
      if (!Object.hasOwn(assignments, role)) continue;
      const next = { ...assignments };
      delete next[role];
      if (Object.keys(next).length === 0) this.roleAssignments.delete(provider);
      else this.roleAssignments.set(provider, next);
    }
  }

  /**
   * Forget a provider's agent limits, returning it to "no limits configured"
   * rather than to Unlimited. This is the counterpart a rollback needs: a
   * rejected change must not leave limits behind that the operator never set.
   */
  clearProviderLimits(provider: unknown): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    this.providerLimits.delete(this.providerKey(provider));
  }

  limitsFor(provider: unknown): ProviderAgentLimits | undefined {
    return typeof provider === "string" && provider.trim().length > 0
      ? this.providerLimits.get(this.providerKey(provider))
      : undefined;
  }

  setProviderLimits(provider: unknown, limits: ProviderAgentLimits): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    const key = this.providerKey(provider);
    if (!Object.hasOwn(this.config.providers, key)) return;
    this.providerLimits.set(key, {
      perSession: normaliseLimit(limits.perSession),
      acrossSessions: normaliseLimit(limits.acrossSessions)
    });
  }

  /** The provider's model preference for one agent role, if the operator set one. */
  agentModelFor(provider: unknown, agentRole: unknown): string | undefined {
    return typeof provider === "string" && typeof agentRole === "string"
      ? this.agentModels.get(this.providerKey(provider))?.[
          agentRole.trim().toLowerCase()
        ]
      : undefined;
  }

  /** Every agent-role model preference the operator set for one provider. */
  agentModelsFor(provider: unknown): Record<string, string> {
    return typeof provider === "string"
      ? { ...this.agentModels.get(this.providerKey(provider)) }
      : {};
  }

  /**
   * Set or (with `null`) clear one agent role's model preference on a
   * provider. Only agent roles the routing config names are accepted; the
   * orchestrator is governed by its provider-role assignment instead.
   */
  setAgentModel(
    provider: unknown,
    agentRole: unknown,
    model: string | null
  ): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    if (typeof agentRole !== "string") return;
    const key = this.providerKey(provider);
    const role = agentRole.trim().toLowerCase();
    if (!Object.hasOwn(this.config.providers, key)) return;
    if (!Object.hasOwn(this.config.roles, role)) return;
    const next = { ...this.agentModels.get(key) };
    if (model === null || !model.trim()) delete next[role];
    else next[role] = model.trim();
    if (Object.keys(next).length === 0) this.agentModels.delete(key);
    else this.agentModels.set(key, next);
  }

  /**
   * Forget an operator model choice the provider said it does not have.
   *
   * A role assignment or agent-role preference can name a model id the
   * provider later stops recognising: opencli renamed Gemini's models
   * (`4-argon-complex-tasks` became `4-argon`), and the persisted orchestrator
   * assignment kept the old id. Every request then picked that id, was refused
   * as an unknown model, cooled the model down for a few minutes, and tried it
   * again -- about twenty failed hops per session, each spending seconds
   * before the router fell through to the next provider. The provider's
   * refusal is the authority: the choice is cleared, so the role falls back to
   * the tier's configured model. A configured model is never cleared here; a
   * refusal of one is a provider fault the cooldown handles.
   *
   * Returns whether any choice named the model.
   */
  forgetRejectedModel(provider: unknown, model: unknown): boolean {
    if (typeof provider !== "string" || typeof model !== "string") return false;
    const key = this.providerKey(provider);
    const modelId = model.trim();
    if (!modelId || !Object.hasOwn(this.config.providers, key)) return false;
    const configured = this.config.providers[key]?.models ?? {};
    if (Object.values(configured).some((id) => id.trim() === modelId))
      return false;
    let forgot = false;
    const assignments = this.roleAssignments.get(key);
    if (assignments) {
      for (const role of PROVIDER_ROLES) {
        const assignment = assignments[role];
        if (assignment?.model?.trim() !== modelId) continue;
        assignments[role] = {
          priority: assignment.priority,
          model: null,
          ...(assignment.reasoningEffort
            ? { reasoningEffort: assignment.reasoningEffort }
            : {})
        };
        forgot = true;
      }
    }
    const preferences = this.agentModels.get(key);
    if (preferences) {
      const kept = Object.fromEntries(
        Object.entries(preferences).filter(([, id]) => id.trim() !== modelId)
      );
      if (Object.keys(kept).length !== Object.keys(preferences).length) {
        forgot = true;
        if (Object.keys(kept).length === 0) this.agentModels.delete(key);
        else this.agentModels.set(key, kept);
      }
    }
    return forgot;
  }

  /**
   * Clear every provider Runtime override -- role assignments, agent-role
   * models, provider-wide disables, model disables, and provider agent
   * limits -- in one atomic
   * in-memory step. Agent enablement, provider discovery snapshots,
   * cooldown/health state, and concurrency limits are untouched: none of them
   * are provider routing overrides, so an operator resetting providers has no
   * reason to expect them to move.
   *
   * Returns bounded counts rather than the cleared state itself, so a caller
   * can audit exactly what was cleared without replaying potentially large
   * configuration back into the audit log.
   */
  resetProviderOverrides(): ProviderOverrideResetCounts {
    const roleAssignmentCount = [...this.roleAssignments.values()].reduce(
      (total, assignments) => total + Object.keys(assignments).length,
      0
    );
    const counts: ProviderOverrideResetCounts = {
      roleAssignments: roleAssignmentCount,
      disabledProviders: this.disabledProviders.size,
      disabledModels: this.disabledModels.size,
      providerLimits: this.providerLimits.size,
      agentModels: [...this.agentModels.values()].reduce(
        (total, models) => total + Object.keys(models).length,
        0
      )
    };
    this.roleAssignments.clear();
    this.agentModels.clear();
    this.disabledProviders.clear();
    this.disabledModels.clear();
    this.providerLimits.clear();
    return counts;
  }

  /**
   * Every model the routing config maps a provider tier to, once per model,
   * with the tiers that provider serves with it. Model ids are unique across
   * providers because each must match its own provider's route.
   */
  configuredModels(): ConfiguredModel[] {
    const byModel = new Map<string, ConfiguredModel>();
    for (const [provider, { models }] of Object.entries(
      this.config.providers
    )) {
      for (const [tier, rawModel] of Object.entries(models)) {
        const model = rawModel.trim();
        const entry = byModel.get(model) ?? { model, provider, tiers: [] };
        entry.tiers.push(tier);
        byModel.set(model, entry);
      }
    }
    return [...byModel.values()];
  }

  /** Providers visible to configuration and the request router share one set. */
  providerIds(): string[] {
    return [
      ...new Set([
        ...Object.keys(this.config.providers),
        ...this.routes.map((route) => route.provider)
      ])
    ].sort((left, right) => ROUTING_MODEL_COLLATOR.compare(left, right));
  }

  /** Replace one provider's volatile, source-confirmed model snapshot. */
  setDiscoveredProviderModels(
    provider: unknown,
    models: readonly ControlApiDiscoveredProviderModel[]
  ): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    const key = this.providerKey(provider);
    const route = this.routes.find((candidate) => candidate.provider === key);
    const discovered = new Map<string, DiscoveredProviderModel>();
    for (const model of models) {
      if (typeof model.id !== "string" || model.id.trim() !== model.id)
        continue;
      const routeMatches = route?.pattern.test(model.id) ?? false;
      const routeability =
        routeMatches && model.routeability.status === "supported"
          ? model.routeability
          : {
              status: "unsupported" as const,
              reason:
                model.routeability.status === "unsupported"
                  ? model.routeability.reason
                  : "Runtime has no route for this model ID."
            };
      discovered.set(model.id, { ...model, routeability, provider: key });
    }
    this.discoveredProviderModels.set(key, discovered);
  }

  /** Provider-reported model IDs and routeability, not operator assignments. */
  discoveredModels(): DiscoveredProviderModel[] {
    return [...this.discoveredProviderModels.values()]
      .flatMap((models) => [...models.values()])
      .sort(
        (left, right) =>
          ROUTING_MODEL_COLLATOR.compare(left.provider, right.provider) ||
          ROUTING_MODEL_COLLATOR.compare(left.id, right.id)
      );
  }

  /** Whether one model is assigned or currently provider-discovered. */
  isKnownModel(model: unknown): model is string {
    if (this.isConfiguredModel(model)) return true;
    if (typeof model !== "string" || model.trim().length === 0) return false;
    const normalized = model.trim();
    return this.discoveredModels().some(
      (discovered) =>
        discovered.id === normalized &&
        discovered.routeability.status === "supported"
    );
  }

  /** Model choices are scoped to their owner; an ID from another provider is not a choice. */
  isModelAvailableForProvider(provider: unknown, model: unknown): boolean {
    if (typeof provider !== "string" || typeof model !== "string") return false;
    const key = this.providerKey(provider);
    const modelId = model.trim();
    if (!modelId) return false;
    const configured = this.config.providers[key]?.models ?? {};
    return (
      Object.values(configured).some(
        (configuredId) => configuredId.trim() === modelId
      ) ||
      this.discoveredProviderModels.get(key)?.get(modelId)?.routeability
        .status === "supported"
    );
  }

  isConfiguredModel(model: unknown): model is string {
    return (
      typeof model === "string" &&
      this.configuredModels().some((entry) => entry.model === model.trim())
    );
  }

  isModelEnabled(model: unknown): boolean {
    if (typeof model !== "string" || model.trim().length === 0) return false;
    return !this.disabledModels.has(model.trim());
  }

  setModelEnabled(model: unknown, enabled: boolean): void {
    if (!this.isKnownModel(model)) return;
    const key = model.trim();
    if (enabled) this.disabledModels.delete(key);
    else this.disabledModels.add(key);
  }

  resetDisabledModels(): void {
    this.disabledModels.clear();
  }

  /**
   * The single enablement check for a provider/model route: the provider must
   * be enabled for the role, must be able to serve it, and, when the route
   * names a model, that model must be enabled too.
   */
  routeDisabledReason(
    route: { provider: string; model?: string | null | undefined },
    role: ProviderRole
  ): RouteDisabledReason | null {
    if (!this.isProviderEnabledForRole(route.provider, role))
      return "provider_disabled";
    const capability = this.providerRoleCapabilityReason(route.provider, role);
    if (capability !== null) return capability;
    if (
      typeof route.model === "string" &&
      route.model.trim().length > 0 &&
      !this.isModelEnabled(route.model)
    )
      return "model_disabled";
    return null;
  }

  runtimeState(): RoutingPolicyState {
    const roleAssignments: Record<
      string,
      Partial<Record<ProviderRole, ProviderRoleAssignment>>
    > = {};
    for (const [provider, assignments] of this.roleAssignments) {
      roleAssignments[provider] = { ...assignments };
    }
    return {
      roleAssignments,
      disabledProviders: [...this.disabledProviders].sort(),
      disabledModels: [...this.disabledModels].sort(),
      disabledAgentRoles: [...this.disabledAgentRoles].sort(),
      agentEnablementRevisions: Object.fromEntries(
        [...this.agentEnablementRevisions.entries()].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      ),
      providerLimits: Object.fromEntries(this.providerLimits),
      agentModels: Object.fromEntries(
        Array.from(this.agentModels, ([provider, models]) => [
          provider,
          { ...models }
        ])
      )
    };
  }

  restoreRuntimeState(state: unknown): void {
    this.roleAssignments.clear();
    this.disabledProviders.clear();
    this.disabledModels.clear();
    this.disabledAgentRoles.clear();
    this.agentEnablementRevisions.clear();
    this.providerLimits.clear();
    this.agentModels.clear();
    if (!isRecord(state)) return;

    this.restoreRoleAssignments(state.roleAssignments);
    this.restoreDisabledModels(state.disabledModels);
    this.restoreDisabledProviders(state.disabledProviders);
    this.restoreDisabledAgentRoles(state.disabledAgentRoles);
    this.restoreAgentEnablementRevisions(state.agentEnablementRevisions);
    this.restoreProviderLimits(state.providerLimits);
    this.restoreAgentModels(state.agentModels);
  }

  /** Rebuild agent-role models; a malformed entry is skipped, not defaulted. */
  private restoreAgentModels(raw: unknown): void {
    if (!isRecord(raw)) return;
    for (const [provider, models] of Object.entries(raw)) {
      if (!isRecord(models)) continue;
      for (const [role, model] of Object.entries(models)) {
        if (nonEmptyString(model)) this.setAgentModel(provider, role, model);
      }
    }
  }

  /**
   * Rebuild role assignments from persisted state. A provider or role whose
   * persisted entry is malformed is skipped rather than restored as a default,
   * because an unreadable value is not the same as an operator's decision to
   * leave the role at priority 1.
   */
  private restoreRoleAssignments(raw: unknown): void {
    if (!isRecord(raw)) return;
    for (const [provider, assignments] of Object.entries(raw)) {
      if (
        typeof provider !== "string" ||
        !Object.hasOwn(this.config.providers, this.providerKey(provider)) ||
        !isRecord(assignments)
      )
        continue;
      for (const role of PROVIDER_ROLES) {
        const assignment = readRoleAssignment(assignments[role]);
        if (assignment) this.setProviderAssignment(provider, role, assignment);
      }
    }
  }

  private restoreDisabledModels(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const model of raw) {
      if (
        typeof model === "string" &&
        model.trim() === model &&
        PERSISTED_MODEL_ID_PATTERN.test(model)
      ) {
        // Model enablement survives provider-list outages and router restarts.
        // It is harmless to retain a disabled unknown ID: routing still requires
        // a configured or freshly discovered provider model before selection.
        this.disabledModels.add(model);
      }
    }
  }

  private restoreDisabledAgentRoles(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const role of raw) {
      if (this.agentModelAlias(role))
        this.disabledAgentRoles.add((role as string).trim().toLowerCase());
    }
  }

  private restoreAgentEnablementRevisions(raw: unknown): void {
    if (!isRecord(raw)) return;
    for (const [role, revision] of Object.entries(raw)) {
      const canonicalRole = role.trim().toLowerCase();
      if (
        this.agentModelAlias(canonicalRole) !== null &&
        Number.isSafeInteger(revision) &&
        (revision as number) >= 0
      )
        this.agentEnablementRevisions.set(canonicalRole, revision as number);
    }
  }

  private restoreDisabledProviders(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const provider of raw) {
      if (
        typeof provider === "string" &&
        Object.hasOwn(this.config.providers, this.providerKey(provider))
      )
        this.disabledProviders.add(this.providerKey(provider));
    }
  }

  private restoreProviderLimits(raw: unknown): void {
    if (!isRecord(raw)) return;
    for (const [provider, limits] of Object.entries(raw)) {
      if (typeof provider !== "string" || !isRecord(limits)) continue;
      this.setProviderLimits(provider, {
        perSession: (limits.perSession as number | null | undefined) ?? null,
        acrossSessions:
          (limits.acrossSessions as number | null | undefined) ?? null
      });
    }
  }

  shuffleGroup(group: readonly string[], random = Math.random): string[] {
    const items = [...group];
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [items[index], items[other]] = [items[other]!, items[index]!];
    }
    items.sort((left, right) => {
      const failureDifference =
        (this.runtime.providerFailureStreak?.(left) ?? 0) -
        (this.runtime.providerFailureStreak?.(right) ?? 0);
      return (
        failureDifference ||
        (this.runtime.liveProviderCount?.(left) ?? 0) -
          (this.runtime.liveProviderCount?.(right) ?? 0)
      );
    });
    return items;
  }

  /**
   * The assignment that governs a provider for one kind of traffic: the
   * orchestrator's for the orchestrator, the subagent's for every tier a
   * subagent runs in. One assignment governs both the rank and the
   * enablement, so the two cannot disagree.
   */
  private governingAssignment(
    provider: string,
    role: ProviderRole
  ): ProviderRoleAssignment | undefined {
    return this.assignmentFor(
      provider,
      role === "orchestrator" ? "orchestrator" : "subagent"
    );
  }

  /**
   * A tier's effective priority groups, best first.
   *
   * `providerGroups` is the default ranking; an operator's assignment for the
   * tier's governing role overrides it. A provider assigned priority N joins
   * group N whether or not the routing config lists it for the tier -- which is
   * how an opt-in provider such as opencli enters routing from the Console --
   * and one assigned `disabled` leaves the tier. A provider neither listed nor
   * assigned does not serve the tier. Before this, the Console's P1/P2/P3 were
   * persisted and reported but never read: order came from the config alone,
   * and the `default`/`smart` assignments steered nothing.
   */
  effectiveProviderGroups(tier: string, role: ProviderRole): string[][] {
    const configured = new Map<string, number>();
    for (const [index, group] of (
      this.config.providerGroups[tier] ?? []
    ).entries())
      for (const raw of group) {
        const provider = this.providerKey(raw);
        if (!configured.has(provider)) configured.set(provider, index + 1);
      }
    const ranked = new Map<number, string[]>();
    const candidates = [
      ...configured.keys(),
      ...this.providerIds().filter((provider) => !configured.has(provider))
    ];
    for (const provider of candidates) {
      const assignment = this.governingAssignment(provider, role);
      if (assignment?.priority === "disabled") continue;
      const rank =
        typeof assignment?.priority === "number"
          ? assignment.priority
          : configured.get(provider);
      if (rank === undefined) continue;
      ranked.set(rank, [...(ranked.get(rank) ?? []), provider]);
    }
    return [...ranked.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, providers]) => providers);
  }

  /** Every configured tier's effective groups, under the role that governs it. */
  effectiveTierGroups(): Record<string, string[][]> {
    return Object.fromEntries(
      Object.keys(this.config.providerGroups).map((tier) => [
        tier,
        this.effectiveProviderGroups(
          tier,
          tier === this.config.orchestrator.tier ? "orchestrator" : "subagent"
        )
      ])
    );
  }

  providerPriority(
    tier: string,
    random = Math.random,
    role: ProviderRole = "subagent"
  ): string[] {
    const providers: string[] = [];
    for (const group of this.effectiveProviderGroups(tier, role)) {
      for (const provider of this.shuffleGroup(group, random)) {
        if (!this.canProviderServeRole(provider, role)) continue;
        providers.push(provider);
      }
    }
    return providers;
  }

  /**
   * Why a tier has no provider to serve it, split by cause.
   *
   * An empty candidate list has two very different reasons, and the operator
   * can only act on one of them: every provider is switched off (the enable
   * switches are the fix), or the only enabled provider cannot serve the tier
   * at all (no switch will make it serve). The router used to report the first
   * cause for both, which sent the operator to a control surface that could
   * not fix anything.
   */
  tierServingBlockers(
    tier: string,
    role: ProviderRole
  ): {
    readonly disabled: string[];
    readonly cannotDelegate: string[];
    readonly servable: string[];
  } {
    const disabled: string[] = [];
    const cannotDelegate: string[] = [];
    const servable: string[] = [];
    for (const provider of this.effectiveProviderGroups(tier, role).flat()) {
      if (!this.isProviderEnabledForRole(provider, role))
        disabled.push(provider);
      else if (this.providerRoleCapabilityReason(provider, role) === null) {
        servable.push(provider);
      } else {
        cannotDelegate.push(provider);
      }
    }
    return { disabled, cannotDelegate, servable };
  }

  /**
   * The providers a tier cannot use, and why each one is out.
   *
   * A provider that is switched off, whose governing role is disabled, or
   * whose model is switched off never becomes a candidate: it is dropped
   * before the chain runs, without a word. The chain's refusal then names
   * only the providers it tried, which reads as though the others had never
   * been configured -- and an operator who had enabled a provider for a role
   * could not see why it was never asked.
   *
   * Only providers the operator has configured are named. A provider that
   * belongs to no tier is not excluded from it; it was never in it.
   */
  excludedProviders(
    tier: string,
    role: ProviderRole
  ): Array<{ provider: string; reason: string }> {
    const excluded: Array<{ provider: string; reason: string }> = [];
    const servable = new Set(this.providerPriority(tier, () => 0, role));
    for (const provider of this.providerIds()) {
      if (servable.has(provider)) continue;
      const assignments = this.roleAssignments.get(provider) ?? {};
      if (Object.keys(assignments).length === 0) continue;
      if (!this.isProviderEnabled(provider)) {
        excluded.push({
          provider,
          reason: "the provider is switched off"
        });
        continue;
      }
      const governing = this.governingAssignment(provider, role);
      const governingRole =
        role === "orchestrator" ? "orchestrator" : "subagent";
      if (governing?.priority === "disabled") {
        excluded.push({
          provider,
          reason: `its ${governingRole} role is disabled`
        });
        continue;
      }
      const roleAssignment = this.assignmentFor(provider, role);
      if (roleAssignment?.priority === "disabled") {
        excluded.push({
          provider,
          reason: `its ${role} role is disabled`
        });
        continue;
      }
      const model = governing?.model ?? this.configuredModel(provider, tier);
      if (model && !this.isModelEnabled(model)) {
        excluded.push({
          provider,
          reason: `its model ${model} is switched off`
        });
        continue;
      }
      excluded.push({
        provider,
        reason: "it has no priority for this tier"
      });
    }
    return excluded;
  }

  roleForModel(model: unknown): string | null {
    if (typeof model !== "string") return null;
    const match = model.trim().match(AUTODEV_ROLE_PATTERN);
    return match && this.config.roles[match[1]!.toLowerCase()]
      ? match[1]!.toLowerCase()
      : null;
  }

  /** The capability tier one role is served by, or null when it names none. */
  tierForRole(role: unknown): string | null {
    if (typeof role !== "string" || role.trim().length === 0) return null;
    return this.config.roles[role.trim().toLowerCase()]?.tier ?? null;
  }

  /** The providers that can serve the orchestrator tier at all. */
  orchestratorCapableProviders(): string[] {
    return this.providerIds().filter(
      (provider) =>
        this.providerRoleCapabilityReason(provider, "orchestrator") === null
    );
  }

  /**
   * The configured AutoDev alias that names one executable Agent role.
   *
   * The execution contract defines Agent capabilities, but it cannot disable
   * an Agent in pinned RuleSync 43.8.0. The Router's `roles` map is the
   * authoritative source for names that can actually enter through
   * `autodev/<role>`; the orchestrator uses its dedicated alias.
   */
  agentModelAlias(agentRole: unknown): string | null {
    if (typeof agentRole !== "string" || agentRole.trim().length === 0)
      return null;
    const role = agentRole.trim().toLowerCase();
    if (role === "orchestrator") {
      const alias = this.config.orchestrator.alias.trim();
      return AUTODEV_ROLE_PATTERN.test(alias) &&
        this.roleForModel(alias) === null
        ? alias
        : null;
    }
    const alias = `autodev/${role}`;
    return this.roleForModel(alias) === role &&
      alias !== this.config.orchestrator.alias.trim()
      ? alias
      : null;
  }

  /** Null means the configured Agent has no Runtime model-router alias. */
  isAgentEnabled(agentRole: unknown): boolean | null {
    const alias = this.agentModelAlias(agentRole);
    if (!alias || typeof agentRole !== "string") return null;
    const role = agentRole.trim().toLowerCase();
    return !this.disabledAgentRoles.has(role);
  }

  /** Stable per-role generation, or null when no named router alias exists. */
  agentEnablementGeneration(agentRole: unknown): number | null {
    if (
      this.agentModelAlias(agentRole) === null ||
      typeof agentRole !== "string"
    )
      return null;
    return (
      this.agentEnablementRevisions.get(agentRole.trim().toLowerCase()) ?? 0
    );
  }

  /** Returns false for an Agent without a configured router alias. */
  setAgentEnabled(agentRole: unknown, enabled: boolean): boolean {
    const alias = this.agentModelAlias(agentRole);
    if (!alias || typeof agentRole !== "string") return false;
    const role = agentRole.trim().toLowerCase();
    const wasEnabled = !this.disabledAgentRoles.has(role);
    if (wasEnabled === enabled) return true;
    if (enabled) this.disabledAgentRoles.delete(role);
    else this.disabledAgentRoles.add(role);
    this.agentEnablementRevisions.set(
      role,
      (this.agentEnablementRevisions.get(role) ?? 0) + 1
    );
    return true;
  }

  routeForModel(model: unknown): ProviderRoute | null {
    if (typeof model !== "string") return null;
    const trimmed = model.trim();
    if (trimmed === "copilot")
      return this.routes.find((route) => route.provider === "copilot") ?? null;
    return this.routes.find((route) => route.pattern.test(trimmed)) ?? null;
  }

  tierCandidates(
    tier: string | undefined,
    random = Math.random,
    role: ProviderRole = "subagent",
    agentRole: string | null = null
  ): Candidate[] {
    if (!tier) return [];
    return this.providerPriority(tier, random, role).flatMap((provider) => {
      // A provider-role assignment's model is the operator's explicit choice for
      // this provider and role; the tier's configured model is the default it
      // falls back to. Reading only the tier made the model half of a role
      // assignment write-only: the control API validated it, persisted it, and
      // reported `converged` -- reading back the same in-memory object it had
      // just written -- while every request resolved the tier's model instead.
      // The Console's model selector therefore reported a change that no request
      // ever saw, which is why choosing Claude Opus on a provider could not alter
      // the model that ran.
      // An agent-role preference narrows that choice to one of the tier's
      // roles, so an explorer can run a faster model than the workers
      // sharing its tier.
      const assignment = this.governingAssignment(provider, role);
      const model =
        this.agentModelFor(provider, agentRole) ??
        assignment?.model ??
        this.configuredModel(provider, tier);
      if (!model || !this.isModelEnabled(model)) return [];
      const route = this.routeForModel(model);
      if (!route) return [];
      const configuredEffort =
        assignment?.reasoningEffort ??
        (role === "orchestrator"
          ? (this.config.orchestrator.reasoningEffort?.[provider] ?? null)
          : null);
      return [
        {
          ...route,
          model,
          ...(configuredEffort === null
            ? {}
            : { reasoningEffort: configuredEffort })
        }
      ];
    });
  }

  roleCandidates(
    role: string | null | undefined,
    random = Math.random,
    preferred: string | null = null
  ): Candidate[] {
    const scopedMcp = roleScopedMcp(role);
    const candidates = this.tierCandidates(
      typeof role === "string" ? this.config.roles[role]?.tier : undefined,
      random,
      "subagent",
      role ?? null
    ).filter(
      (candidate) =>
        scopedMcp.length === 0 || providerInjectsRoleMcp(candidate.provider)
    );
    return this.preferProvider(candidates, preferred, "subagent");
  }

  orchestratorCandidates(
    random = Math.random,
    preferred: string | null = null
  ): OrchestratorCandidate[] {
    const candidates = this.tierCandidates(
      this.config.orchestrator.tier,
      random,
      "orchestrator"
    ).map((candidate) => ({
      ...candidate,
      reasoningEffort: candidate.reasoningEffort ?? null
    }));
    return this.preferProvider(candidates, preferred, "orchestrator");
  }

  /** Move an enabled preferred provider to the front; the rest keep their order. */
  private preferProvider<T extends Candidate>(
    candidates: T[],
    preferred: string | null,
    role: ProviderRole
  ): T[] {
    if (!preferred || !this.isProviderEnabledForRole(preferred, role))
      return candidates;
    const index = candidates.findIndex(
      (candidate) => candidate.provider === preferred
    );
    if (index <= 0) return candidates;
    return [
      candidates[index]!,
      ...candidates.slice(0, index),
      ...candidates.slice(index + 1)
    ];
  }

  providerModelMetadata(model: string): {
    id: string;
    object: "model";
    owned_by: string;
  } {
    return {
      id: model,
      object: "model",
      owned_by: this.routeForModel(model)?.provider ?? "local-router"
    };
  }

  catalogModelIds(
    models: readonly CatalogModel[],
    roles = defaultRoleAliases(this.config)
  ): string[] {
    return [...new Set([...models.map((model) => model.slug), ...roles])];
  }

  routeCredentialAvailable(
    route: ProviderRoute | null,
    environment: NodeJS.ProcessEnv = process.env
  ): boolean {
    return (
      route !== null &&
      (!route.envKey || Boolean(String(environment[route.envKey] ?? "").trim()))
    );
  }

  configuredModel(
    provider: string,
    tier: string = "default"
  ): string | undefined {
    const providerModels = this.config.providers[provider]?.models;
    return providerModels?.[tier] || providerModels?.default;
  }

  /**
   * The model each of a provider's configured tiers is routed to: the
   * operator's Console assignment for the role that governs the tier, else
   * the routing config's. Status reported the config's alone, so a Console
   * assignment of ChatGPT's Advanced level to every opencli-chatgpt tier
   * read as `default: balanced` while every worker turn ran on Advanced.
   */
  effectiveModels(provider: string): Record<string, string> {
    const models = this.config.providers[provider]?.models ?? {};
    return Object.fromEntries(
      Object.keys(models).map((tier) => [
        tier,
        this.tierModel(provider, tier) ?? ""
      ])
    );
  }

  /** The model a provider serves a tier with, before any agent-role model. */
  tierModel(provider: string, tier: string): string | undefined {
    return (
      this.governingAssignment(
        provider,
        tier === this.config.orchestrator.tier ? "orchestrator" : "subagent"
      )?.model ?? this.configuredModel(provider, tier)
    );
  }

  get orchestratorModel(): string {
    return this.configuredModel("codex", "orchestrator") ?? "gpt-6-luna";
  }

  get smartModel(): string {
    return this.configuredModel("codex", "smart") ?? "gpt-6-sol";
  }
}

const loadedRouting = loadRoutingConfig();
export const ROUTING_CONFIG_FILE = loadedRouting.file;
export const ROUTING_POLICY = new RoutingPolicy(
  loadedRouting.config,
  loadedRouting.file
);
export const ROUTING_CONFIG = ROUTING_POLICY.config;
export const ROUTES = ROUTING_POLICY.routes;
export const ORCHESTRATOR_ALIAS = ROUTING_CONFIG.orchestrator.alias.trim();
export const ORCHESTRATOR_TIER = ROUTING_CONFIG.orchestrator.tier;
export const ORCHESTRATOR_REASONING_EFFORT = Object.freeze({
  ...ROUTING_CONFIG.orchestrator.reasoningEffort
});
export const CONFIGURED_ORCHESTRATOR_MODEL = ROUTING_POLICY.orchestratorModel;
export const CONFIGURED_SMART_MODEL = ROUTING_POLICY.smartModel;
