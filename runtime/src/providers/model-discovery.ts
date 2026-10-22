/** Runtime-owned, off-hot-path discovery of provider model capabilities. */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ControlApiDiscoveredProviderModel,
  ControlApiProviderModelDiscovery,
  ControlApiProviderModelsResponse
} from "@simulatorlife/autodev-core";
import { providerQuotaPool } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

import { loadCodexAuth } from "../router/proxy.ts";
import { ROUTES, ROUTING_POLICY } from "../router/routing.ts";
import { readClaudeOAuthToken } from "./claude-credential.ts";

const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60_000;
// `agy models` performs its own remote listing and runs off the request/routing
// path, so give this CLI source an independent, still-bounded deadline. The
// listing is a provider-side remote call: it measured 3.0-9.0 seconds on an
// idle machine on 2026-10-22 and exceeded twelve seconds while the machine
// was busy, which turned a valid listing into a stale one and left the
// Antigravity models unselectable.
const ANTIGRAVITY_CLI_TIMEOUT_MS = 30_000;
const PROVIDER_API_DISCOVERY_TIMEOUT_MS = 8000;
const MAX_AGY_OUTPUT_BYTES = 64 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;
// The Codex account model list is not a compact ID list: every model carries
// its base instructions, tool descriptors and message payloads, so a
// six-model account response is already ~310 KB and grows with the plan. The
// compact bound rejected every Codex refresh, which left the Runtime with a
// stale Codex model list and no selectable Codex model.
const MAX_CODEX_MODEL_LIST_BYTES = 2 * 1024 * 1024;
const MINIMAX_API_BASE_URL = "https://api.minimax.io";
const ANTHROPIC_MODEL_LIST_URL =
  "https://api.anthropic.com/v1/models?limit=100";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_MODEL_LIST_URL = `${CODEX_BACKEND_BASE_URL}/models`;
/**
 * The client version the Runtime declares to the Codex account model list.
 *
 * The endpoint filters the account's models by the client version the caller
 * declares, so a client that is not the Codex CLI has to declare a version of
 * its own. The Runtime drives the Codex backend directly: it does not spawn
 * the Codex CLI, and it sends no client version with inference requests, so
 * the installed CLI's release is not a bound on what the Runtime can use.
 * Declaring the installed CLI's version hid the models the Runtime's own
 * routing configuration selects -- `gpt-6-sol` and `gpt-6-luna` need a
 * client at 0.155.0 -- while the Runtime drove them successfully all the
 * same. The Runtime declares a version above every client release, so the
 * listing is the account's own model set: the set an operator may assign to
 * a role.
 */
const CODEX_ACCOUNT_CLIENT_VERSION = "0.999.0";
const MAX_DISCOVERED_MODELS = 512;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DISPLAY_NAME_LIMIT = 256;
const MODEL_LIST_LINE_SPLIT = /\r?\n/u;
const TRAILING_SLASH_PATTERN = /\/+$/u;
const MODEL_DISCOVERY_COLLATOR = new Intl.Collator();
const DISCOVERY_PERSISTENCE_SCHEMA =
  "autodev-provider-model-discovery-state-v1" as const;

interface PersistedProviderModels {
  readonly source: string;
  readonly observedAt: string;
  readonly lastAttemptAt: string;
  readonly reason: string | null;
  readonly models: readonly ProviderModelDiscoveryItem[];
}

const persistedProviderModels = new Map<string, PersistedProviderModels>();
let invalidPersistedProviderModels = false;

export interface ProviderModelDiscoveryItem {
  readonly id: string;
  readonly displayName: string | null;
}

export interface ProviderModelDiscoveryAdapter {
  readonly source: string;
  discover(signal: AbortSignal): Promise<readonly ProviderModelDiscoveryItem[]>;
}

