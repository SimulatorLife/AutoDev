import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  type OpenLitClickHouseOptions,
  resolveOpenLitClickHouseConnection
} from "./clickhouse-config.ts";

export interface ProviderCatalogEntry {
  readonly providerId: string;
  readonly displayName: string;
  readonly description: string;
  readonly requiresVault: boolean;
  readonly configSchema: Record<string, unknown>;
  readonly isDefault: boolean;
}

export interface ModelCatalogEntry {
  readonly provider: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly modelType: "chat" | "completion" | "embedding";
  readonly contextWindow: number;
  readonly inputPricePerMToken: number;
  readonly outputPricePerMToken: number;
  readonly cacheReadPricePerMToken: number;
  readonly cacheCreationPricePerMToken: number;
  readonly capabilities: readonly string[];
  readonly isDefault: boolean;
}

export type SyncModelsOptions = OpenLitClickHouseOptions;

export interface SyncModelsResult {
  readonly totalProviders: number;
  readonly totalModels: number;
  readonly providersInserted: readonly string[];
  readonly providersUnchanged: readonly string[];
  readonly modelsInserted: readonly string[];
  readonly modelsUpdated: readonly string[];
  readonly modelsUnchanged: readonly string[];
}

const DEFAULT_CONFIG_SCHEMA = {
  temperature: {
    min: 0,
    max: 2,
    step: 0.1,
    default: 1,
    description: "Sampling temperature"
  },
  maxTokens: {
    min: 1,
    max: 16_000,
    step: 1,
    default: 2000,
    description: "Maximum tokens to generate"
  },
  topP: {
    min: 0,
    max: 1,
    step: 0.1,
    default: 1,
    description: "Nucleus sampling threshold"
  }
};

/**
 * Canonical AutoDev providers to register into OpenLIT.
 */
export function getAutoDevProviders(): ProviderCatalogEntry[] {
  return [
    {
      providerId: "claude",
      displayName: "Claude Code",
      description: "Anthropic Claude Code subscription and bridge models",
      requiresVault: false,
      configSchema: DEFAULT_CONFIG_SCHEMA,
      isDefault: true
    },
    {
      providerId: "antigravity",
      displayName: "Google Antigravity",
      description: "Google Gemini models bridged via Antigravity CLI",
      requiresVault: false,
      configSchema: DEFAULT_CONFIG_SCHEMA,
      isDefault: true
    },
    {
      providerId: "minimax",
      displayName: "MiniMax",
      description: "MiniMax models bridged via local proxy",
      requiresVault: false,
      configSchema: DEFAULT_CONFIG_SCHEMA,
      isDefault: true
    },
    {
      providerId: "copilot",
      displayName: "GitHub Copilot",
      description: "GitHub Copilot models bridged via Copilot CLI",
      requiresVault: false,
      configSchema: DEFAULT_CONFIG_SCHEMA,
      isDefault: true
    },
    {
      providerId: "codex",
      displayName: "OpenAI Codex",
      description: "OpenAI Codex models managed by AutoDev router",
      requiresVault: false,
      configSchema: DEFAULT_CONFIG_SCHEMA,
      isDefault: true
    },
    {
      providerId: "autodev",
      displayName: "AutoDev Virtual Roles",
      description: "AutoDev role-based virtual agent router endpoints",
      requiresVault: false,
      configSchema: DEFAULT_CONFIG_SCHEMA,
      isDefault: true
    }
  ];
}

/**
 * Canonical AutoDev models and pricing to register into OpenLIT.
 */
