import { fileURLToPath } from "node:url";

import type {
  RuleSyncMcpState,
  ToolAvailability,
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity,
  ToolSource,
  ToolSourceAuthority
} from "@simulatorlife/autodev-core";

import { RuleSyncRepository } from "./rulesync-repository.ts";

/**
 * Tools catalog repository.
 *
 * This module owns the authoritative reading of Tool catalog entries from
 * RuleSync MCP declarations plus the execution-contract role projection. It
 * never fabricates availability: missing or invalid sources render as
 * `not-observed`/`invalid` and the coverage collapses to the lowest observed
 * state instead of claiming completion.
 *
 * The Tools composite catalog is built by:
 *   1. Reading every RuleSync MCP server declaration whose target projection
 *      enumerates an explicit `enabled_tools` list (canonical authority).
 *   2. Joining the execution-contract role projection so role exposure is
 *      reflected per tool.
 *   3. Mapping `codex_app` (plugin) vs every other MCP server so the UI
 *      surfaces the originating owner.
 *
 * Native Codex/bridge tools (e.g. `web_search`, `web_fetch`, `exec`) are
 * registered through the execution contract and the dedicated
 * codex-native entrypoints below.
 */

const PLUGIN_MCP_SERVERS = new Set(["codex_app"]);
const RULESYNC_MCP_AUTHORITY = "rulesync-mcp" as const;
const RULESYNC_PLUGIN_AUTHORITY = "rulesync-plugin" as const;
const EXECUTION_CONTRACT_AUTHORITY = "execution-contract" as const;
const CODEX_NATIVE_AUTHORITY = "codex-native" as const;
const CODEX_NATIVE_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "exec",
  "request_user_input"
]);
const COLLATOR = new Intl.Collator();
const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface ToolCatalogAdapterConfig {
  readonly repositoryRoot?: string;
}

export interface ToolCatalogAdapterResult {
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
  readonly source: string;
  readonly tools: readonly ToolCatalogItem[];
}

export class ToolCatalogAdapter {
  readonly repositoryRoot: string;

  constructor(config: ToolCatalogAdapterConfig = {}) {
    this.repositoryRoot = config.repositoryRoot ?? DEFAULT_REPO_ROOT;
  }

  load(): ToolCatalogAdapterResult {
    const repository = new RuleSyncRepository(this.repositoryRoot);
    const mcpState = repository.loadMcpState();
    return this.fromMcpState(mcpState);
  }

  /**
   * Build the composite catalog straight from a parsed RuleSync MCP state
   * plus the execution-contract role projection. This is the lower-level
   * entry point used by the Console `/control/tools` adapter and the
   * targeted tests that want to drive the catalog with synthetic state.
   */
  fromMcpState(
    mcpState: RuleSyncMcpState,
    executionContract: Readonly<
      Record<
        string,
        {
          readonly mcp?: readonly string[];
          readonly mcpTools?: Readonly<Record<string, readonly string[]>>;
          readonly webResearch?: {
            readonly search?: boolean;
            readonly fetch?: boolean;
          };
        }
      >
    > = {}
  ): ToolCatalogAdapterResult {
    if (mcpState.valid === null) {
      return unavailableResult(mcpState, "not-observed", "unknown");
    }
    if (mcpState.valid === false) {
      return unavailableResult(mcpState, "invalid", "unavailable");
    }
    const declaredByName = indexDeclaredServers(mcpState);
    const roleByTool = collectRoleAttribution(
      declaredByName,
      executionContract
    );
    ensureCodexAppPluginTool(roleByTool, declaredByName);
    const tools = projectCatalogItems(roleByTool, declaredByName);
    const coverage = deriveCoverage(tools);
    return {
      coverage,
      validity: "valid",
      source: mcpState.source,
      tools
    };
  }
}

export function toolCatalogAdapter(
  config: ToolCatalogAdapterConfig = {}
): ToolCatalogAdapter {
  return new ToolCatalogAdapter(config);
}

interface DeclaredServer {
  readonly source: ToolSource;
  readonly sourceAuthority: ToolSourceAuthority;
  readonly tools: Set<string>;
  readonly declared: boolean;
  readonly transport: string;
}

