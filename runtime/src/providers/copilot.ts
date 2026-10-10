#!/usr/bin/env node

/** OpenAI Responses compatibility proxy for the subscription-authenticated Copilot CLI. */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { homedir } from "node:os";
import pathApi from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  bridgeSkillContext,
  buildSpawnToolCallOutput,
  composeProviderPrompt,
  isOrchestratorRole,
  readOnlySystemPromptInjection,
  resolveAgentRole,
  SpawnSessionRegistry,
  type SpawnToolCallOutput
} from "@simulatorlife/autodev-runtime/agents";
import {
  type RoleContract,
  roleContract
} from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  sendJson,
  sendWorkspaceResolutionFailure
} from "@simulatorlife/autodev-runtime/shared/provider-http";
import {
  classifyCliLimit,
  INCOMPLETE_REASON_INTERRUPTED,
  INCOMPLETE_REASON_PROVIDER_LIMIT,
  limitPayload,
  limitResponseHeaders,
  retryAfterSecondsFromLimit,
  terminalIncompleteEvents
} from "@simulatorlife/autodev-runtime/shared/provider-limits";
import {
  resolveCwd,
  WorkspaceResolutionError
} from "@simulatorlife/autodev-runtime/shared/resolve-workspace";
import {
  resolveRuntimeSourcePath,
  resolveRuntimeSourceRoot
} from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import {
  type AgentEventReporter,
  gitCommitIdentityEnv,
  resolveAgentEventReporter,
  SKILL_READ_SOURCE
} from "@simulatorlife/autodev-runtime/telemetry";
import {
  AUTODEV_WORKSPACE_KEY_HEADER,
  withAutoDevOtelResourceContext
} from "@simulatorlife/autodev-runtime/telemetry/resource-context";

// Bind the port only when run as a program, so this file can be imported for
// its pure helpers without taking the port from the running bridge. Mirrors
// the MiniMax adapter's guard.
const IS_MAIN =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const HOST = process.env.COPILOT_PROXY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.COPILOT_PROXY_PORT ?? "4003");
const TIMEOUT_MS = Number.parseInt(
  process.env.COPILOT_PROXY_TIMEOUT_MS ?? "7200000"
);
const PROJECT_ROOT =
  process.env.CODEX_PROJECT_ROOT ?? process.env.COPILOT_PROJECT_ROOT ?? null;
const AUTH_TOKEN = process.env.CODEX_ROUTER_COPILOT_API_KEY ?? "";

// Provider/CLI payloads are JSON-shaped but intentionally retain fields this
// bridge does not own (the Copilot CLI's event stream is not a formally
// specified schema; see COPILOT_TOOL_OUTPUT_KEYS below). Keep the dynamic edge
// explicit while the transport and boundary operations remain typed.
type JsonRecord = Record<string, unknown>;
type AgentReporter = AgentEventReporter;

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type JsonParseResult = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): JsonParseResult {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}
// `roleContract` returns the fields every consumer shares (`mcp`) typed, plus
// an index signature for the rest. This bridge additionally reads
// `mcpTools`, `readOnly`, and `skills`, which are real contract fields the
// shared interface leaves untyped for other consumers; narrow them here
// rather than widening the shared type for one bridge's shape.
type CopilotRoleContract = RoleContract & {
  mcpTools?: Record<string, string[]>;
  readOnly?: boolean;
  skills?: string[];
};

function copilotRoleContract(role: unknown): CopilotRoleContract {
  return roleContract(role) as CopilotRoleContract;
}

// How a Copilot turn comes by the skills its role contract grants it: the CLI
// has no per-invocation skill flag, so the contract rendered into the turn's
// prompt is the exposure. Carried on every `skill_exposed` event so the
// router's rows say which mechanism made the skill available.
const SKILL_EXPOSURE_SOURCE = "role_contract";
const MCP_EXPOSURE_SOURCE = "role_contract";

function readOnlyHeaderValue(
  headers: Record<string, unknown>
): "read-only" | "workspace-write" | null {
  const key = Object.keys(headers).find(
    (c) => c.toLowerCase() === "x-autodev-sandbox-mode"
  );
  if (!key) return null;
  const value = headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return single === "read-only" || single === "workspace-write" ? single : null;
}

const spawnSessions = new SpawnSessionRegistry();

// Canonical skill roots whose `SKILL.md` a successful read counts as actual
// usage, mirroring the approved roots `runtime/src/hooks/skill-read-telemetry.ts`
// uses for Codex's own PreToolUse hook. The Copilot CLI's tool calls never
// reach that hook -- it runs entirely inside its own runtime -- so this
// bridge is the only place a read of one of these files is observable at all.
const HOME = homedir();
// Resolve the owning checkout or installed CODEX_HOME from this module's
// location; the Runtime source tree is one level deeper than its installed
// `src/providers/` copy.
const REPO_ROOT = resolveRuntimeSourceRoot(
  import.meta.dirname,
  process.env.AUTODEV_REPO_ROOT
);
const SKILL_ROOTS = [
  pathApi.join(HOME, ".agents", "skills"),
  pathApi.join(HOME, ".codex", "skills"),
  pathApi.join(HOME, "AutoDev", ".agents", "skills"),
  pathApi.join(HOME, "AutoDev", ".rulesync", "skills"),
  pathApi.join(REPO_ROOT, ".agents", "skills"),
  pathApi.join(REPO_ROOT, ".rulesync", "skills")
].filter((path) => existsSync(path));

// Tool names the Copilot CLI uses to read a file's contents outright, versus
// the shell tools whose command line may contain a read of one. Anything
// else -- a write, an edit, `report_intent` -- is deliberately excluded: a
// mutation or an unrelated call must never be counted as a skill activation
// just because its arguments happen to name a path.
const COPILOT_READ_TOOL_NAMES = new Set([
  "read_file",
  "view_file",
  "cat_file",
  "view"
]);
const COPILOT_EXEC_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "execute",
  "exec_command",
  "run_command"
]);

function normaliseSkillReadPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replaceAll(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  let path = trimmed;
  if (path.startsWith("~")) path = pathApi.join(HOME, path.slice(1));
  if (!pathApi.isAbsolute(path)) path = pathApi.resolve(path);
  return path;
}

// Shell tool names whose command line is treated as a read when it names a
// file argument. `sed` only counts in its `-n` (suppress-output, print via
// explicit `p`) form; a plain `sed 's/a/b/' file` mutates output rather than
// dumping the file, so it is intentionally excluded.
const SKILL_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "awk",
  "grep"
]);
const SHELL_CONTROL_TOKENS = new Set(["|", "&&", "||", ";", "&"]);