export function getAutoDevModels(): ModelCatalogEntry[] {
  return [
    // Claude (Anthropic)
    {
      provider: "claude",
      modelId: "sonnet",
      displayName: "Claude Sonnet",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 3,
      outputPricePerMToken: 15,
      cacheReadPricePerMToken: 0.3,
      cacheCreationPricePerMToken: 3.75,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: true
    },
    {
      provider: "claude",
      modelId: "opus",
      displayName: "Claude Opus",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 15,
      outputPricePerMToken: 75,
      cacheReadPricePerMToken: 1.5,
      cacheCreationPricePerMToken: 18.75,
      capabilities: ["chat", "tools"],
      isDefault: false
    },
    {
      provider: "claude",
      modelId: "haiku",
      displayName: "Claude Haiku",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0.8,
      outputPricePerMToken: 4,
      cacheReadPricePerMToken: 0.08,
      cacheCreationPricePerMToken: 1,
      capabilities: ["chat", "tools"],
      isDefault: false
    },

    // Antigravity (Google)
    {
      provider: "antigravity",
      modelId: "gemini-3.8-flash-medium",
      displayName: "Gemini 3.8 Flash Medium",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0.5,
      outputPricePerMToken: 3,
      cacheReadPricePerMToken: 0.05,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: true
    },
    {
      provider: "antigravity",
      modelId: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 1.25,
      outputPricePerMToken: 10,
      cacheReadPricePerMToken: 0.125,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "antigravity",
      modelId: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0.3,
      outputPricePerMToken: 2.5,
      cacheReadPricePerMToken: 0.03,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },

    // MiniMax
    {
      provider: "minimax",
      modelId: "MiniMax-M3",
      displayName: "MiniMax-M3",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0.3,
      outputPricePerMToken: 1.2,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: true
    },
    {
      provider: "minimax",
      modelId: "MiniMax-M3.1-Flash-Preview",
      displayName: "MiniMax-M3.1-Flash-Preview",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0.3,
      outputPricePerMToken: 1.2,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      displayName: "MiniMax-M2.7",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0.3,
      outputPricePerMToken: 1.2,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },

    // Copilot
    {
      provider: "copilot",
      modelId: "copilot",
      displayName: "GitHub Copilot",
      modelType: "chat",
      contextWindow: 128_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: true
    },

    // Codex (OpenAI)
    {
      provider: "codex",
      modelId: "gpt-6-luna",
      displayName: "GPT-6 Luna",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 5,
      outputPricePerMToken: 20,
      cacheReadPricePerMToken: 0.5,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: true
    },
    {
      provider: "codex",
      modelId: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10,
      cacheReadPricePerMToken: 0.25,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "codex",
      modelId: "gpt-6-sol",
      displayName: "GPT-6 Sol",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 1,
      outputPricePerMToken: 5,
      cacheReadPricePerMToken: 0.1,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },

    // AutoDev Virtual Roles
    {
      provider: "autodev",
      modelId: "autodev/default",
      displayName: "AutoDev Default Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: true
    },
    {
      provider: "autodev",
      modelId: "autodev/worker",
      displayName: "AutoDev Worker Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/orchestrator",
      displayName: "AutoDev Orchestrator Role",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/explorer",
      displayName: "AutoDev Explorer Role",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/smart",
      displayName: "AutoDev Smart Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/validator",
      displayName: "AutoDev Validator Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/docs-researcher",
      displayName: "AutoDev Docs Researcher Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/browser-tester",
      displayName: "AutoDev Browser Tester Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/playtester",
      displayName: "AutoDev Playtester Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools"],
      isDefault: false
    },
    {
      provider: "autodev",
      modelId: "autodev/playtest-analyst",
      displayName: "AutoDev Playtest Analyst Role",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
      cacheReadPricePerMToken: 0,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },

    // Aliases under canonical provider names for trace attribution
    {
      provider: "anthropic",
      modelId: "sonnet",
      displayName: "Claude Sonnet (AutoDev)",
      modelType: "chat",
      contextWindow: 200_000,
      inputPricePerMToken: 3,
      outputPricePerMToken: 15,
      cacheReadPricePerMToken: 0.3,
      cacheCreationPricePerMToken: 3.75,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "google",
      modelId: "gemini-3.8-flash-medium",
      displayName: "Gemini 3.8 Flash Medium (AutoDev)",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 0.5,
      outputPricePerMToken: 3,
      cacheReadPricePerMToken: 0.05,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "openai",
      modelId: "gpt-6-luna",
      displayName: "GPT-6 Luna (AutoDev)",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 5,
      outputPricePerMToken: 20,
      cacheReadPricePerMToken: 0.5,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "openai",
      modelId: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra (AutoDev)",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10,
      cacheReadPricePerMToken: 0.25,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    },
    {
      provider: "openai",
      modelId: "gpt-6-sol",
      displayName: "GPT-6 Sol (AutoDev)",
      modelType: "chat",
      contextWindow: 1_000_000,
      inputPricePerMToken: 1,
      outputPricePerMToken: 5,
      cacheReadPricePerMToken: 0.1,
      cacheCreationPricePerMToken: 0,
      capabilities: ["chat", "tools", "reasoning"],
      isDefault: false
    }
  ];
}

interface ExistingProviderRow {
  readonly provider_id: string;
}

interface ExistingModelRow {
  readonly provider: string;
  readonly model_id: string;
  readonly context_window: number;
  readonly input_price_per_m_token: number;
  readonly output_price_per_m_token: number;
}