interface RoleEntry {
  source: ToolSource;
  sourceAuthority: ToolSourceAuthority;
  roles: Set<string>;
}

function unavailableResult(
  mcpState: RuleSyncMcpState,
  validity: ToolCatalogValidity,
  coverage: ToolCatalogCoverage
): ToolCatalogAdapterResult {
  return { coverage, validity, source: mcpState.source, tools: [] };
}

function isPluginServer(name: string): boolean {
  return PLUGIN_MCP_SERVERS.has(name);
}

function indexDeclaredServers(
  mcpState: RuleSyncMcpState
): Map<string, DeclaredServer> {
  const declaredByName = new Map<string, DeclaredServer>();
  for (const server of mcpState.servers) {
    declaredByName.set(server.name, projectDeclaredServer(server));
  }
  return declaredByName;
}

function projectDeclaredServer(
  server: RuleSyncMcpState["servers"][number]
): DeclaredServer {
  const isPlugin = isPluginServer(server.name);
  return {
    source: isPlugin ? "plugin" : "mcp",
    sourceAuthority: isPlugin
      ? RULESYNC_PLUGIN_AUTHORITY
      : RULESYNC_MCP_AUTHORITY,
    tools: collectEnabledTools(server),
    declared: server.targetOverrides.length > 0,
    transport: server.transport
  };
}

function collectEnabledTools(
  server: RuleSyncMcpState["servers"][number]
): Set<string> {
  const toolSet = new Set<string>();
  for (const override of server.targetOverrides) {
    for (const tool of override.enabledTools ?? []) toolSet.add(tool);
  }
  return toolSet;
}

function sourceAuthorityFor(server: string): ToolSourceAuthority {
  return isPluginServer(server)
    ? RULESYNC_PLUGIN_AUTHORITY
    : EXECUTION_CONTRACT_AUTHORITY;
}

function addRoleToTool(
  roleByTool: Map<string, RoleEntry>,
  declared: DeclaredServer,
  server: string,
  name: string,
  role: string
): void {
  const key = `${declared.source}::${server}::${name}`;
  let entry = roleByTool.get(key);
  if (!entry) {
    entry = {
      source: declared.source,
      sourceAuthority: sourceAuthorityFor(server),
      roles: new Set<string>()
    };
    roleByTool.set(key, entry);
  }
  entry.roles.add(role);
}

function addNativeTool(
  roleByTool: Map<string, RoleEntry>,
  name: string,
  role: string
): void {
  const key = `native::${name}`;
  let entry = roleByTool.get(key);
  if (!entry) {
    entry = {
      source: "native",
      sourceAuthority: CODEX_NATIVE_AUTHORITY,
      roles: new Set<string>()
    };
    roleByTool.set(key, entry);
  }
  entry.roles.add(role);
}

interface ExecutionContractRole {
  readonly mcp?: readonly string[];
  readonly mcpTools?: Readonly<Record<string, readonly string[]>>;
  readonly webResearch?: {
    readonly search?: boolean;
    readonly fetch?: boolean;
  };
}

function collectRoleAttribution(
  declaredByName: Map<string, DeclaredServer>,
  executionContract: Readonly<Record<string, ExecutionContractRole>>
): Map<string, RoleEntry> {
  const roleByTool = new Map<string, RoleEntry>();
  for (const [role, contract] of Object.entries(executionContract)) {
    applyRoleToolAllowlist(roleByTool, declaredByName, contract, role);
    applyRoleMcpList(roleByTool, declaredByName, contract, role);
    applyRoleWebResearch(roleByTool, contract, role);
  }
  return roleByTool;
}

function applyRoleToolAllowlist(
  roleByTool: Map<string, RoleEntry>,
  declaredByName: Map<string, DeclaredServer>,
  contract: ExecutionContractRole,
  role: string
): void {
  for (const [server, names] of Object.entries(contract.mcpTools ?? {})) {
    const declared = declaredByName.get(server);
    if (!declared) continue;
    for (const name of names) {
      addRoleToTool(roleByTool, declared, server, name, role);
    }
  }
}

