import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function fetchExistingAgents(
  endpoint: string
): Promise<Map<string, ExistingAgentRow>> {
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "SELECT agent_key, service_name, source FROM openlit_agents_summary FORMAT JSON"
    )}`,
    { method: "GET" }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to query openlit_agents_summary from ClickHouse (${res.status}): ${errText}`
    );
  }
  const json = (await res.json()) as { data?: ExistingAgentRow[] };
  const map = new Map<string, ExistingAgentRow>();
  for (const row of json.data || []) {
    map.set(row.service_name, row);
  }
  return map;
}

async function fetchExistingVersions(
  endpoint: string
): Promise<Map<string, ExistingVersionRow[]>> {
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "SELECT agent_key, version_hash, version_number, system_prompt, tools, runtime_config FROM openlit_agent_versions FORMAT JSON"
    )}`,
    { method: "GET" }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to query openlit_agent_versions from ClickHouse (${res.status}): ${errText}`
    );
  }
  const json = (await res.json()) as { data?: ExistingVersionRow[] };
  const map = new Map<string, ExistingVersionRow[]>();
  for (const row of json.data || []) {
    const list = map.get(row.agent_key) || [];
    list.push(row);
    map.set(row.agent_key, list);
  }
  return map;
}

async function removeStaleAgents(
  endpoint: string,
  staleRows: ExistingAgentRow[]
): Promise<string[]> {
  if (staleRows.length === 0) return [];
  const keys = staleRows.map((r) => `'${r.agent_key}'`).join(", ");
  await fetch(
    `${endpoint}&query=${encodeURIComponent(
      `ALTER TABLE openlit_agent_versions DELETE WHERE agent_key IN (${keys})`
    )}`,
    { method: "POST" }
  );
  await fetch(
    `${endpoint}&query=${encodeURIComponent(
      `ALTER TABLE openlit_agents_summary DELETE WHERE agent_key IN (${keys})`
    )}`,
    { method: "POST" }
  );
  return staleRows.map((r) => r.service_name);
}

async function bulkInsertSummaries(
  endpoint: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "INSERT INTO openlit_agents_summary FORMAT JSONEachRow"
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to bulk insert into openlit_agents_summary: ${await res.text()}`
    );
  }
}

async function bulkInsertVersions(
  endpoint: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      "INSERT INTO openlit_agent_versions FORMAT JSONEachRow"
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to bulk insert into openlit_agent_versions: ${await res.text()}`
    );
  }
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

  const existingAgents = await fetchExistingAgents(endpoint);
  const existingVersions = await fetchExistingVersions(endpoint);

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
  const removed = await removeStaleAgents(endpoint, staleAgents);

  await bulkInsertSummaries(endpoint, summariesToInsert);
  await bulkInsertVersions(endpoint, versionsToInsert);

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