// Splits a shell command into words, honouring single- and double-quoted
// spans so a quoted path containing a space (`cat "/a b/SKILL.md"`) is not
// broken across two tokens. Not a full shell grammar -- backslash escapes and
// `$()`/backtick substitution are not unwound -- but enough to recover the
// plain file arguments Copilot's own tool calls put on these command lines.
function tokenizeShellWords(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g;
  let match;
  while ((match = re.exec(cmd)) !== null) {
    let token = match[0];
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      token = token.slice(1, -1);
    }
    tokens.push(token);
  }
  return tokens;
}

// A word counts as a path argument, not a flag or a search pattern, only when
// it is absolute or home-relative. Relative shell paths remain excluded so a
// command cannot be attributed to the wrong working directory.
function isPathLikeToken(token: unknown): string | null {
  if (typeof token !== "string" || !token || token.startsWith("-")) return null;
  if (token.startsWith("/") || token.startsWith("~")) return token;
  return null;
}

// Resolves the raw value of a `cmd`/`command` argument to a single shell
// string. Providers vary in how they shape this: a plain string, an argv
// array (`["bash", "-lc", "cat file"]` or `["cat", "file"]`), or a nested
// object carrying the real command one level down (`{ command: { cmd: "..." } }`).
// Only one level of object nesting is unwrapped -- deeper nesting is not a
// shape any tool call here actually uses.
function flattenCommandValue(raw: unknown): string | null {
  let value: unknown = raw;
  if (isJsonRecord(value)) {
    value = value.cmd ?? value.command ?? value.script ?? value.value ?? null;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join(" ");
  }
  return typeof value === "string" ? value : null;
}

// Every path-like argument following a recognised read command on `cmd`'s
// command line, in the order they appear. Bounded on both axes: overlong
// commands are rejected outright, and only the next 8 words after a read
// command are scanned for a path. Returning every candidate -- not just the
// first -- lets the caller pick out whichever one actually names a SKILL.md
// when a command reads more than one file (`grep pattern a.md SKILL.md`).
function matchExecReadPaths(raw: unknown): string[] {
  const cmd = flattenCommandValue(raw);
  if (!cmd || cmd.length > 4096) return [];
  const tokens = tokenizeShellWords(cmd);
  const candidates: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    const isSedPrint = word === "sed" && tokens[i + 1] === "-n";
    if (!SKILL_READ_COMMANDS.has(word ?? "") && !isSedPrint) continue;
    const start = isSedPrint ? i + 2 : i + 1;
    for (let j = start; j < tokens.length && j < start + 8; j++) {
      const next = tokens[j];
      if (next === undefined || SHELL_CONTROL_TOKENS.has(next)) break;
      const path = isPathLikeToken(next);
      if (path) candidates.push(path);
    }
  }
  return candidates;
}