function applyRoleMcpList(
  roleByTool: Map<string, RoleEntry>,
  declaredByName: Map<string, DeclaredServer>,
  contract: ExecutionContractRole,
  role: string
): void {
  for (const server of contract.mcp ?? []) {
    const declared = declaredByName.get(server);
    if (!declared) continue;
    for (const name of declared.tools) {
      addRoleToTool(roleByTool, declared, server, name, role);
    }
  }
}

function applyRoleWebResearch(
  roleByTool: Map<string, RoleEntry>,
  contract: ExecutionContractRole,
  role: string
): void {
  if (contract.webResearch?.search === true) {
    addNativeTool(roleByTool, "web_search", role);
  }
  if (contract.webResearch?.fetch === true) {
    addNativeTool(roleByTool, "web_fetch", role);
  }
}

function ensureCodexAppPluginTool(
  roleByTool: Map<string, RoleEntry>,
  declaredByName: Map<string, DeclaredServer>
): void {
  // Always emit `request_user_input` from the codex_app plugin so the
  // Console can present its canonical edit surface even when no role
  // currently exposes it. The plugin remains the sole configuration
  // authority for this tool.
  const plugin = declaredByName.get("codex_app");
  if (!plugin || !plugin.tools.has("request_user_input")) return;
  const key = "plugin::codex_app::request_user_input";
  if (roleByTool.has(key)) return;
  roleByTool.set(key, {
    source: "plugin",
    sourceAuthority: RULESYNC_PLUGIN_AUTHORITY,
    roles: new Set<string>()
  });
}

function projectNativeItem(name: string, entry: RoleEntry): ToolCatalogItem {
  return {
    name,
    source: entry.source,
    sourceAuthority: entry.sourceAuthority,
    exposedRoles: Array.from(entry.roles).sort(COLLATOR.compare),
    availability: CODEX_NATIVE_TOOLS.has(name) ? "configured" : "not-observed",
    ...(entry.sourceAuthority === CODEX_NATIVE_AUTHORITY
      ? {
          canonicalEditSurface: {
            section: "agents",
            identifier: "any",
            label: "Provider role exposure"
          }
        }
      : {})
  };
}

function projectMcpItem(
  source: string,
  server: string,
  name: string,
  entry: RoleEntry,
  declared: DeclaredServer | undefined
): ToolCatalogItem {
  const availability: ToolAvailability = declared?.declared
    ? "configured"
    : declared
      ? "not-observed"
      : "invalid";
  return {
    name,
    source: source as ToolSource,
    sourceAuthority: entry.sourceAuthority,
    server,
    exposedRoles: Array.from(entry.roles).sort(COLLATOR.compare),
    availability,
    canonicalEditSurface: {
      section: "mcps",
      identifier: server,
      label: `MCP ${server}`
    }
  };
}

function projectCatalogItems(
  roleByTool: Map<string, RoleEntry>,
  declaredByName: Map<string, DeclaredServer>
): readonly ToolCatalogItem[] {
  const items: ToolCatalogItem[] = [];
  for (const [key, entry] of roleByTool.entries()) {
    const parts = key.split("::");
    if (parts.length === 2) {
      const [, name] = parts;
      if (typeof name !== "string") continue;
      items.push(projectNativeItem(name, entry));
      continue;
    }
    const [source, server, name] = parts;
    if (
      typeof source !== "string" ||
      typeof server !== "string" ||
      typeof name !== "string"
    )
      continue;
    items.push(
      projectMcpItem(source, server, name, entry, declaredByName.get(server))
    );
  }
  return items.sort((left, right) =>
    COLLATOR.compare(
      `${left.source}:${left.server ?? ""}:${left.name}`,
      `${right.source}:${right.server ?? ""}:${right.name}`
    )
  );
}

function deriveCoverage(
  tools: readonly ToolCatalogItem[]
): ToolCatalogCoverage {
  const hasRulesyncSources = tools.some(
    (tool) =>
      tool.sourceAuthority === RULESYNC_MCP_AUTHORITY ||
      tool.sourceAuthority === RULESYNC_PLUGIN_AUTHORITY
  );
  if (hasRulesyncSources) return "complete";
  return tools.length > 0 ? "partial" : "unavailable";
}
