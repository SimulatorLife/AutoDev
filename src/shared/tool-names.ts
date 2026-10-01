#!/usr/bin/env node

/**
 * The one owner of canonical AutoDev tool names.
 *
 * Every identifier a model can reach on the Codex code-mode `tools` global
 * follows `<namespace>__<tool>` with snake_case segments and a double-underscore
 * separator. The family is:
 *
 *   - `<namespace>__<tool>`              -- snake_case, double underscore
 *   - `<namespace>` is a stable snake_case identifier (e.g. `multi_agent_v1`,
 *     `mcp`, `autodev_spawn`)
 *   - `<tool>` is the bare tool name the server returns (also snake_case)
 *
 * Bridges, hooks, MCP launchers, the Codex code-mode shim, and tests all read
 * these constants rather than writing the literal strings. That keeps the
 * surface uniform across every model provider and gives us one place to
 * update when a tool is renamed.
 *
 * CLI-required exceptions are documented at the bottom of this file. They are
 * PascalCase / lowercase names that the upstream CLI fixes and that the
 * bridge translates into the canonical names below; do not adopt their
 * style for a new AutoDev tool.
 */

import { writeErrorLine, writeLine } from "./output.ts";

// ---------------------------------------------------------------------------
// Codex code-mode meta-tool. The runtime delivers every other tool through
// this one; the model writes raw JavaScript that runs in a V8 isolate where
// the rest of the surface hangs off the `tools` global.
// ---------------------------------------------------------------------------

/** The Codex code-mode meta-tool. Plain `exec`, no namespace. */
export const EXEC_TOOL = "exec" as const;

// ---------------------------------------------------------------------------
// Multi-agent delegation. Hangs off `tools.multi_agent_v1__*` in code mode.
// ---------------------------------------------------------------------------

/** Namespace prefix for the multi-agent delegation surface. Versioned. */
export const MULTI_AGENT_NAMESPACE = "multi_agent_v1" as const;

/** Build a canonical multi-agent tool name from the suffix. */
export function multiAgentToolName(suffix: string): string {
  return `${MULTI_AGENT_NAMESPACE}__${suffix}`;
}

/** Spawn a child agent. */
export const MULTI_AGENT_SPAWN_TOOL = multiAgentToolName("spawn_agent");

/** Wait for one or more child threads to reach a terminal state. */
export const MULTI_AGENT_WAIT_TOOL = multiAgentToolName("wait_agent");

/** Close a terminal child thread. */
export const MULTI_AGENT_CLOSE_TOOL = multiAgentToolName("close_agent");

/** Resume a suspended child thread. */
export const MULTI_AGENT_RESUME_TOOL = multiAgentToolName("resume_agent");

/** Send a follow-up message into a running child thread. */
export const MULTI_AGENT_SEND_INPUT_TOOL = multiAgentToolName("send_input");

// ---------------------------------------------------------------------------
// MCP tools. Codex prefixes every MCP tool with `mcp__<server>__`; the bare
// `<server>__<tool>` form below is what bridges and tests reference before
// the prefix is added.
// ---------------------------------------------------------------------------

/** Namespace prefix Codex adds to every MCP tool name. */
export const MCP_NAMESPACE = "mcp" as const;

