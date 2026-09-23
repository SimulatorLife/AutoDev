import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ALL_DOCUMENTED_EXCEPTIONS,
  ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS,
  AUTODEV_SPAWN_TOOL,
  CLAUDE_NATIVE_TOOL_EXCEPTIONS,
  COPILOT_NATIVE_TOOL_EXCEPTIONS,
  EXEC_TOOL,
  MCP_NAMESPACE,
  MCP_SERVER_AUTODEV_SPAWN,
  MULTI_AGENT_CLOSE_TOOL,
  MULTI_AGENT_NAMESPACE,
  MULTI_AGENT_RESUME_TOOL,
  MULTI_AGENT_SEND_INPUT_TOOL,
  MULTI_AGENT_SPAWN_TOOL,
  MULTI_AGENT_WAIT_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  auditToolNames,
  CANONICAL_TOOL_NAME_PATTERN,
  CODEX_APP_REQUEST_USER_INPUT_TOOL,
  isCanonicalToolName,
  MCP_SERVER_LSP,
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_PLAYWRIGHT,
  MCP_SERVER_OPENAI_DEVELOPER_DOCS,
  MCP_SERVER_CONTEXT7,
  MCP_SERVER_CODEX_APP,
  mcpToolName,
  multiAgentToolName
} from "../../src/shared/tool-names.ts";

test("canonical Codex code-mode tool names are pinned", () => {
  assert.equal(EXEC_TOOL, "exec");
  assert.equal(MULTI_AGENT_SPAWN_TOOL, "multi_agent_v1__spawn_agent");
  assert.equal(MULTI_AGENT_WAIT_TOOL, "multi_agent_v1__wait_agent");
  assert.equal(MULTI_AGENT_CLOSE_TOOL, "multi_agent_v1__close_agent");
  assert.equal(MULTI_AGENT_RESUME_TOOL, "multi_agent_v1__resume_agent");
  assert.equal(MULTI_AGENT_SEND_INPUT_TOOL, "multi_agent_v1__send_input");
  assert.equal(WEB_SEARCH_TOOL, "web_search");
  assert.equal(WEB_FETCH_TOOL, "web_fetch");
  assert.equal(CODEX_APP_REQUEST_USER_INPUT_TOOL, "request_user_input");
});

test("MCP server names and the bridge-injected spawn shim are pinned", () => {
  assert.equal(MCP_NAMESPACE, "mcp");
  assert.equal(MCP_SERVER_LSP, "lsp");
  assert.equal(MCP_SERVER_COCOINDEX, "cocoindex-code");
  assert.equal(MCP_SERVER_PLAYWRIGHT, "playwright");
  assert.equal(MCP_SERVER_OPENAI_DEVELOPER_DOCS, "openaiDeveloperDocs");
  assert.equal(MCP_SERVER_CONTEXT7, "context7");
  assert.equal(MCP_SERVER_CODEX_APP, "codex_app");
  assert.equal(MCP_SERVER_AUTODEV_SPAWN, "autodev_spawn");
  assert.equal(AUTODEV_SPAWN_TOOL, "mcp__autodev_spawn__spawn_subagent");
});

test("multiAgentToolName and mcpToolName produce the documented form", () => {
  assert.equal(
    multiAgentToolName("spawn_agent"),
    "multi_agent_v1__spawn_agent"
  );
  assert.equal(
    mcpToolName("lsp", "lsp_goto_definition"),
    "mcp__lsp__lsp_goto_definition"
  );
  assert.equal(
    mcpToolName("autodev_spawn", "spawn_subagent"),
    "mcp__autodev_spawn__spawn_subagent"
  );
});

test("every canonical name passes the membership check", () => {
  for (const name of [
    EXEC_TOOL,
    MULTI_AGENT_SPAWN_TOOL,
    MULTI_AGENT_WAIT_TOOL,
    MULTI_AGENT_CLOSE_TOOL,
    MULTI_AGENT_RESUME_TOOL,
    MULTI_AGENT_SEND_INPUT_TOOL,
    WEB_SEARCH_TOOL,
    WEB_FETCH_TOOL,
    CODEX_APP_REQUEST_USER_INPUT_TOOL,
    AUTODEV_SPAWN_TOOL,
    "mcp__lsp__lsp_goto_definition",
    "mcp__cocoindex-code__search",
    "mcp__playwright__browser_navigate",
    "mcp__openaiDeveloperDocs__search_docs",
    "mcp__context7__resolve_library"
  ]) {
    assert.ok(
      isCanonicalToolName(name),
      `${name} should be a canonical tool name`
    );
  }
});

