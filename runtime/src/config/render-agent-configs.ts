import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";
import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import {
  loadSharedRolePromptParts,
  readPromptFileText
} from "@simulatorlife/autodev-runtime/shared/role-prompts";
import { parse } from "smol-toml";

import { parseArgs, requiredArg } from "./cli-args.ts";
import {
  ConfigError,
  parseTomlFile,
  serializeToml,
  type TomlTable,
  type TomlValue
} from "./config-files.ts";

export const BASE_MARKER = "{{AUTODEV_BASE_PROMPT}}";
export const LEAF_MARKER = "{{AUTODEV_LEAF_PROMPT}}";
export const CODE_SEARCH_MARKER = "{{AUTODEV_CODE_SEARCH_PROMPT}}";
export const ROLE_MARKER = "{{AUTODEV_ROLE_PROMPT}}";
// Auth-related launch keys are propagated from .rulesync/mcp.jsonc into each
// rendered role TOML so a Codex role loader that only sees `enabled = true`
// still has the full server definition (url + transport + auth). HTTP MCP
// servers use `bearer_token_env_var` (Codex-supported, mirrors the bundled
// github plugin); `http_headers` is propagated for non-bearer HTTP auth, and
// `env_http_headers` for a header whose value Codex reads from the
// environment (the spelling RuleSync gives a canonical `${VAR}` header).
const LAUNCH_KEYS = [
  "command",
  "args",
  "url",
  "bearer_token_env_var",
  "http_headers",
  "env_http_headers"
] as const;
const HTTP_URL_PATTERN = /^(http|https):\/\//;
const PROMPT_MARKER = /\{\{AUTODEV_[A-Z_]+_PROMPT\}\}/gu;

function prompt(filePath: string, label: string): string {
  try {
    return readPromptFileText(filePath, { required: true });
  } catch (error) {
    throw new ConfigError(
      `unable to read ${label} prompt ${filePath}: ${error}`
    );
  }
}

export function validateMcpServers(config: TomlTable, source: string): void {
  const servers = config.mcp_servers;
  if (!isTable(servers))
    throw new ConfigError(`${source}: mcp_servers must be a table`);
  for (const [name, server] of Object.entries(servers)) {
    if (!isTable(server))
      throw new ConfigError(`${source}: mcp_servers.${name} must be a table`);
    const stdio =
      typeof server.command === "string" &&
      !!server.command &&
      Array.isArray(server.args) &&
      server.args.length > 0;
    const http =
      typeof server.url === "string" &&
      HTTP_URL_PATTERN.test(server.url) &&
      server.transport === "streamable_http";
    if (!stdio && !http)
      throw new ConfigError(
        `${source}: mcp_servers.${name} has neither a valid stdio transport (command + args) nor a valid streamable HTTP transport (url + transport = "streamable_http")`
      );
  }
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return isRecord(value) && !(value instanceof Date);
}

/** Merge launch metadata into the parsed role; never interpret prompt text as TOML. */
function fillLaunchKeys(
  config: TomlTable,
  servers: TomlTable,
  source: string
): void {
  if (!isTable(config.mcp_servers)) {
    throw new ConfigError(`${source}: mcp_servers must be a table`);
  }
  for (const [name, role] of Object.entries(config.mcp_servers)) {
    const generated = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (!isTable(generated)) {
      throw new ConfigError(
        `${source}: mcp_servers.${name} is not declared in .rulesync/mcp.jsonc`
      );
    }
    if (!isTable(role)) {
      throw new ConfigError(`${source}: mcp_servers.${name} must be a table`);
    }
    for (const key of LAUNCH_KEYS) {
      const value = generated[key];
      if (value !== undefined && !Object.hasOwn(role, key)) role[key] = value;
    }
    if (Object.hasOwn(generated, "url") && !Object.hasOwn(role, "transport")) {
      role.transport = "streamable_http";
    }
  }
}