export interface ProviderModelDiscoveryOptions {
  readonly providerIds?: () => readonly string[];
  readonly adapters?: Readonly<Record<string, ProviderModelDiscoveryAdapter>>;
  readonly now?: () => Date;
  readonly refreshIntervalMs?: number;
  readonly onSnapshotChanged?: (() => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Snapshot only the last provider-confirmed IDs, never credentials or routing policy. */
export function providerModelDiscoveryPersistenceSnapshot(): unknown {
  return {
    schema: DISCOVERY_PERSISTENCE_SCHEMA,
    providers: [...persistedProviderModels]
      .sort(([left], [right]) => MODEL_DISCOVERY_COLLATOR.compare(left, right))
      .map(([provider, snapshot]) => ({ provider, ...snapshot }))
  };
}

/** Restore a bounded cache; Runtime will expose it as stale until refresh succeeds. */
export function restoreProviderModelDiscoveryPersistence(
  value: unknown
): boolean {
  persistedProviderModels.clear();
  invalidPersistedProviderModels = false;
  if (value === null || value === undefined) return true;
  if (
    !isRecord(value) ||
    value.schema !== DISCOVERY_PERSISTENCE_SCHEMA ||
    !Array.isArray(value.providers) ||
    value.providers.length > 64
  ) {
    invalidPersistedProviderModels = true;
    return false;
  }

  const providers = new Set<string>();
  for (const candidate of value.providers) {
    if (
      !isRecord(candidate) ||
      typeof candidate.provider !== "string" ||
      candidate.provider.trim() !== candidate.provider ||
      !PROVIDER_ID_PATTERN.test(candidate.provider) ||
      providers.has(candidate.provider) ||
      typeof candidate.source !== "string" ||
      candidate.source.trim().length === 0 ||
      candidate.source.length > 128 ||
      !isCanonicalTimestamp(candidate.observedAt) ||
      !isCanonicalTimestamp(candidate.lastAttemptAt) ||
      (candidate.reason !== null &&
        (typeof candidate.reason !== "string" ||
          candidate.reason.trim().length === 0 ||
          candidate.reason.length > 2048)) ||
      !Array.isArray(candidate.models) ||
      candidate.models.length > MAX_DISCOVERED_MODELS
    ) {
      persistedProviderModels.clear();
      invalidPersistedProviderModels = true;
      return false;
    }

    const modelIds = new Set<string>();
    const models: ProviderModelDiscoveryItem[] = [];
    for (const model of candidate.models) {
      if (
        !isRecord(model) ||
        typeof model.id !== "string" ||
        !MODEL_ID_PATTERN.test(model.id) ||
        modelIds.has(model.id) ||
        (model.displayName !== null &&
          (typeof model.displayName !== "string" ||
            model.displayName.length > DISPLAY_NAME_LIMIT))
      ) {
        persistedProviderModels.clear();
        invalidPersistedProviderModels = true;
        return false;
      }
      modelIds.add(model.id);
      models.push({
        id: model.id,
        displayName: model.displayName as string | null
      });
    }
    providers.add(candidate.provider);
    persistedProviderModels.set(candidate.provider, {
      source: candidate.source,
      observedAt: candidate.observedAt,
      lastAttemptAt: candidate.lastAttemptAt,
      reason: candidate.reason as string | null,
      models
    });
  }
  return true;
}

export function parseAntigravityModelList(
  output: string
): readonly ProviderModelDiscoveryItem[] {
  if (Buffer.byteLength(output, "utf8") > MAX_AGY_OUTPUT_BYTES) {
    throw new Error("agy model list exceeded the response bound");
  }
  const lines = output
    .split(MODEL_LIST_LINE_SPLIT)
    .filter((line) => line.trim().length > 0);
  if (lines.length > MAX_DISCOVERED_MODELS) {
    throw new Error("agy model list exceeded the model-count bound");
  }
  const models: ProviderModelDiscoveryItem[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const separator = line.indexOf("\t");
    const id = (separator === -1 ? line : line.slice(0, separator)).trim();
    const displayName =
      separator === -1 ? "" : line.slice(separator + 1).trim();
    if (!MODEL_ID_PATTERN.test(id) || seen.has(id)) {
      throw new Error(
        "agy model list contained an invalid or duplicate model ID"
      );
    }
    if (displayName.length > DISPLAY_NAME_LIMIT) {
      throw new Error("agy model list contained an oversized display name");
    }
    seen.add(id);
    models.push({ id, displayName: displayName || null });
  }
  return models;
}

function agyExecutable(env: NodeJS.ProcessEnv): string {
  return (
    env.AGY_CLI_PATH?.trim() ||
    path.join(env.HOME?.trim() || homedir(), ".local", "bin", "agy")
  );
}

export function createAntigravityModelDiscoveryAdapter(
  env: NodeJS.ProcessEnv = process.env,
  spawnProcess: typeof spawn = spawn
): ProviderModelDiscoveryAdapter {
  return {
    source: "agy models",
    discover: (signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("provider model discovery was cancelled"));
          return;
        }
        const child = spawnProcess(agyExecutable(env), ["models"], {
          cwd: env.AUTODEV_REPO_ROOT?.trim() || process.cwd(),
          env,
          stdio: ["ignore", "pipe", "ignore"]
        });
        const chunks: Buffer[] = [];
        let byteLength = 0;
        let settled = false;
        const finish = (
          error?: Error,
          result?: readonly ProviderModelDiscoveryItem[]
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(result ?? []);
        };
        const abort = (): void => {
          child.kill("SIGTERM");
          finish(new Error("provider model discovery was cancelled"));
        };
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          const forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
          forceKill.unref();
          finish(new Error("agy model discovery timed out"));
        }, ANTIGRAVITY_CLI_TIMEOUT_MS);
        timer.unref();
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          byteLength += chunk.length;
          if (byteLength > MAX_AGY_OUTPUT_BYTES) {
            child.kill("SIGTERM");
            finish(new Error("agy model list exceeded the response bound"));
            return;
          }
          chunks.push(chunk);
        });
        child.once("error", () => {
          finish(new Error("agy models could not be started"));
        });
        child.once("close", (code) => {
          if (settled) return;
          if (code !== 0) {
            finish(new Error(`agy models exited with status ${String(code)}`));
            return;
          }
          try {
            finish(
              undefined,
              parseAntigravityModelList(Buffer.concat(chunks).toString("utf8"))
            );
          } catch (error) {
            finish(
              error instanceof Error
                ? error
                : new Error("agy model list was invalid")
            );
          }
        });
      })
  };
}