/** The path a `read_file`-shaped or shell-read tool call names, if any. */
function extractSkillReadPath(
  toolName: unknown,
  argsObject: unknown
): string | null {
  const name = String(toolName ?? "")
    .trim()
    .toLowerCase();
  const args = isJsonRecord(argsObject) ? argsObject : {};
  if (COPILOT_READ_TOOL_NAMES.has(name)) {
    for (const key of [
      "file_path",
      "filePath",
      "path",
      "filepath",
      "AbsolutePath",
      "absolutePath",
      "targetFile",
      "TargetFile",
      "file",
      "filename",
      "fileName"
    ]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }
  if (COPILOT_EXEC_TOOL_NAMES.has(name)) {
    const command =
      typeof argsObject === "string" ? argsObject : (args.command ?? args.cmd);
    const candidates = matchExecReadPaths(command);
    for (const candidate of candidates) {
      if (matchSkillReadPath(normaliseSkillReadPath(candidate)))
        return candidate;
    }
    return candidates[0] ?? null;
  }
  return null;
}

// True when `path` resolves to `<root>/<skill-name>/SKILL.md` for one of the
// approved roots. Returns the skill's directory name -- never the absolute
// path -- because that is all the router retains.
const SKILL_PATH_LEADING_SEPARATOR_PATTERN = /^[\\/]+/;

function matchSkillReadPath(path: string | null): string | null {
  if (!path) return null;
  const normalised = path.replaceAll(/[\\/]+/g, pathApi.sep);
  for (const rootRaw of SKILL_ROOTS) {
    const root = rootRaw.replaceAll(/[\\/]+/g, pathApi.sep);
    const rootWithSep = root.endsWith(pathApi.sep) ? root : root + pathApi.sep;
    if (!normalised.startsWith(rootWithSep)) continue;
    const relative = normalised
      .slice(root.length)
      .replace(SKILL_PATH_LEADING_SEPARATOR_PATTERN, "");
    if (!relative.endsWith(`${pathApi.sep}SKILL.md`) && relative !== "SKILL.md")
      continue;
    const segments = relative.split(pathApi.sep).filter(Boolean);
    if (segments.length !== 2) continue;
    const [skill] = segments;
    if (!skill || skill.includes("..")) continue;
    return skill;
  }
  return null;
}

/**
 * The `skill_used` event for a successful, canonical `SKILL.md` read, or null.
 * `seenSkills` dedupes per turn: re-reading the same file from a second tool
 * call in the same turn reports one use, not two.
 */
function skillReadEvent({
  seenSkills,
  toolName,
  args,
  callId
}: {
  seenSkills: Set<string>;
  toolName: unknown;
  args: unknown;
  callId: string | null;
}): Extract<CopilotRunEvent, { type: "skill_used" }> | null {
  const candidate = extractSkillReadPath(toolName, args);
  if (!candidate) return null;
  const normalised = normaliseSkillReadPath(candidate);
  const skill = matchSkillReadPath(normalised);
  if (!skill) return null;
  if (seenSkills.has(skill)) return null;
  seenSkills.add(skill);
  return {
    type: "skill_used",
    skill,
    eventId: `skill_read:${callId ?? "no-call-id"}:${skill}`
  };
}

// What the bridge posts back to the router about one tool call. The CLI's
// JSONL stream is the only place a Copilot tool call is visible at all: the
// model router never sees a request for it, and an OTLP datapoint only
// describes what Codex's own runtime ran.
const TOOL_OBSERVATION_TYPES = new Set([
  "tool_requested",
  "tool_executed",
  "tool_unavailable"
]);

// The Copilot CLI's event stream is not a formally specified schema -- the
// field names below are the ones the CLI and its hooks reference use, and
// GitHub's own tracker still lists formalizing the stream as an open request.
// So the probing here is deliberately tolerant and fails closed: a terminal
// tool event whose shape this bridge does not recognize reports nothing
// rather than asserting an execution the CLI never evidenced.
const COPILOT_TOOL_OUTPUT_KEYS = [
  "toolResult",
  "tool_result",
  "result",
  "output",
  "content",
  "stdout",
  "error",
  "errorMessage"
];
const COPILOT_DENIED_PATTERN =
  /deni|reject|not[_\s-]?permitted|not[_\s-]?allowed/i;
const COPILOT_CANCELLED_LABEL_PATTERN = /cancel/i;
const COPILOT_FAILED_LABEL_PATTERN = /error|fail/i;

/** The result payload of a terminal tool event, whatever it is called. */
function copilotToolResult(
  data: JsonRecord | null | undefined
): JsonRecord | null {
  const result = data?.toolResult ?? data?.tool_result ?? data?.result ?? null;
  return isJsonRecord(result) ? result : null;
}

/**
 * The CLI's own label for how the call ended (`resultType`, `status`), with
 * no free result text mixed in: a tool whose *output* happens to contain the
 * word "denied" did run, and must not be reported as one the workspace
 * refused to run.
 */
function copilotToolStatusLabel(data: JsonRecord | null | undefined): string {
  const result = copilotToolResult(data);
  return [
    typeof data?.status === "string" ? data.status : "",
    typeof data?.outcome === "string" ? data.outcome : "",
    result ? String(result.resultType ?? result.result_type ?? "") : ""
  ]
    .filter(Boolean)
    .join(" ");
}

/** True when the event carries the call's own output. */
function copilotToolOutputPresent(
  data: JsonRecord | null | undefined
): boolean {
  if (!data || typeof data !== "object") return false;
  return (
    COPILOT_TOOL_OUTPUT_KEYS.some((key) => {
      const value = data[key];
      if (value === undefined || value === null) return false;
      return typeof value === "string" ? value.trim() !== "" : true;
    }) ||
    data.success !== undefined ||
    (typeof data.exitCode === "number" && Number.isFinite(data.exitCode))
  );
}

type CopilotToolOutcome =
  | { kind: "unavailable"; reason: string }
  | { kind: "none" }
  | { kind: "executed"; status: "ok" | "error" };

/**
 * What one terminal `tool.*` event proves about the call.
 *
 * `executed` is reserved for an event that carries the call's result, because
 * the router treats `tool_executed` as the first-class evidence that unlocks
 * per-workspace tool attribution -- an inferred execution would unlock it on
 * a guess. A call the workspace refused is `unavailable`, and anything else
 * proves only what the `tool.execution_start` already reported.
 */
function copilotToolOutcome(
  data: JsonRecord | null | undefined
): CopilotToolOutcome {
  const label = copilotToolStatusLabel(data);
  if (
    data?.permissionDenied === true ||
    data?.denied === true ||
    COPILOT_DENIED_PATTERN.test(label)
  ) {
    return { kind: "unavailable", reason: "denied" };
  }
  if (!copilotToolOutputPresent(data)) {
    if (
      data?.status === "cancelled" ||
      COPILOT_CANCELLED_LABEL_PATTERN.test(label)
    ) {
      return { kind: "unavailable", reason: "cancelled" };
    }
    return { kind: "none" };
  }
  const failed =
    data?.success === false ||
    data?.isError === true ||
    Boolean(data?.error ?? data?.errorMessage) ||
    (typeof data?.exitCode === "number" &&
      Number.isFinite(data.exitCode) &&
      data.exitCode !== 0) ||
    COPILOT_FAILED_LABEL_PATTERN.test(label);
  return { kind: "executed", status: failed ? "error" : "ok" };
}

/** Post one observation, when the router authorized reporting for this turn. */
function reportToolObservation(
  agentEvents: AgentReporter | null,
  event: CopilotRunEvent
): void {
  if (!agentEvents) return;
  if (event.type === "tool_requested") {
    void agentEvents.reportToolRequested({
      tool: event.tool,
      callId: event.callId,
      server: event.server
    });
  } else if (event.type === "tool_executed") {
    void agentEvents.reportToolExecuted({
      tool: event.tool,
      callId: event.callId,
      status: event.status,
      durationMs: event.durationMs,
      server: event.server
    });
  } else if (event.type === "tool_unavailable") {
    void agentEvents.reportToolUnavailable({
      tool: event.tool,
      callId: event.callId,
      reason: event.reason,
      server: event.server
    });
  } else if (
    event.type === "skill_used" &&
    typeof agentEvents.reportSkillUsed === "function"
  ) {
    void agentEvents.reportSkillUsed({
      skill: event.skill,
      source: SKILL_READ_SOURCE,
      eventId: event.eventId
    });
  }
}

function responseMessageItem(text: string, itemId: string): JsonRecord {
  return {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  };
}

function responsePayload(
  model: unknown,
  text: string,
  result: JsonRecord | null,
  responseId: string = `resp_${randomBytes(12).toString("hex")}`,
  itemId: string = `msg_${randomBytes(10).toString("hex")}`,
  output: object[] | null = null,
  status: string = "completed"
): JsonRecord {
  const message = responseMessageItem(text, itemId);
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output: output ?? [message],
    output_text: text,
    // The Copilot CLI reports premium-request spend rather than token counts,
    // so there is nothing token-shaped to report back to the router.
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) =>
      isJsonRecord(part)
        ? String(part.text ?? JSON.stringify(part))
        : String(part)
    )
    .join("\n");
}

function inputText(input: unknown, instructions: string): string {
  if (typeof input === "string")
    return `${instructions}\n\nDelegated task:\n${input}`;
  if (!Array.isArray(input))
    return `${instructions}\n\nDelegated task:\n${String(input ?? "")}`;
  const userItems = input.filter(
    (item) => item && typeof item === "object" && item.role === "user"
  );
  const items =
    userItems.length > 0
      ? userItems
      : input.filter(
          (item) =>
            !item ||
            typeof item !== "object" ||
            !["developer", "system"].includes(item.role)
        );
  const task = items
    .map((item) =>
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? contentText(item.content ?? item.text ?? "")
          : String(item ?? "")
    )
    .join("\n\n");
  return `${instructions}\n\nDelegated task:\n${task}`;
}

// The Copilot CLI's `report_intent` tool exists to narrate what the agent is
// about to do, so its argument is a better activity line than the tool name.
function toolActivityText(data: JsonRecord | null | undefined): string {
  const toolName = String(data?.toolName ?? "tool");
  const intent = isJsonRecord(data?.arguments)
    ? data.arguments.intent
    : undefined;
  if (
    toolName === "report_intent" &&
    typeof intent === "string" &&
    intent.trim()
  )
    return `Copilot: ${intent.trim()}`;
  return `Copilot is using ${toolName}.`;
}

