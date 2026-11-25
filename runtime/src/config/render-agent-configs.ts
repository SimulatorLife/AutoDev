import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
  tomlValue,
  type TomlTable
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
const TABLE = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm;

function prompt(filePath: string, label: string): string {
  try {
    return readPromptFileText(filePath, {
      required: true,
      disallowTomlDelimiter: true
    });
  } catch (error) {
    throw new ConfigError(
      `unable to read ${label} prompt ${filePath}: ${error}`
    );
  }
}

export function validateMcpServers(config: TomlTable, source: string): void {
  const servers = config.mcp_servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw new ConfigError(`${source}: mcp_servers must be a table`);
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ConfigError(`${source}: mcp_servers.${name} must be a table`);
    const server = raw as TomlTable;
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

export function fillLaunchKeys(
  text: string,
  servers: TomlTable,
  source: string
): string {
  const roleServers = parseTomlFileText(text).mcp_servers;
  return text.replaceAll(
    TABLE,
    (header, quoted: string | undefined, bare: string | undefined) => {
      const name = quoted ?? bare ?? "";
      const generated = servers[name];
      if (
        !generated ||
        typeof generated !== "object" ||
        Array.isArray(generated)
      )
        throw new ConfigError(
          `${source}: mcp_servers.${name} is not declared in .rulesync/mcp.jsonc`
        );
      const roleValue =
        roleServers &&
        typeof roleServers === "object" &&
        !Array.isArray(roleServers) &&
        !(roleServers instanceof Date)
          ? (roleServers as TomlTable)[name]
          : undefined;
      const role =
        roleValue && typeof roleValue === "object" && !Array.isArray(roleValue)
          ? (roleValue as TomlTable)
          : {};
      const generatedTable = generated as TomlTable;
      const lines: string[] = [];
      for (const key of LAUNCH_KEYS) {
        const value = generatedTable[key];
        if (value !== undefined && !Object.hasOwn(role, key))
          lines.push(`${key} = ${tomlValue(value)}`);
      }
      if ("url" in generated && !("transport" in role))
        lines.push('transport = "streamable_http"');
      return [header, ...lines].join("\n");
    }
  );
}

function parseTomlFileText(text: string): TomlTable {
  return parse(text) as TomlTable;
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
  let text = readFileSync(source, "utf8");
  if (
    [BASE_MARKER, LEAF_MARKER, ROLE_MARKER].some(
      (marker) => text.split(marker).length - 1 !== 1
    ) ||
    text.split(CODE_SEARCH_MARKER).length - 1 > 1
  )
    throw new ConfigError(`${source} contains invalid prompt markers`);
  text = text
    .replace(BASE_MARKER, base)
    .replace(LEAF_MARKER, leaf)
    .replace(CODE_SEARCH_MARKER, codeSearch)
    .replace(
      ROLE_MARKER,
      prompt(
        path.join(promptDir, "roles", `${path.parse(source).name}.md`),
        path.parse(source).name
      )
    );
  if (
    [BASE_MARKER, LEAF_MARKER, CODE_SEARCH_MARKER, ROLE_MARKER].some((marker) =>
      text.includes(marker)
    )
  )
    throw new ConfigError(`unrendered prompt marker remains in ${source}`);
  text = fillLaunchKeys(text, servers, source);
  let config: TomlTable;
  try {
    config = parseTomlFileText(text);
  } catch (error) {
    throw new ConfigError(
      `rendered role config is invalid TOML: ${source}: ${error}`
    );
  }
  validateMcpServers(config, source);
  if (
    config.model_reasoning_effort !== undefined &&
    config.model_reasoning_effort !== "none" &&
    config.model_reasoning_effort !== "high"
  )
    throw new ConfigError(
      `${source}: unsupported model_reasoning_effort '${config.model_reasoning_effort}'`
    );
  atomicWriteSync(output, text, { mode: 0o644, skipUnchanged: true });
}

export function renderAgentDirectory(
  sourceDir: string,
  promptDir: string,
  outputDir: string,
  mcpSource: string
): string[] {
  const servers = parseTomlFile(mcpSource, "MCP source").mcp_servers;
  if (
    !servers ||
    typeof servers !== "object" ||
    Array.isArray(servers) ||
    Object.keys(servers).length === 0
  )
    throw new ConfigError(`MCP source declares no mcp_servers: ${mcpSource}`);
  let shared: { base: string; leaf: string; codeSearch: string };
  try {
    shared = loadSharedRolePromptParts(promptDir, {
      required: true,
      disallowTomlDelimiter: true
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
      servers as TomlTable
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