/** Build the canonical MCP tool name from server and bare tool name. */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_NAMESPACE}__${server}__${tool}`;
}

// ---------------------------------------------------------------------------
// AutoDev-owned MCP servers. Each entry is the server's bare name; tools
// living under it are referenced as `mcp__<server>__<tool>`.
// ---------------------------------------------------------------------------

export const MCP_SERVER_LSP = "lsp" as const;
export const MCP_SERVER_COCOINDEX = "cocoindex-code" as const;
export const MCP_SERVER_CODEGRAPHCONTEXT = "codegraphcontext" as const;
export const MCP_SERVER_PLAYWRIGHT = "playwright" as const;
export const MCP_SERVER_OPENAI_DEVELOPER_DOCS = "openaiDeveloperDocs" as const;
export const MCP_SERVER_CONTEXT7 = "context7" as const;

/**
 * Bridge-injected spawn shim attached by provider CLI bridges (Copilot,
 * Antigravity) to their subprocess. Not a Codex-level MCP server: it has no
 * entry in `$CODEX_HOME/config.toml` and `run-autodev-mcp.sh` rejects it by
 * name. The shim's own declared tool name is `spawn_subagent`; the model sees
 * it as `mcp__autodev_spawn__spawn_subagent`.
 */
export const MCP_SERVER_AUTODEV_SPAWN = "autodev_spawn" as const;
export const AUTODEV_SPAWN_BARE_TOOL = "spawn_subagent" as const;
export const AUTODEV_SPAWN_TOOL = mcpToolName(
  MCP_SERVER_AUTODEV_SPAWN,
  AUTODEV_SPAWN_BARE_TOOL
);

/**
 * Codex App tools live behind the codex-app-tools plugin and are surfaced to
 * the model as a plugin-provided MCP server, not through the rulesync catalog.
 * The orchestrator role gates this server to a single tool.
 */
export const MCP_SERVER_CODEX_APP = "codex_app" as const;
export const CODEX_APP_REQUEST_USER_INPUT_TOOL = "request_user_input" as const;

// ---------------------------------------------------------------------------
// Codex-native web research tools. These reach the Codex Responses catalog,
// not an MCP server.
// ---------------------------------------------------------------------------

/** Codex's hosted web search. */
export const WEB_SEARCH_TOOL = "web_search" as const;

/** Codex's hosted web fetch. */
export const WEB_FETCH_TOOL = "web_fetch" as const;

// ---------------------------------------------------------------------------
// Naming convention enforcement.
// ---------------------------------------------------------------------------

/**
 * The regex that matches every multi-segment canonical AutoDev tool name.
 *
 *   `multi_agent_v1__<bare>`     -- multi-agent delegation surface
 *   `mcp__<server>__<bare>`      -- MCP tools; the server segment is
 *                                   snake_case OR the documented
 *                                   openaiDeveloperDocs camelCase that already
 *                                   ships in `.rulesync/mcp.jsonc`; the bare
 *                                   tool suffix is always snake_case.
 *
 * Single-segment canonical names (`exec`, `web_search`, `web_fetch`,
 * `request_user_input`) are NOT matched by the regex on purpose: a namespace
 * prefix such as `multi_agent_v1` looks syntactically like a single-segment
 * snake_case string, and the only way to distinguish a real tool name from a
 * namespace prefix is membership in `CANONICAL_SINGLE_SEGMENT_NAMES`. The
 * audit (`auditToolNames`) is the public surface; the regex is the lower-level
 * check for multi-segment names only.
 *
 * `<bare>` is `[a-z][a-z0-9_]*`. `<server>` is `[a-z][a-zA-Z0-9_-]*` to allow
 * the historical `openaiDeveloperDocs` server name. PascalCase, lowercase
 * bash-style names, and unrelated mixed forms do not match; they belong in
 * one of the documented CLI exception sets.
 */
export const CANONICAL_TOOL_NAME_PATTERN =
  /^(?:multi_agent_v1__[a-z][a-z0-9_]*|mcp__[a-z][a-zA-Z0-9_-]*__[a-z][a-z0-9_]*)$/;

// The set of single-segment snake_case names that ARE canonical. A future
// audit may add to this; the CLI exception set stays in the documented
// exception maps so single-segment strings like `bash` and `search_web`
// remain unambiguously exceptions rather than canonical.
const CANONICAL_SINGLE_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  EXEC_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  CODEX_APP_REQUEST_USER_INPUT_TOOL
]);

/**
 * True if `name` matches the canonical AutoDev tool-name convention.
 *
 * Multi-segment names (e.g. `multi_agent_v1__spawn_agent`,
 * `mcp__lsp__lsp_goto_definition`) are checked against the canonical regex.
 * Single-segment names (e.g. `exec`, `web_search`) are checked against the
 * explicit canonical set; the regex alone would also match namespace prefixes
 * like `multi_agent_v1`, so the regex is reserved for unambiguous forms.
 */
export function isCanonicalToolName(name: string): boolean {
  return (
    CANONICAL_SINGLE_SEGMENT_NAMES.has(name) ||
    CANONICAL_TOOL_NAME_PATTERN.test(name)
  );
}

// ---------------------------------------------------------------------------
// CLI-required exceptions. These are upstream CLI tool names that the bridge
// translates into canonical AutoDev names; they are documented here so a
// future reader knows they are intentional, not a violation of the convention.
// ---------------------------------------------------------------------------

/**
 * Claude CLI native tools. PascalCase is fixed by the Claude CLI; renaming
 * would break every recorded Claude turn. The Claude bridge keeps them and
 * translates them into the canonical Codex surface on the way out.
 */
export const CLAUDE_NATIVE_TOOL_EXCEPTIONS = {
  webSearch: "WebSearch",
  webFetch: "WebFetch",
  agent: "Agent"
} as const;

/**
 * Antigravity CLI native tools. `search_web` and `read_url_content` are
 * Antigravity's web-research tool names; the bridge exposes Codex's
 * `web_search` / `web_fetch` to the model. `bash`, `read_file`, `write_file`,
 * `edit_file`, `glob`, `grep` and the others are Antigravity's local file
 * system tools; the bridge translates them into Codex's `exec_command` and
 * the role's MCP tools.
 */
export const ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS = {
  searchWeb: "search_web",
  readUrlContent: "read_url_content",
  bash: "bash",
  readFile: "read_file",
  writeFile: "write_file",
  editFile: "edit_file",
  glob: "glob",
  grep: "grep",
  invokeSubagent: "invoke_subagent"
} as const;

/**
 * Copilot CLI native tools. The bridge translates `bash`/`shell`/`execute`
 * into Codex's `exec_command` and passes through Codex-shaped MCP tools.
 */
export const COPILOT_NATIVE_TOOL_EXCEPTIONS = {
  bash: "bash",
  shell: "shell",
  execute: "execute"
} as const;

/** Flat set of every documented CLI exception. */
export const ALL_DOCUMENTED_EXCEPTIONS: ReadonlySet<string> = new Set([
  ...Object.values(CLAUDE_NATIVE_TOOL_EXCEPTIONS),
  ...Object.values(ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS),
  ...Object.values(COPILOT_NATIVE_TOOL_EXCEPTIONS)
]);

// ---------------------------------------------------------------------------
// Audit helper used by the consistency test in tests/shared/tool-names.test.ts.
// ---------------------------------------------------------------------------

export interface ToolNameAuditReport {
  canonical: string[];
  exceptions: { provider: string; tool: string }[];
  unrecognised: string[];
}

export function auditToolNames(names: readonly string[]): ToolNameAuditReport {
  const canonical: string[] = [];
  const exceptions: { provider: string; tool: string }[] = [];
  const unrecognised: string[] = [];
  for (const name of names) {
    if (ALL_DOCUMENTED_EXCEPTIONS.has(name))
      exceptions.push({
        provider: exceptionProvider(name),
        tool: name
      });
    else if (
      CANONICAL_SINGLE_SEGMENT_NAMES.has(name) ||
      CANONICAL_TOOL_NAME_PATTERN.test(name)
    )
      canonical.push(name);
    else unrecognised.push(name);
  }
  return { canonical, exceptions, unrecognised };
}

function exceptionProvider(name: string): string {
  for (const [k, v] of Object.entries(CLAUDE_NATIVE_TOOL_EXCEPTIONS))
    if (v === name) return `claude:${k}`;
  for (const [k, v] of Object.entries(ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS))
    if (v === name) return `antigravity:${k}`;
  for (const [k, v] of Object.entries(COPILOT_NATIVE_TOOL_EXCEPTIONS))
    if (v === name) return `copilot:${k}`;
  return "unknown";
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv[2] === "--check") {
    const target = process.argv[3];
    if (!target) {
      writeErrorLine("tool-names: --check <path-to-source-file>");
      process.exitCode = 2;
    } else {
      import("node:fs").then(({ readFileSync }) => {
        const text = readFileSync(target, "utf8");
        const matches = text.match(/"([a-zA-Z][a-zA-Z0-9_]*)"/g) ?? [];
        const candidates = Array.from(
          new Set(matches.map((m) => m.slice(1, -1)))
        ).filter(
          (name) =>
            name.length >= 3 &&
            !name.includes("-") &&
            !name.startsWith("x-") &&
            name !== "undefined" &&
            name !== "null"
        );
        const audit = auditToolNames(candidates);
        writeLine(
          `tool-names: ${audit.canonical.length} canonical, ${audit.exceptions.length} documented CLI exceptions, ${audit.unrecognised.length} unrecognised.`
        );
        if (audit.unrecognised.length > 0) {
          writeErrorLine(
            `tool-names: unrecognised: ${audit.unrecognised.slice(0, 20).join(", ")}`
          );
        }
      });
    }
  } else {
    writeLine(
      [
        `Canonical Codex code-mode tools (snake_case, ${MULTI_AGENT_NAMESPACE}__<tool>, mcp__<server>__<tool>):`,
        `  exec                          ${EXEC_TOOL}`,
        `  ${MULTI_AGENT_NAMESPACE}__spawn_agent     ${MULTI_AGENT_SPAWN_TOOL}`,
        `  ${MULTI_AGENT_NAMESPACE}__wait_agent      ${MULTI_AGENT_WAIT_TOOL}`,
        `  ${MULTI_AGENT_NAMESPACE}__close_agent     ${MULTI_AGENT_CLOSE_TOOL}`,
        `  ${MULTI_AGENT_NAMESPACE}__resume_agent    ${MULTI_AGENT_RESUME_TOOL}`,
        `  ${MULTI_AGENT_NAMESPACE}__send_input      ${MULTI_AGENT_SEND_INPUT_TOOL}`,
        `  web_search                    ${WEB_SEARCH_TOOL}`,
        `  web_fetch                     ${WEB_FETCH_TOOL}`,
        `  request_user_input            ${CODEX_APP_REQUEST_USER_INPUT_TOOL}`,
        `  mcp__<server>__<tool>         (mcpToolName(server, tool))`,
        `  mcp__autodev_spawn__spawn_subagent  ${AUTODEV_SPAWN_TOOL}`
      ].join("\n")
    );
  }
}