const RESEARCH_CAPABLE_ROLES = new Set([
  "docs-researcher",
  "smart",
  "orchestrator"
]);

function isResearchRole(role: unknown): boolean {
  return (
    typeof role === "string" &&
    RESEARCH_CAPABLE_ROLES.has(role.trim().toLowerCase())
  );
}

/** The launch definition of every AutoDev MCP server, rendered by the installer from `.rulesync/mcp.jsonc`. */
function bridgeMcpCatalogue(): JsonRecord {
  const path = pathApi.join(
    process.env.CODEX_HOME ?? pathApi.join(homedir(), ".codex"),
    "provider-runtime",
    "mcp-servers.json"
  );
  try {
    const catalogue: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isJsonRecord(catalogue)) return catalogue;
  } catch {
    /* reported below */
  }
  throw new Error(
    `bridge MCP catalogue is missing or invalid: ${path}; rerun scripts/install.sh`
  );
}

/** Server names in the user-level Copilot MCP file that Rulesync writes. */
function userMcpServerNames(): string[] {
  const path = pathApi.join(
    process.env.COPILOT_HOME ?? pathApi.join(homedir(), ".copilot"),
    "mcp-config.json"
  );
  if (!existsSync(path)) return [];
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isJsonRecord(config) || !isJsonRecord(config.mcpServers)) return [];
  return Object.keys(config.mcpServers);
}

/**
 * Copilot CLI arguments that give this turn exactly its role contract's MCP
 * servers, as the Claude bridge does with `--strict-mcp-config`:
 * - user-level servers outside the contract, and the built-in GitHub server,
 *   are disabled for the session;
 * - contract servers the user-level file lacks are added with the role's tool
 *   allowlist (`mcpTools`, from the role TOML's `enabled_tools`);
 * - every contract server's tools are approved.
 * User-level servers in the contract stay as Rulesync wrote them: they come
 * from the same `.rulesync/mcp.jsonc` declaration as the catalogue.
 */
function copilotMcpArgs(
  agentRole: string | null,
  spawnSession: string | null = null
): string[] {
  const contract = copilotRoleContract(agentRole);
  const granted = (contract.mcp ?? []).filter(
    (name) => name !== "autodev_spawn"
  );
  const catalogue = bridgeMcpCatalogue();
  const userServers = new Set(userMcpServerNames());
  const args: string[] = ["--disable-builtin-mcps"];
  for (const name of userServers) {
    if (!granted.includes(name)) args.push("--disable-mcp-server", name);
  }
  const additional: Record<string, JsonRecord> = {};
  for (const name of granted) {
    const server = catalogue[name];
    if (!isJsonRecord(server)) {
      throw new Error(
        `MCP server ${name} granted to role ${agentRole ?? "default"} is not in the bridge MCP catalogue; rerun scripts/install.sh`
      );
    }
    const tools = contract.mcpTools?.[name];
    if (userServers.has(name)) {
      if (tools)
        throw new Error(
          `MCP server ${name} has a role tool allowlist but is registered at user level; it cannot be narrowed per session`
        );
      continue;
    }
    additional[name] = server.url
      ? { type: "http", url: server.url, tools: tools ?? ["*"] }
      : {
          type: "stdio",
          command: server.command,
          args: server.args ?? [],
          tools: tools ?? ["*"]
        };
  }
  if (isOrchestratorRole(agentRole) && spawnSession) {
    // The CLI cannot reach Codex directly. Give only this identified root turn
    // a per-request MCP server whose call is collected and returned as a
    // synthetic Codex exec item after the CLI turn completes.
    const shim = resolveRuntimeSourcePath(REPO_ROOT, "mcp/spawn-shim.ts");
    additional.autodev_spawn = {
      type: "stdio",
      command: process.execPath,
      args: [shim],
      env: {
        AUTODEV_BRIDGE_URL: `http://${HOST}:${PORT}`,
        AUTODEV_BRIDGE_TOKEN: AUTH_TOKEN,
        AUTODEV_SPAWN_SESSION: spawnSession,
        // The spawned Codex inherits this, so commits it makes carry an
        // identity attribution can be read back from.
        ...gitCommitIdentityEnv({ role: agentRole, provider: "copilot" })
      }
    };
  }
  if (Object.keys(additional).length > 0)
    args.push(
      "--additional-mcp-config",
      JSON.stringify({ mcpServers: additional })
    );
  for (const name of granted) args.push(`--allow-tool=${name}`);
  return args;
}

interface RunCopilotResult {
  text: string;
  result: JsonRecord;
}

interface CopilotOpenToolCall {
  tool: string;
  startedAt: number;
  server: string | null;
  args: unknown;
}

interface CopilotRunState {
  phases: Map<string, string>;
  toolCalls: Map<string, CopilotOpenToolCall>;
  seenSkills: Set<string>;
  answer: string;
  terminalResult: JsonRecord | null;
}

interface CopilotCliEvent {
  type: string;
  data: JsonRecord;
  raw: JsonRecord;
}

type CopilotRunEvent =
  | { type: "process"; child: ChildProcess }
  | { type: "text_delta"; text: string }
  | { type: "activity"; text: string; key?: string }
  | {
      type: "tool_requested";
      tool: string;
      callId: string | null;
      server: string | null;
    }
  | {
      type: "tool_executed";
      tool: string;
      callId: string | null;
      status: "ok" | "error";
      durationMs: number | null;
      server: string | null;
    }
  | {
      type: "tool_unavailable";
      tool: string;
      callId: string | null;
      reason: string;
      server: string | null;
    }
  | { type: "skill_used"; skill: string; eventId: string };

type OnRunCopilotEvent = (event: CopilotRunEvent) => void;

function parseCopilotCliEvent(line: string): CopilotCliEvent | null {
  const parsed = parseJson(line);
  if (!parsed.ok || !isJsonRecord(parsed.value)) return null;
  if (typeof parsed.value.type !== "string") return null;
  return {
    type: parsed.value.type,
    data: isJsonRecord(parsed.value.data) ? parsed.value.data : {},
    raw: parsed.value
  };
}