async function boundedResponseText(
  response: Response,
  limitBytes: number
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new Error("Provider model-list response exceeded the size bound.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const readNext = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    totalBytes += value.byteLength;
    if (totalBytes > limitBytes) {
      void reader.cancel();
      throw new Error("Provider model-list response exceeded the size bound.");
    }
    chunks.push(value);
    await readNext();
  };
  await readNext();
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes
  ).toString("utf8");
}

function parseOpenAiModelList(
  payload: unknown
): readonly ProviderModelDiscoveryItem[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error(
      "MiniMax model-list response did not contain a model list."
    );
  }
  const entries = (payload as { data: unknown[] }).data;
  if (entries.length > MAX_DISCOVERED_MODELS) {
    throw new Error("MiniMax model list exceeded the model-count bound.");
  }
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("MiniMax model list contained an invalid entry.");
    }
    const candidate = entry as Record<string, unknown>;
    const id = candidate.id;
    const displayName = candidate.name;
    if (
      typeof id !== "string" ||
      !MODEL_ID_PATTERN.test(id) ||
      seen.has(id) ||
      (displayName !== undefined &&
        (typeof displayName !== "string" ||
          displayName.length > DISPLAY_NAME_LIMIT))
    ) {
      throw new Error(
        "MiniMax model list contained an invalid or duplicate model ID."
      );
    }
    seen.add(id);
    return {
      id,
      displayName: typeof displayName === "string" ? displayName : null
    };
  });
}

export async function discoverMiniMaxModels(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
  parentSignal?: AbortSignal
): Promise<readonly ProviderModelDiscoveryItem[]> {
  const apiKey = env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("MINIMAX_API_KEY is not configured for model discovery.");
  }
  const timeout = AbortSignal.timeout(PROVIDER_API_DISCOVERY_TIMEOUT_MS);
  const signal =
    parentSignal === undefined
      ? timeout
      : AbortSignal.any([parentSignal, timeout]);
  const response = await fetchImpl(`${MINIMAX_API_BASE_URL}/v1/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal
  });
  if (!response.ok) {
    throw new Error(`MiniMax model-list API returned HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      await boundedResponseText(response, MAX_HTTP_RESPONSE_BYTES)
    ) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("size bound"))
      throw error;
    throw new Error("MiniMax model-list API returned invalid JSON.");
  }
  return parseOpenAiModelList(payload);
}

function minimaxModelAdapter(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch
): ProviderModelDiscoveryAdapter {
  return {
    source: "MiniMax GET /v1/models",
    discover: (signal) => discoverMiniMaxModels(env, fetchImpl, signal)
  };
}

/**
 * The Anthropic model list for the signed-in Claude account.
 *
 * The listing authenticates with the account's own OAuth token, so it reports
 * the models this account can run rather than the models Anthropic sells. The
 * Runtime needs that distinction: a model the account cannot run is not a
 * choice an operator may assign to a role.
 */
