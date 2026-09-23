import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

export type ProviderRole = "orchestrator" | "subagent";

export interface RoutingRuntimeState {
  disabledOrchestratorProviders: string[];
  disabledSubagentProviders: string[];
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
    pattern: /^MiniMax-[A-Za-z0-9][A-Za-z0-9.-]*$/,
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

function rawConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Routing config must be an object.");
  return value;
}

function validateTierGroups(
  config: Record<string, unknown>,
  tier: string
): void {
  const providerGroups = config.providerGroups;
  if (!isRecord(providerGroups))
    throw new Error("Routing config requires providerGroups.");
  const groups = providerGroups[tier];
  if (!Array.isArray(groups) || groups.length === 0)
    throw new Error(`Routing config tier ${tier} must define provider groups.`);
  const providers = isRecord(config.providers) ? config.providers : {};
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

function validateRoutesBlock(config: Record<string, unknown>): void {
  if (config.routes === undefined) return;
  if (!isRecord(config.routes))
    throw new Error("Routing config routes must be an object.");
  for (const provider of Object.keys(config.providers)) {
    const route = config.routes[provider];
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
function validateProviderModelRoutes(config: Record<string, unknown>): void {
  const routes: [string, RegExp][] = isRecord(config.routes)
    ? Object.entries(config.routes).map(([provider, route]) => [
        provider,
        new RegExp(String((route as Record<string, unknown>).pattern))
      ])
    : DEFAULT_ROUTES.map((route) => [route.provider, route.pattern]);
  // validateProvidersBlock has already checked every provider has a models object.
  const providers = config.providers as Record<
    string,
    { models: Record<string, unknown> }
  >;
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

function validateProvidersBlock(config: Record<string, unknown>): void {
  for (const [provider, info] of Object.entries(config.providers)) {
    if (!isRecord(info) || !isRecord(info.models))
      throw new Error(
        `Routing config provider ${provider} must define a models object.`
      );
    if (!nonEmptyString(info.models.default))
      throw new Error(
        `Routing config provider ${provider} must define a default model.`
      );
  }
}

function validateRolesBlock(config: Record<string, unknown>): void {
  for (const role of ROLE_NAMES) {
    const roleConfig = config.roles[role];
    if (!isRecord(roleConfig) || !nonEmptyString(roleConfig.tier))
      throw new Error(`Routing config role ${role} must define a tier.`);
    validateTierGroups(config, roleConfig.tier);
  }
}

function validateOrchestratorBlock(config: Record<string, unknown>): void {
  const orchestrator = config.orchestrator;
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
  validateTierGroups(config, orchestrator.tier);
  if (orchestrator.reasoningEffort === undefined) return;
  if (!isRecord(orchestrator.reasoningEffort))
    throw new Error(
      "Routing config orchestrator.reasoningEffort must be an object mapping providers to effort strings."
    );
  for (const [provider, effort] of Object.entries(
    orchestrator.reasoningEffort
  )) {
    if (!Object.hasOwn(config.providers, provider))
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
  validateRoutesBlock(config);
  if (!isRecord(config.roles))
    throw new Error("Routing config requires roles.");
  if (!isRecord(config.orchestrator))
    throw new Error("Routing config requires an orchestrator block.");
  validateProvidersBlock(config);
  validateProviderModelRoutes(config);
  validateRolesBlock(config);
  validateOrchestratorBlock(config);
  return config as unknown as RoutingConfig;
}

function resolveConfigPath(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.CODEX_ROUTER_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  const repositorySource = fileURLToPath(
    new URL("../../config/model-routing.json", import.meta.url)
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
  private readonly disabledOrchestratorProviders = new Set<string>();
  private readonly disabledSubagentProviders = new Set<string>();

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

  isProviderEnabledForRole(provider: unknown, role: ProviderRole): boolean {
    if (typeof provider !== "string" || provider.trim().length === 0)
      return false;
    const disabled =
      role === "orchestrator"
        ? this.disabledOrchestratorProviders
        : this.disabledSubagentProviders;
    return !disabled.has(provider.toLowerCase().trim());
  }

  setProviderEnabledForRole(
    provider: unknown,
    role: ProviderRole,
    enabled: boolean
  ): void {
    if (typeof provider !== "string" || !provider.trim()) return;
    const key = provider.toLowerCase().trim();
    const disabled =
      role === "orchestrator"
        ? this.disabledOrchestratorProviders
        : this.disabledSubagentProviders;
    if (enabled) disabled.delete(key);
    else disabled.add(key);
  }

  resetDisabledProvidersForRole(role: ProviderRole): void {
    (role === "orchestrator"
      ? this.disabledOrchestratorProviders
      : this.disabledSubagentProviders
    ).clear();
  }

  runtimeState(): RoutingRuntimeState {
    return {
      disabledOrchestratorProviders: [
        ...this.disabledOrchestratorProviders
      ].sort(),
      disabledSubagentProviders: [...this.disabledSubagentProviders].sort()
    };
  }

  restoreRuntimeState(state: unknown): void {
    this.disabledOrchestratorProviders.clear();
    this.disabledSubagentProviders.clear();
    if (!isRecord(state)) return;
    for (const [role, disabled] of [
      ["orchestrator", state.disabledOrchestratorProviders],
      ["subagent", state.disabledSubagentProviders]
    ] as const) {
      if (!Array.isArray(disabled)) continue;
      const target =
        role === "orchestrator"
          ? this.disabledOrchestratorProviders
          : this.disabledSubagentProviders;
      for (const provider of disabled) {
        if (
          typeof provider === "string" &&
          Object.hasOwn(this.config.providers, provider.toLowerCase())
        )
          target.add(provider.toLowerCase());
      }
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
      const providerModels = this.config.providers[provider]?.models;
      const model = providerModels?.[tier] || providerModels?.default;
      if (!model) return [];
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
