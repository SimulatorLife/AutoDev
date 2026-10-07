import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  PROVIDER_ROLES,
  type ProviderAgentLimits,
  type ProviderRole,
  type ProviderRoleAssignment,
  type RoutingPolicyState
} from "@simulatorlife/autodev-core";
import { MINIMAX_MODEL_PATTERN } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

export const ROLE_NAMES = [
  "default",
  "docs-researcher",
  "browser-tester",
  "explorer",
  "worker",
  "validator",
  "smart"
] as const;

export interface RawRouteConfig {
  pattern: string;
  baseUrl: string;
  healthUrl?: string;
  envKey?: string | null;
}

export interface ProviderRoute {
  provider: string;
  pattern: RegExp;
  baseUrl: string;
  healthUrl?: string;
  envKey?: string | null;
}

export interface ProviderModelsConfig {
  models: Record<string, string>;
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

/** Why a provider/model route may not serve a role right now. */
export type RouteDisabledReason = "provider_disabled" | "model_disabled";

export interface ConfiguredModel {
  model: string;
  provider: string;
  tiers: string[];
}

const ORCHESTRATOR_ALIAS_PATTERN = /^autodev\/[a-z0-9-]+$/u;
const AUTODEV_ROLE_PATTERN = /^autodev\/([a-z0-9-]+)$/iu;

const DEFAULT_ROUTES: readonly ProviderRoute[] = [
  {
    provider: "claude",
    // Anthropic model ids are lowercase, hyphen-separated: never `claude-opus-5.5`.
    pattern: /^(sonnet|opus|haiku|claude-[a-z0-9-]*[a-z0-9])$/,
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
  {
    provider: "antigravity",
    pattern: /^gemini-[A-Za-z0-9][A-Za-z0-9.-]*$/,
    baseUrl: "http://127.0.0.1:4002/v1",
    healthUrl: "http://127.0.0.1:4002/health/liveliness",
    envKey: "LITELLM_API_KEY"
  },
  {
    provider: "codex",
    pattern:
      /^(gpt-[A-Za-z0-9][A-Za-z0-9.-]*|o[1-9][A-Za-z0-9.-]*|codex-[A-Za-z0-9][A-Za-z0-9.-]*)$/,
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
  if (priority !== 1 && priority !== 2 && priority !== 3 && priority !== "disabled")
    return null;
  return {
    priority,
    model: nonEmptyString(value.model) ? value.model.trim() : null
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
    ...(route.envKey === undefined ? {} : { envKey: route.envKey })
  }));
}

function defaultRoleAliases(config: RoutingConfig): string[] {
  return [
    ...ROLE_NAMES.map((role) => `autodev/${role}`),
    config.orchestrator.alias.trim()
  ];
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
  private readonly providerLimits = new Map<string, ProviderAgentLimits>();

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
      model: assignment.model
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
    if (!this.isConfiguredModel(model)) return;
    const key = model.trim();
    if (enabled) this.disabledModels.delete(key);
    else this.disabledModels.add(key);
  }

  resetDisabledModels(): void {
    this.disabledModels.clear();
  }

  /**
   * The single enablement check for a provider/model route: the provider must
   * be enabled for the role and, when the route names a model, that model must
   * be enabled too.
   */
  routeDisabledReason(
    route: { provider: string; model?: string | null | undefined },
    role: ProviderRole
  ): RouteDisabledReason | null {
    if (!this.isProviderEnabledForRole(route.provider, role))
      return "provider_disabled";
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
      providerLimits: Object.fromEntries(this.providerLimits)
    };
  }

  restoreRuntimeState(state: unknown): void {
    this.roleAssignments.clear();
    this.disabledProviders.clear();
    this.disabledModels.clear();
    this.providerLimits.clear();
    if (!isRecord(state)) return;

    this.restoreRoleAssignments(state.roleAssignments);
    this.restoreDisabledModels(state.disabledModels);
    this.restoreDisabledProviders(state.disabledProviders);
    this.restoreProviderLimits(state.providerLimits);
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
      if (this.isConfiguredModel(model)) this.disabledModels.add(model.trim());
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

  providerPriority(
    tier: string,
    random = Math.random,
    role: ProviderRole = "subagent"
  ): string[] {
    const providers: string[] = [];
    const seen = new Set<string>();
    for (const rawGroup of this.config.providerGroups[tier] ?? []) {
      const group = rawGroup.map((provider) => provider.trim().toLowerCase());
      for (const provider of this.shuffleGroup(group, random)) {
        if (
          !this.isProviderEnabledForRole(provider, role) ||
          seen.has(provider)
        )
          continue;
        seen.add(provider);
        providers.push(provider);
      }
    }
    return providers;
  }

  roleForModel(model: unknown): string | null {
    if (typeof model !== "string") return null;
    const match = model.trim().match(AUTODEV_ROLE_PATTERN);
    return match && this.config.roles[match[1]!.toLowerCase()]
      ? match[1]!.toLowerCase()
      : null;
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
    role: ProviderRole = "subagent"
  ): Candidate[] {
    if (!tier) return [];
    return this.providerPriority(tier, random, role).flatMap((provider) => {
      const model = this.configuredModel(provider, tier);
      if (!model || !this.isModelEnabled(model)) return [];
      const route = this.routeForModel(model);
      return route ? [{ ...route, model }] : [];
    });
  }

  roleCandidates(
    role: string | null | undefined,
    random = Math.random,
    preferred: string | null = null
  ): Candidate[] {
    return this.preferProvider(
      this.tierCandidates(
        typeof role === "string" ? this.config.roles[role]?.tier : undefined,
        random,
        "subagent"
      ),
      preferred,
      "subagent"
    );
  }

  orchestratorCandidates(
    random = Math.random,
    preferred: string | null = null
  ): OrchestratorCandidate[] {
    const effort = this.config.orchestrator.reasoningEffort ?? {};
    const candidates = this.tierCandidates(
      this.config.orchestrator.tier,
      random,
      "orchestrator"
    ).map((candidate) => ({
      ...candidate,
      reasoningEffort: effort[candidate.provider] ?? null
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