export function parseAnthropicModelList(
  payload: unknown
): readonly ProviderModelDiscoveryItem[] {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.data) ||
    payload.data.length > MAX_DISCOVERED_MODELS
  ) {
    throw new Error(
      "Claude model-list response did not contain a bounded models array."
    );
  }
  const seen = new Set<string>();
  return payload.data.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Claude model-list response contained an invalid entry.");
    }
    const id = entry.id;
    const displayName = entry.display_name;
    if (
      typeof id !== "string" ||
      !MODEL_ID_PATTERN.test(id) ||
      seen.has(id) ||
      (displayName !== undefined &&
        (typeof displayName !== "string" ||
          displayName.length > DISPLAY_NAME_LIMIT))
    ) {
      throw new Error(
        "Claude model-list response contained an invalid or duplicate model ID."
      );
    }
    seen.add(id);
    return {
      id,
      displayName: typeof displayName === "string" ? displayName : null
    };
  });
}

export async function discoverClaudeModels(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
  parentSignal?: AbortSignal,
  readToken: (env: NodeJS.ProcessEnv) => string = readClaudeOAuthToken
): Promise<readonly ProviderModelDiscoveryItem[]> {
  const token = readToken(env);
  if (!token) {
    throw new Error(
      "Claude Code OAuth token is not configured for model discovery."
    );
  }
  const timeout = AbortSignal.timeout(PROVIDER_API_DISCOVERY_TIMEOUT_MS);
  const signal =
    parentSignal === undefined
      ? timeout
      : AbortSignal.any([parentSignal, timeout]);
  const response = await fetchImpl(ANTHROPIC_MODEL_LIST_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "anthropic-version": ANTHROPIC_API_VERSION,
      Accept: "application/json"
    },
    signal
  });
  if (!response.ok) {
    throw new Error(`Claude model-list API returned HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      await boundedResponseText(response, MAX_HTTP_RESPONSE_BYTES)
    ) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("size bound"))
      throw error;
    throw new Error("Claude model-list API returned invalid JSON.");
  }
  return parseAnthropicModelList(payload);
}

function claudeModelAdapter(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch
): ProviderModelDiscoveryAdapter {
  return {
    source: "Claude account GET /v1/models",
    discover: (signal) => discoverClaudeModels(env, fetchImpl, signal)
  };
}

export function parseCodexModelList(
  payload: unknown
): readonly ProviderModelDiscoveryItem[] {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.models) ||
    payload.models.length > MAX_DISCOVERED_MODELS
  ) {
    throw new Error(
      "Codex model-list response did not contain a bounded models array."
    );
  }
  const seen = new Set<string>();
  return payload.models.flatMap((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Codex model-list response contained an invalid entry.");
    }
    const id = entry.slug;
    const displayName = entry.display_name;
    if (
      typeof id !== "string" ||
      !MODEL_ID_PATTERN.test(id) ||
      seen.has(id) ||
      (displayName !== undefined &&
        (typeof displayName !== "string" ||
          displayName.length > DISPLAY_NAME_LIMIT))
    ) {
      throw new Error(
        "Codex model-list response contained an invalid or duplicate model ID."
      );
    }
    seen.add(id);
    // The account marks the models it keeps out of a model picker
    // (`visibility: "hide"`) and the ones it does not serve through the
    // API. Those are platform-internal models -- a reserved capacity pool,
    // the automatic reviewer -- and offering them as role assignments would
    // be offering a choice the provider itself does not offer.
    if (entry.visibility !== "list" || entry.supported_in_api === false)
      return [];
    return [
      {
        id,
        displayName: typeof displayName === "string" ? displayName : null
      }
    ];
  });
}

function codexRouteUsesAccountBackend(): boolean {
  const route = ROUTES.find((candidate) => candidate.provider === "codex");
  if (!route) return false;
  try {
    const configured = new URL(route.baseUrl);
    const expected = new URL(CODEX_BACKEND_BASE_URL);
    return (
      configured.origin === expected.origin &&
      configured.pathname.replace(TRAILING_SLASH_PATTERN, "") ===
        expected.pathname.replace(TRAILING_SLASH_PATTERN, "")
    );
  } catch {
    return false;
  }
}

export async function discoverCodexModels(
  fetchImpl: typeof fetch = globalThis.fetch,
  loadAuth: typeof loadCodexAuth = loadCodexAuth,
  parentSignal?: AbortSignal
): Promise<readonly ProviderModelDiscoveryItem[]> {
  if (!codexRouteUsesAccountBackend()) {
    throw new Error(
      "Codex route is not the account backend used for provider model discovery."
    );
  }
  const timeout = AbortSignal.timeout(PROVIDER_API_DISCOVERY_TIMEOUT_MS);
  const signal =
    parentSignal === undefined
      ? timeout
      : AbortSignal.any([parentSignal, timeout]);
  let auth: Awaited<ReturnType<typeof loadCodexAuth>>;
  try {
    auth = await loadAuth();
  } catch {
    throw new Error(
      "Codex account authentication is unavailable for model discovery."
    );
  }
  if (signal.aborted) {
    throw new Error("Codex model discovery was cancelled.");
  }
  const url = new URL(CODEX_MODEL_LIST_URL);
  url.searchParams.set("client_version", CODEX_ACCOUNT_CLIENT_VERSION);

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "chatgpt-account-id": auth.accountId,
      Accept: "application/json"
    },
    signal
  });
  if (!response.ok) {
    throw new Error(`Codex model-list API returned HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      await boundedResponseText(response, MAX_CODEX_MODEL_LIST_BYTES)
    ) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("size bound")) {
      throw error;
    }
    throw new Error("Codex model-list API returned invalid JSON.");
  }
  return parseCodexModelList(payload);
}