export function renderRole(
  source: string,
  output: string,
  promptDir: string,
  base: string,
  leaf: string,
  codeSearch: string,
  servers: TomlTable
): void {
  const text = readFileSync(source, "utf8");
  let config: TomlTable;
  try {
    config = parse(text) as TomlTable;
  } catch (error) {
    throw new ConfigError(
      `role source is invalid TOML: ${source}: ${error}`
    );
  }
  const template = config.developer_instructions;
  if (
    typeof template !== "string" ||
    [BASE_MARKER, LEAF_MARKER, ROLE_MARKER].some(
      (marker) => template.split(marker).length - 1 !== 1
    ) ||
    template.split(CODE_SEARCH_MARKER).length - 1 > 1
  ) {
    throw new ConfigError(`${source} contains invalid prompt markers`);
  }
  const prompts = new Map([
    [BASE_MARKER, base],
    [LEAF_MARKER, leaf],
    [CODE_SEARCH_MARKER, codeSearch],
    [
      ROLE_MARKER,
      prompt(
        path.join(promptDir, "roles", `${path.parse(source).name}.md`),
        path.parse(source).name
      )
    ]
  ]);
  // A single replacement pass keeps dollar sequences, backslashes, TOML
  // examples and literal marker examples in Markdown exactly as authored.
  config.developer_instructions = template.replace(PROMPT_MARKER, (marker) => {
    const replacement = prompts.get(marker);
    if (replacement === undefined) {
      throw new ConfigError(`unknown prompt marker ${marker} in ${source}`);
    }
    return replacement;
  });
  fillLaunchKeys(config, servers, source);
  validateMcpServers(config, source);
  if (
    config.model_reasoning_effort !== undefined &&
    config.model_reasoning_effort !== "none" &&
    config.model_reasoning_effort !== "high"
  )
    throw new ConfigError(
      `${source}: unsupported model_reasoning_effort '${config.model_reasoning_effort}'`
    );
  // These declarations still have semantic meaning to Runtime readers.
  // Other source comments remain in the canonical role rather than the projection.
  const policyComments = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line === "# role-access: read-only" ||
        line === "# role-kind: orchestrator"
    );
  const rendered = [...policyComments, serializeToml(config)].join("\n");
  atomicWriteSync(output, rendered, { mode: 0o644, skipUnchanged: true });
}

export function renderAgentDirectory(
  sourceDir: string,
  promptDir: string,
  outputDir: string,
  mcpSource: string
): string[] {
  const servers = parseTomlFile(mcpSource, "MCP source").mcp_servers;
  if (!isTable(servers) || Object.keys(servers).length === 0)
    throw new ConfigError(`MCP source declares no mcp_servers: ${mcpSource}`);
  let shared: { base: string; leaf: string; codeSearch: string };
  try {
    shared = loadSharedRolePromptParts(promptDir, {
      required: true
    });
  } catch (error) {
    throw new ConfigError(
      `unable to read shared prompts under ${promptDir}: ${error}`
    );
  }
  const { base, leaf, codeSearch: code } = shared;
  const sources = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".toml") && name !== "orchestrator.toml")
    .sort();
  if (sources.length === 0)
    throw new ConfigError(`no role TOML files found under ${sourceDir}`);
  for (const name of sources)
    renderRole(
      path.join(sourceDir, name),
      path.join(outputDir, name),
      promptDir,
      base,
      leaf,
      code,
      servers
    );
  return sources.map((name) => path.join(outputDir, name));
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { values } = parseArgs(process.argv.slice(2));
    const rendered = renderAgentDirectory(
      requiredArg(values, "source-dir"),
      requiredArg(values, "prompt-dir"),
      requiredArg(values, "output-dir"),
      requiredArg(values, "mcp-source")
    );
    writeLine(
      `rendered ${rendered.length} native role configs into ${requiredArg(values, "output-dir")}`
    );
  } catch (error) {
    writeErrorLine(`render-agent-configs: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