test("the regex matches every multi-segment canonical name", () => {
  for (const name of [
    MULTI_AGENT_SPAWN_TOOL,
    MULTI_AGENT_WAIT_TOOL,
    MULTI_AGENT_CLOSE_TOOL,
    MULTI_AGENT_RESUME_TOOL,
    MULTI_AGENT_SEND_INPUT_TOOL,
    AUTODEV_SPAWN_TOOL,
    "mcp__lsp__lsp_goto_definition",
    "mcp__cocoindex-code__search",
    "mcp__playwright__browser_navigate",
    "mcp__openaiDeveloperDocs__search_docs",
    "mcp__context7__resolve_library"
  ]) {
    assert.match(name, CANONICAL_TOOL_NAME_PATTERN);
  }
});

test("the regex rejects PascalCase, lowercase, and mixed case", () => {
  for (const bad of [
    "WebSearch",
    "WebFetch",
    "Agent",
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "MultiAgent",
    "spawnAgent",
    "MULTI_AGENT_SPAWN_AGENT",
    "multi_agent_v1",
    "mcp__LSP__lsp_goto_definition",
    "Mcp__lsp__lsp_goto_definition",
    "mcp__lsp__LspGotoDefinition"
  ]) {
    assert.ok(
      !isCanonicalToolName(bad),
      `${bad} must not match the canonical pattern`
    );
  }
});

test("every CLI exception is documented and lives in the right family", () => {
  for (const v of Object.values(CLAUDE_NATIVE_TOOL_EXCEPTIONS)) {
    assert.ok(!isCanonicalToolName(v), `${v} should NOT match canonical`);
    assert.ok(ALL_DOCUMENTED_EXCEPTIONS.has(v), `${v} must be documented`);
  }
  for (const v of Object.values(ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS)) {
    assert.ok(!isCanonicalToolName(v), `${v} should NOT match canonical`);
    assert.ok(ALL_DOCUMENTED_EXCEPTIONS.has(v), `${v} must be documented`);
  }
  for (const v of Object.values(COPILOT_NATIVE_TOOL_EXCEPTIONS)) {
    assert.ok(!isCanonicalToolName(v), `${v} should NOT match canonical`);
    assert.ok(ALL_DOCUMENTED_EXCEPTIONS.has(v), `${v} must be documented`);
  }
});

test("the audit classifier routes names to the right bucket", () => {
  const audit = auditToolNames([
    EXEC_TOOL,
    MULTI_AGENT_SPAWN_TOOL,
    AUTODEV_SPAWN_TOOL,
    WEB_SEARCH_TOOL,
    CLAUDE_NATIVE_TOOL_EXCEPTIONS.webSearch,
    ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS.searchWeb,
    COPILOT_NATIVE_TOOL_EXCEPTIONS.bash,
    "NotAToolName"
  ]);
  assert.deepEqual(
    audit.canonical.sort(),
    [
      EXEC_TOOL,
      MULTI_AGENT_SPAWN_TOOL,
      AUTODEV_SPAWN_TOOL,
      WEB_SEARCH_TOOL
    ].sort()
  );
  assert.equal(audit.exceptions.length, 3);
  assert.ok(
    audit.exceptions.some(
      (e) => e.tool === "WebSearch" && e.provider.startsWith("claude")
    )
  );
  assert.ok(
    audit.exceptions.some(
      (e) => e.tool === "search_web" && e.provider.startsWith("antigravity")
    )
  );
  assert.ok(
    audit.exceptions.some(
      (e) =>
        e.tool === "bash" &&
        (e.provider.startsWith("copilot") ||
          e.provider.startsWith("antigravity"))
    )
  );
  assert.deepEqual(audit.unrecognised, ["NotAToolName"]);
});

// Guard rail: src/ must not hard-code a multi_agent_v1__* literal outside
// the canonical constants module. If someone re-introduces one, this test
// names the offender so the next reader can fix it at the source.
const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const HOME = fileURLToPath(new URL("./tool-names.ts", import.meta.url));

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readFileSync.bind(globalThis) && []) {
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  }
  return out;
}

test("src/ never hard-codes a multi_agent_v1__* tool name outside the canonical module", () => {
  const forbidden = [
    "multi_agent_v1__spawn_agent",
    "multi_agent_v1__wait_agent",
    "multi_agent_v1__close_agent",
    "multi_agent_v1__resume_agent",
    "multi_agent_v1__send_input"
  ];
  const offenders: { file: string; line: number; literal: string }[] = [];
  for (const file of listTypeScriptFiles(SRC_ROOT)) {
    if (file === HOME) continue;
    const text = readFileSync(file, "utf8");
    for (const literal of forbidden) {
      const re = new RegExp(`["']${literal}["']`, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const upto = text.slice(0, match.index);
        const line = upto.split("\n").length;
        offenders.push({ file, line, literal });
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `hard-coded multi_agent_v1__* literals must come from src/shared/tool-names.ts; offenders:\n${offenders
      .map((o) => `  ${o.file}:${o.line}  ${o.literal}`)
      .join("\n")}`
  );
});