function codexModelAdapter(
  fetchImpl: typeof fetch = globalThis.fetch
): ProviderModelDiscoveryAdapter {
  return {
    source: "Codex account GET /backend-api/codex/models",
    discover: (signal) => discoverCodexModels(fetchImpl, loadCodexAuth, signal)
  };
}

function defaultAdapters(): Readonly<
  Record<string, ProviderModelDiscoveryAdapter>
> {
  return {
    antigravity: createAntigravityModelDiscoveryAdapter(),
    minimax: minimaxModelAdapter(),
    codex: codexModelAdapter(),
    claude: claudeModelAdapter()
  };
}

function routeability(
  provider: string,
  modelId: string
): ControlApiDiscoveredProviderModel["routeability"] {
  const route = ROUTES.find((candidate) => candidate.provider === provider);
  const matchesRoute = route?.pattern.test(modelId) ?? false;
  // Antigravity's quota attribution is model-family-specific as well as
  // pattern-specific. A matching route is not enough if the Runtime cannot
  // classify which provider quota pool owns the discovered model.
  const hasQuotaOwner =
    provider !== "antigravity" || providerQuotaPool(provider, modelId) !== null;
  return matchesRoute && hasQuotaOwner
    ? { status: "supported" }
    : {
        status: "unsupported",
        reason: "Runtime has no route and quota ownership for this model ID."
      };
}

function unavailable(
  source: string | null,
  lastAttemptAt: string | null,
  reason: string
): ControlApiProviderModelDiscovery {
  return { status: "unavailable", source, lastAttemptAt, reason };
}

export class ProviderModelDiscoveryService {
  private readonly providerIds: () => readonly string[];
  private readonly adapters: Readonly<
    Record<string, ProviderModelDiscoveryAdapter>
  >;
  private readonly now: () => Date;
  private readonly refreshIntervalMs: number;
  private readonly onSnapshotChanged: (() => void) | undefined;
  private readonly states = new Map<string, ControlApiProviderModelDiscovery>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private stopped = false;

  constructor(options: ProviderModelDiscoveryOptions = {}) {
    this.providerIds =
      options.providerIds ?? (() => ROUTING_POLICY.providerIds());
    this.adapters = options.adapters ?? defaultAdapters();
    this.now = options.now ?? (() => new Date());
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.onSnapshotChanged = options.onSnapshotChanged;
    for (const provider of this.providerIds()) {
      const persisted = persistedProviderModels.get(provider);
      if (persisted) {
        const models = persisted.models.map(
          (model) =>
            ({
              ...model,
              routeability: routeability(provider, model.id)
            }) satisfies ControlApiDiscoveredProviderModel
        );
        const reason = persisted.reason
          ? `Runtime restarted before a current listing was confirmed. Last refresh: ${persisted.reason}`
          : "Runtime restarted; the last-known provider listing awaits fresh confirmation.";
        this.states.set(provider, {
          status: "stale",
          source: persisted.source,
          observedAt: persisted.observedAt,
          lastAttemptAt: persisted.lastAttemptAt,
          reason,
          models
        });
        ROUTING_POLICY.setDiscoveredProviderModels(provider, models);
        continue;
      }
      this.states.set(
        provider,
        unavailable(
          this.adapters[provider]?.source ?? null,
          null,
          this.adapters[provider]
            ? invalidPersistedProviderModels
              ? "The persisted model snapshot was invalid and was discarded; waiting for a fresh provider listing."
              : "Model availability has not been observed yet."
            : "No machine-readable model discovery adapter is configured for this provider."
        )
      );
      ROUTING_POLICY.setDiscoveredProviderModels(provider, []);
    }
  }

