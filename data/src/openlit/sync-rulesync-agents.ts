import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  groupRowsBy,
  indexRowsBy,
  insertRows,
  removeStaleRows,
  selectRows,
  type StaleRowProjection
} from "../clickhouse/clickhouse-client.ts";
import {
  type OpenLitClickHouseOptions,
  resolveOpenLitClickHouseConnection
} from "./clickhouse-config.ts";

export interface AgentToolEntry {
  readonly name: string;
  readonly type: "mcp" | "skill";
  readonly server?: string;
}

export interface RulesyncAgentData {
  readonly role: string;
  readonly kind: string;
  readonly readOnly: boolean;
  readonly primaryModel: string;
  readonly models: readonly string[];
  readonly providers: readonly string[];
  readonly tools: readonly AgentToolEntry[];
  readonly toolNames: readonly string[];
  readonly systemPrompt: string;
  readonly runtimeConfig: Record<string, unknown>;
}

export interface SyncAgentsOptions extends OpenLitClickHouseOptions {
  readonly repositoryRoot?: string;
}

export interface SyncAgentsResult {
  readonly totalCatalogAgents: number;
  readonly inserted: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

interface ExistingAgentRow {
  readonly agent_key: string;
  readonly service_name: string;
  readonly source: string;
}

interface ExistingVersionRow {
  readonly agent_key: string;
  readonly version_hash: string;
  readonly version_number: number;
  readonly system_prompt: string;
  readonly tools: string;
  readonly runtime_config: string;
}

interface ExecutionContractRole {
  readonly kind?: string;
  readonly readOnly?: boolean;
  readonly mcp?: readonly string[];
  readonly skills?: readonly string[];
  readonly mcpTools?: Record<string, readonly string[]>;
  readonly webResearch?: {
    readonly search?: boolean;
    readonly fetch?: boolean;
  };
}

interface ExecutionContractJson {
  readonly roles?: Record<string, ExecutionContractRole>;
  readonly providers?: Record<string, unknown>;
}

const AGENTS_SUMMARY_TABLE = "openlit_agents_summary";
const AGENT_VERSIONS_TABLE = "openlit_agent_versions";

const STALE_AGENT_ROWS: StaleRowProjection<ExistingAgentRow> = {
  versionsTable: AGENT_VERSIONS_TABLE,
  versionsKeyColumn: "agent_key",
  summaryTable: AGENTS_SUMMARY_TABLE,
  summaryKeyColumn: "agent_key",
  keyOf: (row) => row.agent_key,
  labelOf: (row) => row.service_name
};

const NUMERIC_COLLATOR = new Intl.Collator(undefined, { numeric: true });

const DEFAULT_PROVIDERS = [
  "codex",
  "claude",
  "antigravity",
  "copilot",
  "minimax"
] as const;

const DEFAULT_MODELS = [
  "gpt-4o",
  "claude-3-5-sonnet",
  "gemini-1.5-pro",
  "minimax-text-01"
] as const;

/**
 * Compute the deterministic agent_key used as primary key in OpenLIT.
 * Format: sha1(cluster|environment|service_name).slice(0, 16)
 */
export function computeAgentKey(
  clusterId: string,
  environment: string,
  serviceName: string
): string {
  const cluster = clusterId || "default";
  const env = environment || "default";
  return createHash("sha1")
    .update(`${cluster}|${env}|${serviceName}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Compute deterministic version hash from prompt, tools, and runtime config.
 */
export function computeVersionHash(
  prompt: string,
  tools: readonly AgentToolEntry[],
  runtimeConfig: Record<string, unknown>
): string {
  return createHash("sha1")
    .update(
      `${prompt}|${JSON.stringify(tools)}|${JSON.stringify(runtimeConfig)}`
    )
    .digest("hex")
    .slice(0, 16);
}

function buildAgentTools(roleData: ExecutionContractRole): AgentToolEntry[] {
  const tools: AgentToolEntry[] = [];
  if (roleData.mcpTools) {
    for (const [server, toolList] of Object.entries(roleData.mcpTools)) {
      for (const tool of toolList) {
        tools.push({ name: tool, type: "mcp", server });
      }
    }
  }
  if (roleData.skills) {
    for (const skill of roleData.skills) {
      tools.push({ name: skill, type: "skill" });
    }
  }
  if (roleData.webResearch?.search) {
    tools.push({ name: "web_search", type: "mcp", server: "web" });
  }
  if (roleData.webResearch?.fetch) {
    tools.push({ name: "fetch_web_page", type: "mcp", server: "web" });
  }
  return tools;
}

function loadRoleSystemPrompt(repositoryRoot: string, role: string): string {
  const promptPath = path.join(
    repositoryRoot,
    "agents",
    "prompts",
    "roles",
    `${role}.md`
  );
  if (existsSync(promptPath)) {
    return readFileSync(promptPath, "utf8").trim();
  }
  return "";
}

/**
 * Load all agent roles from execution contract and role prompt files.
 */
export function loadRulesyncAgents(
  repositoryRoot: string
): Map<string, RulesyncAgentData> {
  const contractPath = path.join(
    repositoryRoot,
    "config",
    "execution-contract.json"
  );
  if (!existsSync(contractPath)) {
    throw new Error(`Execution contract not found: ${contractPath}`);
  }
  const contract = JSON.parse(
    readFileSync(contractPath, "utf8")
  ) as ExecutionContractJson;
  const roles = contract.roles || {};

  const map = new Map<string, RulesyncAgentData>();
  for (const [role, roleData] of Object.entries(roles)) {
    const systemPrompt = loadRoleSystemPrompt(repositoryRoot, role);
    const tools = buildAgentTools(roleData);
    const toolNames = [...new Set(tools.map((t) => t.name))];
    const isOrchestrator = role === "orchestrator";
    const primaryModel = isOrchestrator
      ? "autodev/orchestrator"
      : "autodev/subagent";

    const runtimeConfig: Record<string, unknown> = {
      kind: roleData.kind || (isOrchestrator ? "orchestrator" : "leaf"),
      readOnly: roleData.readOnly ?? false,
      mcp: roleData.mcp || [],
      skills: roleData.skills || []
    };

    map.set(role, {
      role,
      kind: roleData.kind || (isOrchestrator ? "orchestrator" : "leaf"),
      readOnly: roleData.readOnly ?? false,
      primaryModel,
      models: DEFAULT_MODELS,
      providers: DEFAULT_PROVIDERS,
      tools,
      toolNames,
      systemPrompt,
      runtimeConfig
    });
  }

  return map;
}

/**
 * Synchronize rulesync agent roles into OpenLIT's ClickHouse tables.
 */
export async function syncRulesyncAgents(
  options: SyncAgentsOptions = {}
): Promise<SyncAgentsResult> {
  const repositoryRoot =
    options.repositoryRoot || path.resolve(import.meta.dirname, "../../..");
  const { endpoint } = resolveOpenLitClickHouseConnection(options);

  const catalog = loadRulesyncAgents(repositoryRoot);

  const existingAgents = indexRowsBy(
    await selectRows<ExistingAgentRow>(endpoint, AGENTS_SUMMARY_TABLE, [
      "agent_key",
      "service_name",
      "source"
    ]),
    (row) => row.service_name
  );
  const existingVersions = groupRowsBy(
    await selectRows<ExistingVersionRow>(endpoint, AGENT_VERSIONS_TABLE, [
      "agent_key",
      "version_hash",
      "version_number",
      "system_prompt",
      "tools",
      "runtime_config"
    ]),
    (row) => row.agent_key
  );

  const inserted: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  const summariesToInsert: Record<string, unknown>[] = [];
  const versionsToInsert: Record<string, unknown>[] = [];

  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  for (const [role, data] of catalog) {
    const agentKey = computeAgentKey("default", "default", role);
    const versionHash = computeVersionHash(
      data.systemPrompt,
      data.tools,
      data.runtimeConfig
    );
    const toolsJson = JSON.stringify(data.tools);
    const runtimeConfigJson = JSON.stringify(data.runtimeConfig);

    const existingAgent = existingAgents.get(role);
    if (existingAgent) {
      // Existing agent. Check versions.
      const versions = existingVersions.get(existingAgent.agent_key) || [];
      const latest = versions.sort((a, b) =>
        NUMERIC_COLLATOR.compare(
          String(b.version_number),
          String(a.version_number)
        )
      )[0];

      if (
        latest &&
        latest.version_hash === versionHash &&
        latest.system_prompt === data.systemPrompt
      ) {
        unchanged.push(role);
      } else {
        const nextVerNum = (latest?.version_number ?? 0) + 1;
        versionsToInsert.push({
          agent_key: existingAgent.agent_key,
          version_hash: versionHash,
          version_number: nextVerNum,
          system_prompt: data.systemPrompt,
          tools: toolsJson,
          primary_model: data.primaryModel,
          models: data.models,
          providers: data.providers,
          runtime_config: runtimeConfigJson,
          first_seen: now,
          last_seen: now,
          request_count: 0,
          updated_at: now
        });

        // Also update summary row
        summariesToInsert.push({
          agent_key: existingAgent.agent_key,
          service_name: role,
          environment: "default",
          cluster_id: "default",
          workload_key: "",
          source: "sdk",
          controller_service_id: "",
          controller_instance_id: "",
          primary_model: data.primaryModel,
          models: data.models,
          providers: data.providers,
          tool_names: data.toolNames,
          tool_count: data.toolNames.length,
          request_count_24h: 0,
          current_version_hash: versionHash,
          current_version_number: nextVerNum,
          sdk_version: "1.0.0",
          sdk_language: "typescript",
          instrumentation_status: "instrumented",
          first_seen: now,
          last_seen: now,
          updated_at: now
        });

        updated.push(role);
      }
    } else {
      // New agent
      summariesToInsert.push({
        agent_key: agentKey,
        service_name: role,
        environment: "default",
        cluster_id: "default",
        workload_key: "",
        source: "sdk",
        controller_service_id: "",
        controller_instance_id: "",
        primary_model: data.primaryModel,
        models: data.models,
        providers: data.providers,
        tool_names: data.toolNames,
        tool_count: data.toolNames.length,
        request_count_24h: 0,
        current_version_hash: versionHash,
        current_version_number: 1,
        sdk_version: "1.0.0",
        sdk_language: "typescript",
        instrumentation_status: "instrumented",
        first_seen: now,
        last_seen: now,
        updated_at: now
      });

      versionsToInsert.push({
        agent_key: agentKey,
        version_hash: versionHash,
        version_number: 1,
        system_prompt: data.systemPrompt,
        tools: toolsJson,
        primary_model: data.primaryModel,
        models: data.models,
        providers: data.providers,
        runtime_config: runtimeConfigJson,
        first_seen: now,
        last_seen: now,
        request_count: 0,
        updated_at: now
      });

      inserted.push(role);
    }
  }

  // Remove stale rulesync agents from ClickHouse if deleted from catalog
  const staleAgents = [...existingAgents.values()].filter(
    (row) => row.source === "sdk" && !catalog.has(row.service_name)
  );
  const removed = await removeStaleRows(
    endpoint,
    staleAgents,
    STALE_AGENT_ROWS
  );

  await insertRows(endpoint, AGENTS_SUMMARY_TABLE, summariesToInsert);
  await insertRows(endpoint, AGENT_VERSIONS_TABLE, versionsToInsert);

  return {
    totalCatalogAgents: catalog.size,
    inserted,
    updated,
    unchanged,
    removed
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRulesyncAgents()
    .then((result) => {
      const lines = [
        `Synchronized ${result.totalCatalogAgents} rulesync agents to AutoDev Agents Hub:`,
        `  Inserted:  ${result.inserted.length}`,
        `  Updated:   ${result.updated.length}`,
        `  Unchanged: ${result.unchanged.length}`
      ];
      if (result.removed.length > 0)
        lines.push(`  Removed:   ${result.removed.length}`);
      process.stdout.write(`${lines.join("\n")}\n`);
      process.exitCode = 0;
      return result;
    })
    .catch((error) => {
      process.stderr.write(
        `Agents synchronization failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
      return null;
    });
}