async function fetchExistingProviders(endpoint: string): Promise<Set<string>> {
  const query =
    "SELECT provider_id FROM openlit.openlit_provider_metadata FORMAT JSONEachRow";
  const res = await fetch(`${endpoint}&query=${encodeURIComponent(query)}`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch providers from ClickHouse: ${res.statusText}`
    );
  }
  const text = await res.text();
  const set = new Set<string>();
  for (const line of text.trim().split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ExistingProviderRow;
      if (parsed.provider_id) set.add(parsed.provider_id);
    } catch {
      // ignore malformed lines
    }
  }
  return set;
}

async function fetchExistingModels(
  endpoint: string
): Promise<Map<string, ExistingModelRow>> {
  const query =
    "SELECT provider, model_id, context_window, input_price_per_m_token, output_price_per_m_token FROM openlit.openlit_provider_models FORMAT JSONEachRow";
  const res = await fetch(`${endpoint}&query=${encodeURIComponent(query)}`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch models from ClickHouse: ${res.statusText}`
    );
  }
  const text = await res.text();
  const map = new Map<string, ExistingModelRow>();
  for (const line of text.trim().split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ExistingModelRow;
      if (parsed.provider && parsed.model_id) {
        map.set(`${parsed.provider}::${parsed.model_id}`, parsed);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return map;
}

async function insertProviders(
  endpoint: string,
  rows: readonly ProviderCatalogEntry[]
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const jsonLines = rows.map((r) =>
    JSON.stringify({
      provider_id: r.providerId,
      display_name: r.displayName,
      description: r.description,
      requires_vault: r.requiresVault ? 1 : 0,
      config_schema: JSON.stringify(r.configSchema),
      is_default: r.isDefault ? 1 : 0,
      created_at: now,
      updated_at: now
    })
  );

  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "INSERT INTO openlit.openlit_provider_metadata FORMAT JSONEachRow"
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: jsonLines.join("\n")
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `ClickHouse provider insert failed (${res.status}): ${errorText}`
    );
  }
}

async function insertModels(
  endpoint: string,
  rows: readonly ModelCatalogEntry[]
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const jsonLines = rows.map((r) =>
    JSON.stringify({
      id: randomUUID(),
      provider: r.provider,
      model_id: r.modelId,
      display_name: r.displayName,
      model_type: r.modelType,
      context_window: r.contextWindow,
      input_price_per_m_token: r.inputPricePerMToken,
      output_price_per_m_token: r.outputPricePerMToken,
      cache_read_price_per_m_token: r.cacheReadPricePerMToken,
      cache_creation_price_per_m_token: r.cacheCreationPricePerMToken,
      capabilities: r.capabilities,
      is_default: r.isDefault ? 1 : 0,
      created_by_user_id: "",
      created_at: now,
      updated_at: now
    })
  );

  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "INSERT INTO openlit.openlit_provider_models FORMAT JSONEachRow"
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: jsonLines.join("\n")
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `ClickHouse model insert failed (${res.status}): ${errorText}`
    );
  }
}

export async function syncRulesyncModels(
  options: SyncModelsOptions = {}
): Promise<SyncModelsResult> {
  const { endpoint } = resolveOpenLitClickHouseConnection(options);

  const providers = getAutoDevProviders();
  const models = getAutoDevModels();

  const existingProviders = await fetchExistingProviders(endpoint);
  const existingModels = await fetchExistingModels(endpoint);

  const providersToInsert: ProviderCatalogEntry[] = [];
  const providersInserted: string[] = [];
  const providersUnchanged: string[] = [];

  for (const p of providers) {
    if (existingProviders.has(p.providerId)) {
      providersUnchanged.push(p.providerId);
    } else {
      providersToInsert.push(p);
      providersInserted.push(p.providerId);
    }
  }

  await insertProviders(endpoint, providersToInsert);

  const modelsToInsert: ModelCatalogEntry[] = [];
  const modelsInserted: string[] = [];
  const modelsUpdated: string[] = [];
  const modelsUnchanged: string[] = [];

  for (const m of models) {
    const key = `${m.provider}::${m.modelId}`;
    const existing = existingModels.get(key);
    if (!existing) {
      modelsToInsert.push(m);
      modelsInserted.push(key);
    } else if (
      existing.input_price_per_m_token !== m.inputPricePerMToken ||
      existing.output_price_per_m_token !== m.outputPricePerMToken ||
      existing.context_window !== m.contextWindow
    ) {
      // ClickHouse ReplacingMergeTree or re-insert with latest pricing
      modelsToInsert.push(m);
      modelsUpdated.push(key);
    } else {
      modelsUnchanged.push(key);
    }
  }

  await insertModels(endpoint, modelsToInsert);

  return {
    totalProviders: providers.length,
    totalModels: models.length,
    providersInserted,
    providersUnchanged,
    modelsInserted,
    modelsUpdated,
    modelsUnchanged
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRulesyncModels()
    .then((result) => {
      process.stdout.write(
        [
          `Synchronized ${result.totalProviders} providers and ${result.totalModels} models to AutoDev Console:`,
          `  Providers Inserted:  ${result.providersInserted.length}`,
          `  Providers Unchanged: ${result.providersUnchanged.length}`,
          `  Models Inserted:     ${result.modelsInserted.length}`,
          `  Models Updated:      ${result.modelsUpdated.length}`,
          `  Models Unchanged:    ${result.modelsUnchanged.length}`
        ].join("\n") + "\n"
      );
      process.exitCode = 0;
      return result;
    })
    .catch((error) => {
      process.stderr.write(
        `Failed to sync AutoDev models to AutoDev Console: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
      return null;
    });
}