  snapshot(): ControlApiProviderModelsResponse {
    return {
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [...this.providerIds()]
        .sort(MODEL_DISCOVERY_COLLATOR.compare)
        .map((provider) => ({
          provider,
          discovery:
            this.states.get(provider) ??
            unavailable(
              null,
              null,
              "Provider model availability was not observed."
            )
        }))
    };
  }

  start(): void {
    if (this.stopped || this.refreshTimer !== null) return;
    void this.refresh();
    this.refreshTimer = setInterval(
      () => void this.refresh(),
      this.refreshIntervalMs
    );
    this.refreshTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.abortController?.abort();
    for (const provider of this.providerIds()) {
      ROUTING_POLICY.setDiscoveredProviderModels(provider, []);
    }
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const abortController = new AbortController();
    this.abortController = abortController;
    this.refreshInFlight = this.refreshProviders(
      abortController.signal
    ).finally(() => {
      this.refreshInFlight = null;
      if (this.abortController === abortController) this.abortController = null;
    });
    return this.refreshInFlight;
  }

  private async refreshProviders(signal: AbortSignal): Promise<void> {
    await Promise.all(
      this.providerIds().map(async (provider) => {
        const adapter = this.adapters[provider];
        if (!adapter) return;
        const attemptedAt = this.now().toISOString();
        const previous = this.states.get(provider);
        try {
          const discovered = await adapter.discover(signal);
          if (this.stopped || signal.aborted) return;
          const ids = new Set<string>();
          const models = discovered.map((model) => {
            if (!MODEL_ID_PATTERN.test(model.id) || ids.has(model.id)) {
              throw new Error(
                "Provider model source returned an invalid or duplicate ID."
              );
            }
            ids.add(model.id);
            return {
              id: model.id,
              displayName: model.displayName,
              routeability: routeability(provider, model.id)
            } satisfies ControlApiDiscoveredProviderModel;
          });
          if (models.length > MAX_DISCOVERED_MODELS) {
            throw new Error(
              "Provider model source exceeded the model-count bound."
            );
          }
          const observedAt = this.now().toISOString();
          this.states.set(provider, {
            status: "observed",
            source: adapter.source,
            observedAt,
            lastAttemptAt: attemptedAt,
            models
          });
          ROUTING_POLICY.setDiscoveredProviderModels(provider, models);
          this.persistCurrentState(provider);
        } catch (error) {
          if (this.stopped || signal.aborted) return;
          const reason =
            error instanceof Error
              ? error.message
              : "Provider model discovery failed.";
          if (
            previous &&
            (previous.status === "observed" || previous.status === "stale")
          ) {
            this.states.set(provider, {
              status: "stale",
              source: adapter.source,
              observedAt: previous.observedAt,
              lastAttemptAt: attemptedAt,
              reason,
              models: previous.models
            });
            ROUTING_POLICY.setDiscoveredProviderModels(
              provider,
              previous.models
            );
            this.persistCurrentState(provider);
          } else {
            this.states.set(
              provider,
              unavailable(adapter.source, attemptedAt, reason)
            );
            ROUTING_POLICY.setDiscoveredProviderModels(provider, []);
          }
        }
      })
    );
  }

  private persistCurrentState(provider: string): void {
    const state = this.states.get(provider);
    if (!state || state.status === "unavailable") return;
    persistedProviderModels.set(provider, {
      source: state.source,
      observedAt: state.observedAt,
      lastAttemptAt: state.lastAttemptAt,
      reason: state.status === "stale" ? state.reason : null,
      models: state.models.map(({ id, displayName }) => ({ id, displayName }))
    });
    this.onSnapshotChanged?.();
  }
}

export function createProviderModelDiscoveryService(
  options: ProviderModelDiscoveryOptions = {}
): ProviderModelDiscoveryService {
  return new ProviderModelDiscoveryService(options);
}
