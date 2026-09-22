import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { writeErrorLine, writeLine } from "../shared/output.ts";
import {
  atomicWriteJson,
  ConfigError,
  parseArgs,
  readJsonFile,
  requiredArg
} from "./toml.ts";

const MCP_ORDER: Record<string, number> = {
  lsp: 0,
  "cocoindex-code": 1,
  playwright: 2,
  openaiDeveloperDocs: 3,
  context7: 4,
  autodev_spawn: 5,
  codex_app: 6
};
// MCPs whose existence is owned by Codex Desktop plugins rather than the
// rulesync-generated Codex CLI catalog. They appear in the projection so
// `fillLaunchKeys` can resolve launch keys for role TOMLs, but their
// `enabled = false` flag keeps Codex CLI from launching them. The orchestrator
// role can declare them without the renderer's root-config check complaining.
const PLUGIN_MCPS = new Set(["codex_app"]);
const SKILL_ORDER: Record<string, number> = {
  orchestration: 0,
  ccc: 1,
  "lsp-mcp-server": 2,
  "code-simplification": 3,
  "diagnosing-bugs": 4,
  "improve-codebase-architecture": 5,
  "opentelemetry": 6,
  "remove-legacy-shims": 7,
  "resolve-merge-conflicts": 8,
  "doubt-driven-development": 9,
  "writing-agent-skills": 10,
  "autodev-codex-request-capture": 11,
  "autodev-session-diagnostics": 12
};
const ROLE_FILE_EXTENSION = /\.toml$/u;
const collator = new Intl.Collator();
const RESEARCH_ROLES = new Set(["docs-researcher", "smart", "orchestrator"]);
const DELEGATION_MODES = new Set([
  "native",
  "codex-shim",
  "bridge-native",
  "none"
]);

export function validateProviderContracts(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("execution contract providers must be an object");
  }
  const providers = record(value);
  for (const [name, raw] of Object.entries(providers)) {
    const provider = record(raw);
    const delegation = provider.delegation;
    if (typeof delegation !== "string" || !DELEGATION_MODES.has(delegation)) {
      throw new ConfigError(
        `provider '${name}' must declare delegation as one of: ${[...DELEGATION_MODES].join(", ")}`
      );
    }
    if (
      !Array.isArray(provider.spawnTools) ||
      provider.spawnTools.some(
        (tool) => typeof tool !== "string" || !tool.trim()
      )
    ) {
      throw new ConfigError(
        `provider '${name}' must declare spawnTools as an array of non-empty strings`
      );
    }
    if (delegation === "none" && provider.spawnTools.length > 0) {
      throw new ConfigError(
        `provider '${name}' cannot declare spawnTools when delegation is none`
      );
    }
  }
  return providers;
}

type UnknownRecord = Record<string, unknown>;
type RoleProjection = {
  kind: "leaf" | "orchestrator";
  readOnly: boolean;
  mcp: string[];
  skills: string[];
  mcpTools?: Record<string, string[]>;
  webResearch?: { search: true; fetch: true; optionalMcp: string[] };
};