function copilotString(data: JsonRecord, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function copilotToolServer(
  data: JsonRecord,
  toolName: string,
  fallback: string | null = null
): string | null {
  return (
    copilotString(data, "server") ??
    copilotString(data, "serverName") ??
    fallback ??
    (toolName.startsWith("mcp__") ? mcpServerFromToolName(toolName) : null)
  );
}

function handleAssistantMessageStart(
  data: JsonRecord,
  state: CopilotRunState
): void {
  const messageId = data.messageId;
  if (typeof messageId === "string" && messageId)
    state.phases.set(messageId, String(data.phase ?? ""));
}

function handleAssistantMessageDelta(
  data: JsonRecord,
  state: CopilotRunState,
  onEvent: OnRunCopilotEvent | null
): void {
  const delta = String(data.deltaContent ?? "");
  if (!delta) return;
  const phase =
    typeof data.messageId === "string"
      ? state.phases.get(data.messageId)
      : undefined;
  if (phase === "final_answer") {
    state.answer += delta;
    onEvent?.({ type: "text_delta", text: delta });
    return;
  }
  onEvent?.({ type: "activity", text: delta });
}

function handleAssistantMessageSnapshot(
  data: JsonRecord,
  state: CopilotRunState,
  onEvent: OnRunCopilotEvent | null
): void {
  if (String(data.phase ?? "") !== "final_answer") return;
  const full = String(data.content ?? "");
  if (!full || state.answer.endsWith(full)) return;
  const suffix = full.startsWith(state.answer)
    ? full.slice(state.answer.length)
    : full;
  if (!suffix) return;
  state.answer += suffix;
  onEvent?.({ type: "text_delta", text: suffix });
}

function handleToolExecutionStart(
  data: JsonRecord,
  state: CopilotRunState,
  onEvent: OnRunCopilotEvent | null
): void {
  const callId = String(data.toolCallId ?? "").trim() || null;
  const toolName = String(data.toolName ?? "").trim();
  const server = copilotToolServer(data, toolName);
  if (toolName) {
    if (callId)
      state.toolCalls.set(callId, {
        tool: toolName,
        startedAt: Date.now(),
        server,
        args: data.arguments ?? null
      });
    onEvent?.({ type: "tool_requested", tool: toolName, callId, server });
  }
  onEvent?.({
    type: "activity",
    text: toolActivityText(data),
    key: `tool:${data.toolCallId ?? ""}`
  });
}

function handleToolExecutionEnd(
  eventType: string,
  data: JsonRecord,
  state: CopilotRunState,
  onEvent: OnRunCopilotEvent | null
): void {
  if (!eventType.startsWith("tool.") || eventType === "tool.execution_start")
    return;
  const callId = String(data.toolCallId ?? "").trim() || null;
  const open = callId ? state.toolCalls.get(callId) : null;
  const toolName = String(data.toolName ?? open?.tool ?? "").trim();
  if (!toolName) return;
  const outcome = copilotToolOutcome(data);
  if (outcome.kind === "none") return;
  if (callId) state.toolCalls.delete(callId);
  const server = copilotToolServer(data, toolName, open?.server ?? null);
  reportCopilotToolOutcome(outcome, {
    callId,
    data,
    onEvent,
    open,
    seenSkills: state.seenSkills,
    server,
    toolName
  });
}

function reportCopilotToolOutcome(
  outcome: Exclude<CopilotToolOutcome, { kind: "none" }>,
  options: {
    callId: string | null;
    data: JsonRecord;
    onEvent: OnRunCopilotEvent | null;
    open: CopilotOpenToolCall | null | undefined;
    seenSkills: Set<string>;
    server: string | null;
    toolName: string;
  }
): void {
  const { callId, data, onEvent, open, seenSkills, server, toolName } = options;
  if (outcome.kind === "unavailable") {
    onEvent?.({
      type: "tool_unavailable",
      tool: toolName,
      callId,
      reason: outcome.reason,
      server
    });
    return;
  }
  onEvent?.({
    type: "tool_executed",
    tool: toolName,
    callId,
    status: outcome.status,
    durationMs: open ? Date.now() - open.startedAt : null,
    server
  });
  if (outcome.status !== "ok") return;
  const skillEvent = skillReadEvent({
    seenSkills,
    toolName,
    args: open?.args ?? data.arguments,
    callId
  });
  if (skillEvent) onEvent?.(skillEvent);
}

function dispatchCopilotCliEvent(
  event: CopilotCliEvent,
  state: CopilotRunState,
  onEvent: OnRunCopilotEvent | null
): void {
  switch (event.type) {
    case "assistant.message_start": {
      handleAssistantMessageStart(event.data, state);
      return;
    }
    case "assistant.message_delta": {
      handleAssistantMessageDelta(event.data, state, onEvent);
      return;
    }
    case "assistant.message": {
      handleAssistantMessageSnapshot(event.data, state, onEvent);
      return;
    }
    case "tool.execution_start": {
      handleToolExecutionStart(event.data, state, onEvent);
      return;
    }
    case "result": {
      state.terminalResult = event.raw;
      return;
    }
    default: {
      handleToolExecutionEnd(event.type, event.data, state, onEvent);
    }
  }
}

/** The MCP server segment of a "mcp__<server>__<tool>"-shaped tool name. */
function mcpServerFromToolName(toolName: string): string | null {
  const start = toolName.indexOf("__");
  if (start === -1) return null;
  const from = start + 2;
  const end = toolName.indexOf("__", from);
  return end === -1 ? toolName.slice(from) : toolName.slice(from, end);
}

/**
 * Run one Copilot turn, reporting the CLI's JSONL events as they arrive.
 * `onEvent` receives `{ type: "text_delta" | "activity", text }` for the
 * final answer and for the commentary/tool narration around it, so the parent
 * sees the turn progress instead of one silent block at the end.
 */
function runCopilot(
  prompt: string,
  model: unknown,
  cwd: string,
  onEvent: OnRunCopilotEvent | null = null,
  agentRole: string | null = null,
  spawnSession: string | null = null,
  sandboxMode: "read-only" | "workspace-write" | null = null,
  workspaceKey: unknown = null
): Promise<RunCopilotResult> {
  return new Promise<RunCopilotResult>((resolve, reject) => {
    const args = [
      "--no-auto-update",
      "--no-color",
      "--output-format",
      "json",
      "--prompt",
      prompt
    ];
    const contract = copilotRoleContract(agentRole);
    args.push(...copilotMcpArgs(agentRole, spawnSession));
    if (isResearchRole(agentRole))
      args.push("--allow-tool=web_search", "--allow-tool=web_fetch");
    // The router forwards the declared sandbox via x-autodev-sandbox-mode. We
    // trust that header over roleContract(agentRole).readOnly because the
    // header is the authoritative wire signal for this turn.
    const readOnly =
      sandboxMode === "read-only" ||
      (sandboxMode !== "workspace-write" && contract.readOnly);
    if (!readOnly)
      args.splice(
        4,
        0,
        "--allow-all-tools",
        "--allow-all-paths",
        "--allow-all-urls",
        "--no-ask-user"
      );
    if (model && model !== "copilot" && model !== "auto")
      args.push("--model", String(model));
    const child = spawn(process.env.COPILOT_BIN ?? "copilot", args, {
      cwd,
      env: withAutoDevOtelResourceContext(process.env, workspaceKey, agentRole),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const state: CopilotRunState = {
      phases: new Map(),
      toolCalls: new Map(),
      seenSkills: new Set(),
      answer: "",
      terminalResult: null
    };
    let stderr = "";
    let settled = false;
    const timer =
      TIMEOUT_MS > 0
        ? setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS)
        : null;
    const finishResolve = (value: RunCopilotResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const event = parseCopilotCliEvent(line);
      if (event) dispatchCopilotCliEvent(event, state, onEvent);
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finishReject(error));
    child.on("close", (code, signal) => {
      const exitCode = state.terminalResult?.exitCode ?? code;
      if (exitCode !== 0 || code !== 0) {
        finishReject(
          new Error(
            (
              stderr.trim() || `Copilot exited with ${signal || exitCode}`
            ).slice(-4000)
          )
        );
        return;
      }
      if (!state.answer.trim()) {
        finishReject(
          new Error("Copilot exited successfully without a final answer")
        );
        return;
      }
      finishResolve({
        text: state.answer,
        result: state.terminalResult ?? {}
      });
    });
    onEvent?.({ type: "process", child });
  });
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const EVENT_OUTPUT_ITEM_ADDED = "response.output_item.added";
const EVENT_OUTPUT_ITEM_DONE = "response.output_item.done";

function sseLine(eventName: string, body: object): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`;
}

function headerValue(
  headers: NodeJS.Dict<string | string[]> | undefined,
  name: string
): string | null {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name
  );
  const value = key === undefined ? undefined : headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

interface CopilotRequestContext {
  payload: JsonRecord;
  agentRole: string | null;
  workspaceKey: unknown;
  agentEvents: AgentReporter | null;
  cwd: string;
  prompt: string;
  spawnSession: string | null;
  sandboxModeHeader: "read-only" | "workspace-write" | null;
}

class CopilotResponseStream {
  readonly responseId = "resp_" + randomBytes(12).toString("hex");
  readonly reasoningId = "rs_" + randomBytes(12).toString("hex");
  readonly itemId = "msg_" + randomBytes(10).toString("hex");
  private readonly activityParts: string[] = [];
  private readonly seenActivities = new Set<string>();
  private readonly pendingEvents: string[] = [];
  private partialText = "";
  private sequenceNumber = 0;
  private streamStarted = false;
  private clientClosed = false;
  private child: ChildProcess | undefined;
  private readonly keepAlive: NodeJS.Timeout;
  private readonly onResponseError: () => void;
  private readonly onResponseClose: () => void;
  private readonly context: CopilotRequestContext;
  private readonly response: ServerResponse;

  constructor(context: CopilotRequestContext, response: ServerResponse) {
    this.context = context;
    this.response = response;
    this.onResponseError = () => this.cancelClient();
    this.onResponseClose = () => {
      this.cancelClient();
      this.response.removeListener("error", this.onResponseError);
    };
    response.on("error", this.onResponseError);
    response.on("close", this.onResponseClose);
    this.keepAlive = setInterval(() => this.writeKeepAlive(), 2000);
    this.emitInitialEvents();
  }

  acceptEvent(event: CopilotRunEvent): void {
    if (typeof this.context.agentEvents?.reportHeartbeat === "function") {
      void this.context.agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }
    if (event.type === "process") {
      this.child = event.child;
      return;
    }
    if (TOOL_OBSERVATION_TYPES.has(event.type)) {
      reportToolObservation(this.context.agentEvents, event);
      return;
    }
    this.startStream();
    if (event.type === "text_delta") {
      this.partialText += event.text;
      this.emit("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: this.itemId,
        delta: event.text,
        content_index: 0,
        output_index: 1
      });
      return;
    }
    if (event.type === "activity") {
      this.emitActivity(
        event.text,
        event.key ?? "activity:" + this.activityParts.length + ":" + event.text
      );
    }
  }

  complete(result: RunCopilotResult): void {
    this.startStream();
    const reasoningText = this.activityParts.join("");
    const completedReasoning = {
      id: this.reasoningId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
      content: []
    };
    const completedMessage = responseMessageItem(result.text, this.itemId);
    const output: object[] = [completedReasoning, completedMessage];
    const completed = responsePayload(
      this.context.payload.model,
      result.text,
      result.result,
      this.responseId,
      this.itemId,
      output
    );
    this.emitCompletedItems(
      reasoningText,
      result.text,
      completedReasoning,
      completedMessage
    );
    const spawnOutput = buildCopilotSpawnOutput(this.context, output.length);
    if (spawnOutput) {
      for (const [eventName, body] of spawnOutput.events)
        this.emit(eventName, body);
      output.push(spawnOutput.events[3][1].item);
      writeErrorLine(
        "copilot delegating " +
          spawnOutput.childCount +
          " subagent(s) through Codex"
      );
    }
    this.emit("response.completed", {
      type: "response.completed",
      response: completed
    });
    this.endSse();
  }

  fail(error: unknown): void {
    if (this.context.spawnSession)
      spawnSessions.close(this.context.spawnSession);
    if (!this.isWritable()) return;
    const message = error instanceof Error ? error.message : String(error);
    const limit = classifyCliLimit(message, copilotErrorExitCode(error));
    if (!this.streamStarted) {
      this.sendInitialFailure(message, limit);
      return;
    }
    this.emitIncompleteResponse(limit);
    this.endSse();
  }

  dispose(): void {
    clearInterval(this.keepAlive);
    if (this.context.spawnSession)
      spawnSessions.close(this.context.spawnSession);
    this.response.removeListener("error", this.onResponseError);
  }

  private emitInitialEvents(): void {
    this.emit("response.created", {
      type: "response.created",
      response: {
        id: this.responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: this.context.payload.model,
        status: "in_progress",
        output: []
      }
    });
    this.emit(EVENT_OUTPUT_ITEM_ADDED, {
      type: EVENT_OUTPUT_ITEM_ADDED,
      output_index: 0,
      item: {
        id: this.reasoningId,
        type: "reasoning",
        status: "in_progress",
        summary: [],
        content: []
      }
    });
    this.emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" }
    });
    this.emit(EVENT_OUTPUT_ITEM_ADDED, {
      type: EVENT_OUTPUT_ITEM_ADDED,
      output_index: 1,
      item: {
        id: this.itemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: []
      }
    });
    this.emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.itemId,
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });
  }

  private emitCompletedItems(
    reasoningText: string,
    text: string,
    reasoning: object,
    message: object
  ): void {
    this.emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      text: reasoningText
    });
    this.emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: reasoningText }
    });
    this.emit(EVENT_OUTPUT_ITEM_DONE, {
      type: EVENT_OUTPUT_ITEM_DONE,
      output_index: 0,
      item: reasoning
    });
    this.emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: this.itemId,
      text,
      content_index: 0,
      output_index: 1
    });
    this.emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: this.itemId,
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] }
    });
    this.emit(EVENT_OUTPUT_ITEM_DONE, {
      type: EVENT_OUTPUT_ITEM_DONE,
      output_index: 1,
      item: message
    });
  }

  private emitIncompleteResponse(
    limit: ReturnType<typeof classifyCliLimit>
  ): void {
    const events = terminalIncompleteEvents({
      responseId: this.responseId,
      itemId: this.itemId,
      reasoningId: this.reasoningId,
      text: this.partialText,
      reasoningText: this.activityParts.join(""),
      reason: limit
        ? INCOMPLETE_REASON_PROVIDER_LIMIT
        : INCOMPLETE_REASON_INTERRUPTED,
      limit,
      provider: "copilot",
      response: responsePayload(
        this.context.payload.model,
        this.partialText,
        null,
        this.responseId,
        this.itemId,
        [],
        "incomplete"
      )
    });
    for (const [eventName, body] of events) this.emit(eventName, body);
  }

  private sendInitialFailure(
    message: string,
    limit: ReturnType<typeof classifyCliLimit>
  ): void {
    const status =
      limit &&
      ["throttled", "session_limit", "quota_exhausted"].includes(
        limit.limitClass
      )
        ? 429
        : 503;
    const headers = limitResponseHeaders(limit);
    const retryAfter = retryAfterSecondsFromLimit(limit);
    if (retryAfter !== null) headers["retry-after"] = String(retryAfter);
    const error: JsonRecord = { type: "copilot_proxy_error", message };
    const declaredLimit = limitPayload(limit);
    if (declaredLimit)
      sendJson(
        this.response,
        status,
        { error: { ...error, limit: declaredLimit } },
        headers
      );
    else sendJson(this.response, status, { error }, headers);
  }

  private emitActivity(text: string, key: string): void {
    if (!text || this.seenActivities.has(key) || !this.isWritable()) return;
    this.seenActivities.add(key);
    this.activityParts.push(text);
    this.emit("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: text + "\n"
    });
  }

  private emit(eventName: string, body: object): void {
    const event = sseLine(eventName, {
      ...body,
      sequence_number: ++this.sequenceNumber
    });
    if (!this.isWritable()) return;
    if (!this.streamStarted) {
      this.pendingEvents.push(event);
      return;
    }
    this.write(event);
  }

  private startStream(): void {
    if (this.streamStarted || !this.isWritable()) return;
    this.streamStarted = true;
    this.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close"
    });
    this.response.flushHeaders();
    this.response.shouldKeepAlive = false;
    for (const event of this.pendingEvents.splice(0)) {
      if (!this.isWritable()) break;
      this.write(event);
    }
  }

  private write(event: string): void {
    try {
      this.response.write(event);
    } catch {
      // The peer may have already closed the connection; a racing write is not actionable.
    }
  }

  private writeKeepAlive(): void {
    if (typeof this.context.agentEvents?.reportHeartbeat === "function") {
      void this.context.agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }
    if (this.streamStarted && this.isWritable())
      this.write(": copilot-bridge keep-alive\n\n");
  }

  private cancelClient(): void {
    this.clientClosed = true;
    clearInterval(this.keepAlive);
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }

  private isWritable(): boolean {
    return (
      !this.clientClosed &&
      !this.response.writableEnded &&
      !this.response.destroyed &&
      !this.response.closed
    );
  }

  private endSse(): void {
    if (!this.isWritable()) return;
    try {
      this.response.end("data: [DONE]\n\n");
    } catch {
      // The peer may have already closed the connection; a racing end is not actionable.
    }
  }
}

function copilotErrorExitCode(error: unknown): number | null {
  if (!isJsonRecord(error) || typeof error.exitCode !== "number") return null;
  return error.exitCode;
}

function buildCopilotSpawnOutput(
  context: CopilotRequestContext,
  outputIndex: number
): SpawnToolCallOutput | null {
  const session = context.spawnSession;
  if (!session) return null;
  return buildSpawnToolCallOutput(
    spawnSessions.close(session),
    session,
    outputIndex
  );
}

function appendCopilotSpawnItem(
  context: CopilotRequestContext,
  output: object[]
): void {
  const spawnOutput = buildCopilotSpawnOutput(context, output.length);
  if (!spawnOutput) return;
  output.push(spawnOutput.events[3][1].item);
  writeErrorLine(
    "copilot delegating " +
      spawnOutput.childCount +
      " subagent(s) through Codex"
  );
}

async function readRequestRecord(
  request: IncomingMessage,
  response: ServerResponse,
  invalidBody: object
): Promise<JsonRecord | null> {
  const parsed = parseJson(await bodyOf(request));
  if (!parsed.ok || !isJsonRecord(parsed.value)) {
    sendJson(response, 400, invalidBody);
    return null;
  }
  return parsed.value;
}

async function handleSpawnRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<void> {
  if (AUTH_TOKEN && request.headers.authorization !== "Bearer " + AUTH_TOKEN) {
    sendJson(response, 401, { error: "invalid local gateway key" });
    return;
  }
  const body = await readRequestRecord(request, response, {
    error: "invalid JSON"
  });
  if (!body) return;
  const session = typeof body.session === "string" ? body.session : "";
  if (pathname.endsWith("/attach")) {
    sendJson(response, 200, {
      spawnAllowed: spawnSessions.mayDelegate(session)
    });
    return;
  }
  const result = spawnSessions.record(session, body.children);
  if (!result.accepted) {
    sendJson(response, 409, { error: result.message });
    return;
  }
  sendJson(response, 200, {
    text:
      "Dispatched " +
      result.count +
      " subagent(s): " +
      result.roles +
      ". They are running now and are tracked by the orchestration layer, not by you."
  });
}

function resolveCopilotWorkspace(
  payload: JsonRecord,
  request: IncomingMessage,
  response: ServerResponse
): string | null {
  try {
    return resolveCwd(payload, request.headers, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    sendWorkspaceResolutionFailure(response, "copilot", error);
    return null;
  }
}

function reportCopilotExposure(
  agentEvents: AgentReporter | null,
  contract: CopilotRoleContract
): void {
  if (!agentEvents) return;
  for (const skill of contract.skills ?? []) {
    void agentEvents.reportSkillExposed({
      skill,
      source: SKILL_EXPOSURE_SOURCE
    });
  }
  for (const server of contract.mcp ?? []) {
    if (typeof agentEvents.reportMcpExposed === "function") {
      void agentEvents.reportMcpExposed({
        server,
        source: MCP_EXPOSURE_SOURCE
      });
    } else if (typeof agentEvents.post === "function") {
      void agentEvents.post([
        { type: "mcp_exposed", server, source: MCP_EXPOSURE_SOURCE }
      ]);
    }
  }
}

function prepareCopilotRequest(
  request: IncomingMessage,
  response: ServerResponse,
  payload: JsonRecord
): CopilotRequestContext | null {
  const cwd = resolveCopilotWorkspace(payload, request, response);
  if (!cwd) return null;
  const headers: Record<string, unknown> = { ...request.headers };
  const agentRole = resolveAgentRole(request.headers);
  const workspaceKey = request.headers[AUTODEV_WORKSPACE_KEY_HEADER];
  const agentEvents = resolveAgentEventReporter(headers);
  const sandboxModeHeader = readOnlyHeaderValue(headers);
  const skillContextHeader = bridgeSkillContext(headers);
  const sandboxInjection = readOnlySystemPromptInjection(headers);
  const composedPrompt =
    composeProviderPrompt(agentRole, cwd) + sandboxInjection;
  const finalPrompt =
    composedPrompt +
    (skillContextHeader
      ? "\n\n## Selected skill context (propagated from orchestrator)\n\n" +
        skillContextHeader +
        "\n"
      : "");
  const prompt = inputText(payload.input, finalPrompt);
  const sessionHeader = headerValue(request.headers, "x-autodev-session-id");
  const sessionScope = headerValue(request.headers, "x-autodev-session-scope");
  const spawnSession = SpawnSessionRegistry.canHold(sessionHeader, sessionScope)
    ? sessionHeader
    : null;
  if (spawnSession)
    spawnSessions.open(spawnSession, {
      orchestrator: isOrchestratorRole(agentRole)
    });
  const bootstrapContract = copilotRoleContract(agentRole);
  writeErrorLine(
    "copilot bootstrap provider=copilot model=" +
      payload.model +
      " role=" +
      (agentRole ?? "default") +
      " cwd=" +
      cwd +
      " skills=" +
      JSON.stringify(bootstrapContract.skills ?? []) +
      " mcp=" +
      JSON.stringify(bootstrapContract.mcp ?? [])
  );
  writeErrorLine(
    "copilot request model=" +
      payload.model +
      " role=" +
      (isOrchestratorRole(agentRole) ? "orchestrator" : "leaf") +
      " cwd=" +
      cwd
  );
  reportCopilotExposure(agentEvents, bootstrapContract);
  return {
    payload,
    agentRole,
    workspaceKey,
    agentEvents,
    cwd,
    prompt,
    spawnSession,
    sandboxModeHeader
  };
}

function reportCopilotHeartbeat(context: CopilotRequestContext): void {
  if (typeof context.agentEvents?.reportHeartbeat === "function") {
    void context.agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
  }
}

async function sendCopilotNonStreamingResponse(
  context: CopilotRequestContext,
  response: ServerResponse
): Promise<void> {
  const nonStreamHeartbeat = setInterval(
    () => reportCopilotHeartbeat(context),
    5000
  );
  let result: RunCopilotResult;
  try {
    try {
      result = await runCopilot(
        context.prompt,
        context.payload.model,
        context.cwd,
        (event) => {
          reportCopilotHeartbeat(context);
          reportToolObservation(context.agentEvents, event);
        },
        context.agentRole,
        context.spawnSession,
        context.sandboxModeHeader,
        context.workspaceKey
      );
    } finally {
      clearInterval(nonStreamHeartbeat);
    }
  } catch (error) {
    if (context.spawnSession) spawnSessions.close(context.spawnSession);
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 503, {
      error: { type: "copilot_proxy_error", message }
    });
    return;
  }
  const output: object[] = [
    responseMessageItem(result.text, "msg_" + randomBytes(10).toString("hex"))
  ];
  appendCopilotSpawnItem(context, output);
  sendJson(
    response,
    200,
    responsePayload(
      context.payload.model,
      result.text,
      result.result,
      undefined,
      undefined,
      output
    )
  );
}

async function streamCopilotResponse(
  context: CopilotRequestContext,
  response: ServerResponse
): Promise<void> {
  const stream = new CopilotResponseStream(context, response);
  try {
    const result = await runCopilot(
      context.prompt,
      context.payload.model,
      context.cwd,
      (event) => stream.acceptEvent(event),
      context.agentRole,
      context.spawnSession,
      context.sandboxModeHeader,
      context.workspaceKey
    );
    stream.complete(result);
  } catch (error) {
    stream.fail(error);
  } finally {
    stream.dispose();
  }
}

async function handleResponsesRoute(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readRequestRecord(request, response, {
    error: { message: "invalid JSON", type: "invalid_request_error" }
  });
  if (!payload) return;
  const context = prepareCopilotRequest(request, response, payload);
  if (!context) return;
  if (payload.stream === false) {
    await sendCopilotNonStreamingResponse(context, response);
    return;
  }
  await streamCopilotResponse(context, response);
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://" + HOST + ":" + PORT)
    .pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, {
      status: "ok",
      provider: "copilot",
      spawnSessions: spawnSessions.status()
    });
    return;
  }
  if (
    pathname === "/v1/bridge-spawn/attach" ||
    pathname === "/v1/bridge-spawn/call"
  ) {
    await handleSpawnRoute(request, response, pathname);
    return;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, {
      error: { message: "not found", type: "invalid_request_error" }
    });
    return;
  }
  await handleResponsesRoute(request, response);
}

if (IS_MAIN) {
  createServer((request, response) => {
    void handle(request, response);
  }).listen(PORT, HOST, () => {
    writeErrorLine(
      `Copilot Responses proxy listening at http://${HOST}:${PORT}`
    );
  });
}

export {
  copilotMcpArgs,
  copilotToolOutcome,
  extractSkillReadPath,
  inputText,
  isResearchRole,
  matchSkillReadPath,
  MCP_EXPOSURE_SOURCE,
  reportToolObservation,
  RESEARCH_CAPABLE_ROLES,
  runCopilot,
  SKILL_EXPOSURE_SOURCE,
  skillReadEvent
};