type ExecutionContract = {
  version: number;
  roles: Record<string, RoleProjection>;
  providers: unknown;
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sortedByOrder(
  values: string[],
  order: Record<string, number>
): string[] {
  return [...values].sort(
    (a, b) => (order[a] ?? 99) - (order[b] ?? 99) || collator.compare(a, b)
  );
}

function readRole(source: string): RoleProjection {
  const text = readFileSync(source, "utf8");
  const config = record(parseToml(text));
  const servers = record(config.mcp_servers);
  const enabledServers = Object.entries(servers).filter(
    ([, value]) => record(value).enabled === true
  );
  const mcp = sortedByOrder(
    enabledServers.map(([name]) => name),
    MCP_ORDER
  );
  const mcpTools: Record<string, string[]> = {};
  for (const [name, value] of enabledServers) {
    const tools = stringArray(record(value).enabled_tools);
    if (tools.length > 0) mcpTools[name] = tools;
  }

  const skillsTable = record(config.skills);
  const skills = Array.isArray(skillsTable.config)
    ? skillsTable.config
        .map((entry) => record(entry))
        .filter(
          (entry) => entry.enabled === true && typeof entry.name === "string"
        )
        .map((entry) => entry.name as string)
    : [];

  const tools = config.tools;
  let webResearch: RoleProjection["webResearch"];
  if (tools !== undefined) {
    const toolConfig = record(tools);
    if (tools === null || typeof tools !== "object" || Array.isArray(tools))
      throw new ConfigError(`${source}: tools must be a table`);
    if (
      toolConfig.web_search !== undefined &&
      typeof toolConfig.web_search !== "boolean"
    )
      throw new ConfigError(`${source}: tools.web_search must be boolean`);
    if (toolConfig.web_search === true)
      webResearch = { search: true, fetch: true, optionalMcp: [] };
  }

  const roleName =
    source.split("/").pop()?.replace(ROLE_FILE_EXTENSION, "") ?? "";
  const kind = text
    .split("\n")
    .some((line) => line.trim() === "# role-kind: orchestrator")
    ? "orchestrator"
    : "leaf";
  const projection: RoleProjection = {
    kind,
    readOnly: config.sandbox_mode === "read-only",
    mcp,
    skills: sortedByOrder(skills, SKILL_ORDER)
  };
  if (Object.keys(mcpTools).length > 0) projection.mcpTools = mcpTools;
  if (webResearch) {
    if (roleName === "smart") webResearch.optionalMcp = ["playwright"];
    projection.webResearch = webResearch;
  }
  return projection;
}

export function renderExecutionContract(
  sourceDir: string,
  rootConfigPath: string,
  contractPath: string
): ExecutionContract {
  const template = readJsonFile(contractPath, "execution contract");
  const roles: Record<string, RoleProjection> = {};
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith(".toml"))
    .sort((a, b) => collator.compare(a.name, b.name))) {
    roles[entry.name.slice(0, -".toml".length)] = readRole(
      path.join(sourceDir, entry.name)
    );
  }

  for (const roleName of RESEARCH_ROLES) {
    const webResearch = roles[roleName]?.webResearch;
    if (!webResearch?.search || !webResearch.fetch)
      throw new ConfigError(
        `role '${roleName}' must declare webResearch with search and fetch enabled`
      );
  }
  if (!roles.orchestrator)
    throw new ConfigError(
      "role TOMLs must include the orchestrator capability declaration"
    );

  const rootConfig = record(parseToml(readFileSync(rootConfigPath, "utf8")));
  const rootServers = record(rootConfig.mcp_servers);
  const enabledRootMcp = new Set(
    Object.entries(rootServers)
      .filter(([, value]) => record(value).enabled !== false)
      .map(([name]) => name)
  );
  const missingRootMcp = roles.orchestrator.mcp.filter(
    (name) =>
      name !== "autodev_spawn" &&
      !PLUGIN_MCPS.has(name) &&
      !enabledRootMcp.has(name)
  );
  if (missingRootMcp.length > 0)
    throw new ConfigError(
      `orchestrator capability TOML is not enabled in root config: ${missingRootMcp.sort().join(", ")}`
    );

  return {
    version: typeof template.version === "number" ? template.version : 1,
    roles,
    providers: validateProviderContracts(template.providers)
  };
}

export function runExecutionContract(
  sourceDir: string,
  rootConfigPath: string,
  contractPath: string,
  output: string
): number {
  atomicWriteJson(
    output,
    renderExecutionContract(sourceDir, rootConfigPath, contractPath)
  );
  writeLine(`rendered execution contract into ${output}`);
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const { values } = parseArgs(process.argv.slice(2));
    process.exitCode = runExecutionContract(
      requiredArg(values, "source-dir"),
      requiredArg(values, "root-config"),
      requiredArg(values, "contract"),
      requiredArg(values, "output")
    );
  } catch (error) {
    writeErrorLine(
      `render-execution-contract: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 2;
  }
}
