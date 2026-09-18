#!/usr/bin/env node

/**
 * Local OpenAI Responses adapter backed by the authenticated Claude CLI.
 *
 * The Claude CLI is run in stream-json mode so a slow or rate-limited upstream
 * request cannot look like a dead Codex task. The adapter keeps the CLI's
 * OAuth-only environment and translates its text deltas into Responses SSE.
 *
 * Mirrors the Antigravity and Copilot bridges' transport, telemetry, and
 * boundary conventions so they cannot drift; pure helpers stay importable for
 * tests without taking the port out from under the running bridge.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveCwd, WorkspaceResolutionError } from "../shared/resolve-workspace.ts";
import { composeProviderPrompt, isOrchestratorRole, resolveAgentRole } from "../agents/bridge-role.ts";
import { roleContract } from "../shared/execution-contract.ts";
import type { RoleContract } from "../shared/execution-contract.ts";
import { classifyCliLimit, INCOMPLETE_REASON_INTERRUPTED, INCOMPLETE_REASON_PROVIDER_LIMIT, INCOMPLETE_REASON_TIMEOUT, limitPayload, limitResponseHeaders, retryAfterSecondsFromLimit, terminalIncompleteEvents } from "../shared/provider-limits.ts";
import type { LimitSource, ProviderLimit } from "../shared/provider-limits.ts";
import { resolveAgentEventReporter, SKILL_READ_SOURCE } from "../telemetry/agent-events.ts";
import type { AgentEventReporter } from "../telemetry/agent-events.ts";
import { SpawnSessionRegistry } from "../agents/bridge-spawn-session.ts";
import { buildSpawnScript, execToolCallSseEvents, mintCallId, mintCallItemId } from "../agents/spawn-tools.ts";

// Bind the port only when run as a program, so this file can be imported for
// its pure helpers without taking the port out from under the running bridge.
// Mirrors the Antigravity, MiniMax, and Copilot adapters.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const HOST = process.env.CLAUDE_BRIDGE_HOST ?? "127.0.0.1";
// Overridable so a second instance can be exercised without taking the port out
// from under the running service, matching the MiniMax and Antigravity proxies.
// The launchd service sets neither and keeps the default.
const PORT = Number.parseInt(process.env.CLAUDE_BRIDGE_PORT ?? "4000", 10);
const MODEL = "claude-subscription";
const AUTH_TOKEN = process.env.LITELLM_API_KEY ?? "";
const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT ?? null;
// Match the router and Antigravity bridge's long-running turn budget. Operators
// can still choose a shorter/longer limit through the environment, but a
// default five-minute ceiling made legitimate tool-heavy subagent turns look
// like premature transport failures.
const CLAUDE_TIMEOUT_SECONDS = Number.parseFloat(process.env.CLAUDE_CODE_BRIDGE_TIMEOUT_SECONDS ?? "900");
const CLI = process.env.CLAUDE_BIN ?? join(process.env.HOME ?? homedir(), ".local/bin/claude");
const DEFAULT_CLAUDE_MODEL = "sonnet";
const DEFAULT_CLAUDE_EFFORT = "medium";
// Claude Code's Agent tool (Task in older releases) is the recursive boundary.
// Keep it unavailable for every request sent through this gateway; the parent
// Codex process remains responsible for orchestration.
const DISALLOWED_CLAUDE_TOOLS = [ "Agent", "Task" ];
// The MCP backend is launched by the bridge, but the model must not invoke the
// CocoIndex CLI through Claude's Bash tool as a fallback.
const DISALLOWED_CLI_COMMANDS = [ "Bash(ccc *)" ];

// Tools that reach *outside* this turn's own agent tree, to other Claude
// sessions running on the same machine. Denied for every role, orchestrator
// included: an AutoDev turn's blast radius is its own workspace and its own
// children, and one orchestrator reaching another orchestrator's agents is
// outside it in both directions.
//
// Measured on Claude Code 2.1.260, a `-p` print-mode process -- which is the
// only way this bridge ever starts the CLI -- does not register on the peer
// socket bus at all, so these tools are not available to it today and denying
// them changes nothing now. That is exactly why it is worth pinning: the
// isolation currently rests on an undocumented property of print mode, and a
// future release that exposes peer messaging headlessly would silently widen
// every bridged agent's reach. An unknown name in --disallowed-tools is inert,
// so this costs nothing while that property holds.
const CROSS_SESSION_CLAUDE_TOOLS = [ "SendMessage", "ListAgents" ];

// Claude Code runs behind the Responses bridge rather than loading Codex's TOML
// role file. Keep the browser role's MCP contract here too: otherwise a native
// Codex child sees Playwright while a browser-tester routed to Claude silently
// falls back to shell-only investigation. The prefixed names are the tool names
// Claude Code assigns to an MCP server's tools.
const PLAYWRIGHT_AGENT_ROLES = new Set([ "browser-tester", "smart" ]);
const PLAYWRIGHT_DISALLOWED_TOOLS = [
  "mcp__playwright__browser_drop",
  "mcp__playwright__browser_evaluate",
  "mcp__playwright__browser_file_upload",
  "mcp__playwright__browser_navigate_back",
  "mcp__playwright__browser_network_request",
  "mcp__playwright__browser_run_code_unsafe",
];
const RESEARCH_CAPABLE_ROLES = new Set([ "docs-researcher", "smart", "orchestrator" ]);
const CLAUDE_RESEARCH_ALLOWED_TOOLS = [ "WebSearch", "WebFetch" ];

// Provider payloads are JSON-shaped but intentionally retain fields this
// bridge does not own (the Claude CLI's event stream is not a formally
// specified schema). Keep that dynamic edge explicit while the transport,
// telemetry, and boundary operations around it stay typed. Mirrors the
// Antigravity, MiniMax, and Copilot adapters.
type JsonRecord = Record<string, unknown>;
type JsonValue = unknown;

const _CLAUDE_MODEL_PATTERN = /^claude-[A-Za-z0-9][A-Za-z0-9.-]*$/;
const _CLAUDE_FAMILY_NAMES = new Set([ "sonnet", "opus", "haiku" ]);
const _CLAUDE_EFFORT_LEVELS = new Set([ "low", "medium", "high", "xhigh", "max" ]);

/**
 * Claude rejected the request because an account/session limit applies.
 *
 * Carries the limit structurally as well as in the message: the router needs
 * the class and the real reset time to decide how long to stop routing here,
 * and re-deriving either by matching this message's prose is exactly the
 * guessing this field set exists to end.
 */
export class ClaudeRateLimitError extends Error {
  readonly limitClass: string;
  readonly limitType: string | null;
  readonly resetsAt: string | null;
  readonly source: string;
  constructor(message: string, limitClass = "session_limit", limitType: string | null = null, resetsAt: string | null = null, source: string) {
    super(message);
    this.name = "ClaudeRateLimitError";
    this.limitClass = limitClass;
    this.limitType = limitType;
    this.resetsAt = resetsAt;
    this.source = source;
  }
  /** The wire shape the router reads from `error.limit` or `incomplete_details.provider_limit`. */
  toLimit(): ProviderLimit {
    const limit: ProviderLimit = { limitClass: this.limitClass as ProviderLimit["limitClass"], limitType: this.limitType, source: this.source as LimitSource };
    if (this.resetsAt !== null) limit.resetsAt = this.resetsAt;
    return limit;
  }
}

/** Claude temporarily reported capacity pressure. */
export class ClaudeOverloadedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeOverloadedError";
  }
}

// `roleContract` types the fields every consumer shares (`mcp`) and leaves
// the rest behind an index signature. This bridge additionally reads
// `readOnly` and `skills`, which are real contract fields; narrow them here
// rather than widening the shared type for one bridge's shape. Mirrors the
// Antigravity and Copilot adapters.
type ClaudeRoleContract = RoleContract & { readOnly?: boolean; skills?: string[] };

function claudeRoleContract(role: unknown): ClaudeRoleContract {
  return roleContract(role) as ClaudeRoleContract;
}

const HOME = homedir();
const REPO_ROOT = process.env.AUTODEV_REPO_ROOT || resolve(join(import.meta.dirname, "..", ".."));

// Canonical skill roots whose `SKILL.md` a successful `Read` counts as actual
// usage, mirroring the approved roots `src/hooks/skill-read-telemetry.ts`
// uses for Codex's own PreToolUse hook. The Claude CLI's own `Read` tool runs
// entirely inside its runtime and never reaches that hook, so this bridge is
// the only place a read of one of these files is observable at all.
const SKILL_ROOTS = [
  join(HOME, ".agents", "skills"),
  join(HOME, ".codex", "skills"),
  join(HOME, "AutoDev", ".agents", "skills"),
  join(HOME, "AutoDev", ".rulesync", "skills"),
  join(REPO_ROOT, ".agents", "skills"),
  join(REPO_ROOT, ".rulesync", "skills"),
].filter(( (path) => existsSync(path)));

// How a Claude turn comes by the skills its role contract grants it: the
// generated `.claude/skills` view below, not a `$skill` invocation. Carried
// on every `skill_exposed` event so the router's rows say which mechanism
// made the skill available rather than only that something did.
export const CLAUDE_SKILL_EXPOSURE_SOURCE = "claude_skill_view";
export const CLAUDE_MCP_EXPOSURE_SOURCE = "role_contract";
export const CLAUDE_SKILL_READ_SOURCE = SKILL_READ_SOURCE;

// Tool names the Claude CLI uses to read a file's contents outright, versus
// the shell tools whose command line may contain a read of one. Anything
// else -- `Write`, `Edit`, `Task` -- is deliberately excluded: a mutation or
// an unrelated call must never be counted as a skill activation just because
// its arguments happen to name a path.
const CLAUDE_READ_TOOL_NAMES = new Set([ "Read" ]);
const CLAUDE_EXEC_TOOL_NAMES = new Set([ "Bash" ]);
const SKILL_READ_COMMANDS = new Set([ "cat", "head", "tail", "less", "more", "awk", "grep" ]);
const SHELL_CONTROL_TOKENS = new Set([ "|", "&&", "||", ";", "&" ]);

function normaliseSkillReadPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  let path = trimmed;
  if (path.startsWith("~")) path = join(HOME, path.slice(1));
  if (!isAbsolute(path)) path = resolve(path);
  return path;
}

// Splits a shell command into words, honouring single- and double-quoted
// spans so a quoted path containing a space (`cat "/a b/SKILL.md"`) is not
// broken across two tokens. Not a full shell grammar -- backslash escapes
// and `$()`/backtick substitution are not unwound -- but enough to recover
// the plain file arguments Claude's tool calls put on these command lines.
function tokenizeShellWords(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cmd)) !== null) {
    let token = match[0];
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
      token = token.slice(1, -1);
    }
    tokens.push(token);
  }
  return tokens;
}

// A word counts as a path argument, not a flag or a search pattern, once it
// contains a path separator or starts with `~`. This deliberately accepts
// only absolute or home-relative paths so a command cannot be attributed to
// the wrong working directory.
function isPathLikeToken(token: unknown): string | null {
  if (typeof token !== "string" || !token || token.startsWith("-")) return null;
  if (token.startsWith("/") || token.startsWith("~")) return token;
  return null;
}

// Resolves the raw value of a `command`/`cmd` argument to a single shell
// string. Providers vary in how they shape this: a plain string, an argv
// array (`["bash", "-lc", "cat file"]` or `["["cat", "file"]`), or a nested
// object carrying the real command one level down (`{"command": {"cmd": "..."}}`).
// Only one level of object nesting is unwrapped -- deeper nesting is not a
// shape any tool call here actually uses.
function flattenCommandValue(raw: unknown): string {
  let value: unknown = raw;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as JsonRecord;
    value = record.cmd ?? record.command ?? record.script ?? record.value ?? null;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).filter((entry) => typeof entry === "string").join(" ");
  }
  return typeof value === "string" ? value : "";
}

// Every path-like argument following a recognised read command on the command
// line, in the order they appear. Bounded on both axes: overlong commands
// are rejected outright, and only the next 8 words after a read command are
// scanned for a path. Returning every candidate -- not just the first --
// lets the caller pick out whichever one actually names a SKILL.md when a
// command reads more than one file (`grep pattern a.md SKILL.md`).
function matchExecReadPaths(raw: unknown): string[] {
  const cmd = flattenCommandValue(raw);
  if (!cmd || cmd.length > 4096) return [];
  const tokens = tokenizeShellWords(cmd);
  const candidates: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i] ?? "";
    const isSedPrint = word === "sed" && tokens[i + 1] === "-n";
    if (!SKILL_READ_COMMANDS.has(word) && !isSedPrint) continue;
    const start = isSedPrint ? i + 2 : i + 1;
    for (let j = start; j < tokens.length && j < start + 8; j++) {
      const next = tokens[j] ?? "";
      if (SHELL_CONTROL_TOKENS.has(next)) break;
      const path = isPathLikeToken(next);
      if (path) candidates.push(path);
    }
  }
  return candidates;
}

/** The path a `Read` call or a shell read of one names, if any. */
export function extractSkillReadPath(toolName: unknown, toolInput: unknown): string | null {
  const name = String(toolName ?? "").trim();
  const args: JsonRecord = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as JsonRecord : {};
  if (CLAUDE_READ_TOOL_NAMES.has(name)) {
    for (const key of [ "file_path", "filePath", "path", "filepath", "absolutePath", "AbsolutePath", "targetFile", "TargetFile" ]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }
  if (CLAUDE_EXEC_TOOL_NAMES.has(name)) {
    const command = typeof toolInput === "string" ? toolInput : (args.command ?? args.cmd);
    const candidates = matchExecReadPaths(command);
    for (const candidate of candidates) {
      if (matchSkillReadPath(normaliseSkillReadPath(candidate))) return candidate;
    }
    return candidates[0] ?? null;
  }
  return null;
}

// True when `path` resolves to `<root>/<skill-name>/SKILL.md` for one of the
// approved roots. Returns the skill's directory name -- never the absolute
// path -- because that is all the router retains.
export function matchSkillReadPath(path: string | null): string | null {
  if (!path) return null;
  const normalised = path.replace(/[\\/]+/g, sep);
  for (const rootRaw of SKILL_ROOTS) {
    const root = rootRaw.replace(/[\\/]+/g, sep);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!normalised.startsWith(rootWithSep)) continue;
    const relative = normalised.slice(root.length).replace(/^[\\/]+/, "");
    if (!relative.endsWith(`${sep}SKILL.md`) && relative !== "SKILL.md") continue;
    const segments = relative.split(sep).filter(Boolean);
    if (segments.length !== 2) continue;
    const [ skill ] = segments;
    if (!skill || skill.includes("..")) continue;
    return skill;
  }
  return null;
}

export function resolvedModel(requested: unknown): string {
  if (typeof requested !== "string") return DEFAULT_CLAUDE_MODEL;
  const candidate = requested.trim();
  if (!candidate) return DEFAULT_CLAUDE_MODEL;
  const lowered = candidate.toLowerCase();
  if (lowered.startsWith("claude-subscription") || lowered.startsWith("anthropic.")) return DEFAULT_CLAUDE_MODEL;
  if (_CLAUDE_FAMILY_NAMES.has(lowered)) return lowered;
  if (_CLAUDE_MODEL_PATTERN.test(candidate)) return candidate;
  return DEFAULT_CLAUDE_MODEL;
}

export function resolveClaudeEffort(requested: unknown): string {
  if (typeof requested !== "string") return DEFAULT_CLAUDE_EFFORT;
  const candidate = requested.trim().toLowerCase();
  return _CLAUDE_EFFORT_LEVELS.has(candidate) ? candidate : DEFAULT_CLAUDE_EFFORT;
}

function requestedEffort(request: JsonRecord): unknown {
  const reasoning = request.reasoning;
  if (reasoning && typeof reasoning === "object" && "effort" in reasoning) return (reasoning as JsonRecord).effort;
  for (const key of [ "model_reasoning_effort", "reasoning_effort" ]) {
    if (key in request) return request[key];
  }
  return null;
}

/** The model shape expected by current Codex model discovery. */
export function claudeModelMetadata(): JsonRecord {
  return {
    slug: MODEL,
    apply_patch_tool_type: "freeform",
    base_instructions: "You are a bounded external-provider Codex agent.",
    display_name: "Claude Code subscription",
    description: "Claude Code OAuth subscription through the local bridge.",
    default_reasoning_level: DEFAULT_CLAUDE_EFFORT,
    default_reasoning_summary: "none",
    default_verbosity: "low",
    supported_reasoning_levels: [ "low", "medium", "high" ].map((effort) => ({ effort, description: `Claude Code ${effort} reasoning` })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: 200000,
    max_context_window: 200000,
    model_messages: { instructions_template: "You are a bounded external-provider Codex agent." },
    input_modalities: [ "text" ],
    experimental_supported_tools: [ "web_search", "web_fetch" ],
    support_verbosity: false,
    supports_parallel_tool_calls: false,
    supports_search_tool: true,
    tool_mode: "code_mode_only",
    truncation_policy: { mode: "tokens", limit: 10000 },
    use_responses_lite: true,
    multi_agent_version: "v1",
    node_repl_auto_review_required: false,
    node_repl_disabled: true,
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_skills_usage_instructions: false,
    comp_hash: "local-claude-bridge",
    effective_context_window_percent: 95,
  };
}

// The MCP server a Claude tool name belongs to, or null for a builtin.
//
// Claude namespaces every MCP tool as ``mcp__<server>__<tool>``, so the
// server is recoverable from the name alone -- which is the only place this
// bridge ever sees it. The router keeps it as a row dimension so an MCP
// server that is configured but never actually reached is distinguishable
// from one whose tools ran.
export function claudeToolServer(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const label = name.trim();
  if (!label.startsWith("mcp__")) return null;
  const parts = label.split("__");
  return parts.length >= 3 && parts[1] ? parts[1] : null;
}

// The child agent type an `Agent`/`Task` call names, when it names one.
export function subagentRoleFromInput(block: JsonRecord): string | null {
  const payload = block.input;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  for (const key of [ "subagent_type", "agent_type", "agent" ]) {
    const value = (payload as JsonRecord)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as JsonRecord[]).map((block) => typeof block === "object" && block && (block as JsonRecord).type === "text" ? String((block as JsonRecord).text ?? "") : "").join("");
}

function nestedText(event: JsonRecord): string {
  const inner = event.event;
  if (!inner || typeof inner !== "object") return "";
  const delta = (inner as JsonRecord).delta;
  if (delta && typeof delta === "object" && (delta as JsonRecord).type === "text_delta") {
    return String((delta as JsonRecord).text ?? "");
  }
  return "";
}

function emitOnce(text: string, key: string, seen: Set<string>): string {
  if (seen.has(key)) return "";
  seen.add(key);
  return `${text}\n`;
}

/** Progress text for one Claude CLI event, or "" when it carries none. */
export function activityFromEvent(event: JsonRecord, seen: Set<string>): string {
  const eventType = event.type;
  if (eventType === "stream_event") {
    const inner = event.event;
    if (!inner || typeof inner !== "object") return "";
    const innerTyped = inner as JsonRecord;
    if (innerTyped.type === "content_block_delta") {
      const delta = innerTyped.delta;
      if (delta && typeof delta === "object" && (delta as JsonRecord).type === "thinking_delta") {
        return String((delta as JsonRecord).thinking ?? "");
      }
      return "";
    }
    if (innerTyped.type === "content_block_start") {
      const block = innerTyped.content_block;
      if (block && typeof block === "object" && (block as JsonRecord).type === "tool_use") {
        const name = String((block as JsonRecord).name || "a tool");
        return emitOnce(`Claude is using ${name}.`, `tool:${(block as JsonRecord).id}`, seen);
      }
    }
    return "";
  }
  if (eventType === "system" && event.subtype === "task_summary") {
    const detail = event.detail;
    if (typeof detail === "string" && detail.trim()) {
      return emitOnce(detail.trim(), `summary:${event.uuid}`, seen);
    }
  }
  return "";
}

/**
 * Reassembles streamed `tool_use` blocks into completed calls.
 *
 * Claude opens a tool_use block with an empty `input` and streams the
 * arguments as `input_json_delta` fragments, so `content_block_start` carries
 * the tool name but never the arguments. A completed block is also the point
 * at which the tool actually runs -- a block the stream abandons was never
 * invoked -- so blocks are emitted on `content_block_stop`, with the
 * accumulated arguments parsed back into `input`.
 */
export class ToolUseAccumulator {
  private readonly open = new Map<number, [ JsonRecord, string[] ]>();
  /** Returns a completed block on `content_block_stop`, else null. */
  feed(event: JsonRecord): JsonRecord | null {
    if (event.type !== "stream_event") return null;
    const inner = event.event;
    if (!inner || typeof inner !== "object") return null;
    const innerTyped = inner as JsonRecord;
    const index = innerTyped.index;
    const innerType = innerTyped.type;
    if (innerType === "content_block_start") {
      const block = innerTyped.content_block;
      if (block && typeof block === "object" && (block as JsonRecord).type === "tool_use") {
        this.open.set(Number(index), [ block as JsonRecord, [] ]);
      }
      return null;
    }
    if (innerType === "content_block_delta") {
      const delta = innerTyped.delta;
      if (delta && typeof delta === "object" && (delta as JsonRecord).type === "input_json_delta" && typeof index === "number") {
        const entry = this.open.get(index);
        if (entry) entry[1].push(String((delta as JsonRecord).partial_json ?? ""));
      }
      return null;
    }
    if (innerType !== "content_block_stop" || typeof index !== "number") return null;
    const entry = this.open.get(index);
    if (!entry) return null;
    this.open.delete(index);
    const [ block, fragments ] = entry;
    let argumentsValue: JsonRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(fragments.join(""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) argumentsValue = parsed as JsonRecord;
    } catch {
      argumentsValue = null;
    }
    return { ...block, input: argumentsValue ?? (block.input as JsonValue) };
  }
}

// Claude reports a tool call's outcome as a `tool_result` block on the
// synthetic user turn that follows the call, carrying the `tool_use_id` of
// the call it settles. That block is the only place in this stream where a
// tool call is *proved* to have run -- a `tool_use` block only proves the
// model asked -- so it is what the bridge reports as `tool_executed`.
export function toolResultsFromEvent(event: JsonRecord): JsonRecord[] {
  if (event.type !== "user") return [];
  const message = event.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as JsonRecord).content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => typeof block === "object" && block && (block as JsonRecord).type === "tool_result") as JsonRecord[];
}

function toolResultText(block: JsonRecord): string {
  const content = block.content;
  if (typeof content === "string") return content;
  return textFromContent(content);
}

// A failed tool call and a tool the workspace would not run are different
// facts, and only the second one belongs in `tool_unavailable`: the router
// counts that event as "the provider offered it but something stopped it from
// running", which a failing command is not. These are the CLI's own wordings
// for the second case -- Claude Code emits "Permission to use X has been
// denied[ because Claude Code is running in don't ask mode]", "Permission for
// this tool use was denied: it requires interactive approval", and "Error: No
// such tool available: X" -- so anything else that sets `is_error` is
// reported as a call that ran and failed.
const TOOL_UNAVAILABLE_PATTERNS: ReadonlyArray<[ RegExp, string ]> = [
  [ /No such tool available/i, "no_such_tool" ],
  [ /Permission (?:to use \S+ has been|for this tool use was) denied/i, "permission_denied" ],
];

/** `("executed", "ok"|"error")` or `("unavailable", reason)`. */
export function classifyToolResult(block: JsonRecord): { kind: "executed" | "unavailable"; detail: string } {
  if (!block.is_error) return { kind: "executed", detail: "ok" };
  const text = toolResultText(block);
  for (const [ pattern, reason ] of TOOL_UNAVAILABLE_PATTERNS) {
    if (pattern.test(text)) return { kind: "unavailable", detail: reason };
  }
  return { kind: "executed", detail: "error" };
}

// Build Claude's own structural error from its `rate_limit_event`.
//
// This is the one place a Claude limit is *reported* rather than inferred, so
// it is the only path that hands the router a reset time it will trust.
export function rateLimitEventError(event: JsonRecord): ClaudeRateLimitError | null {
  const rateInfo = event.rate_limit_info;
  if (!rateInfo || typeof rateInfo !== "object") return null;
  const info = rateInfo as JsonRecord;
  const status = info.status;
  if (!status || status === "allowed") return null;
  const limitType = info.rateLimitType ?? "session";
  const resetsAt = normalizeResetsAt(info.resetsAt);
  // A rejected weekly or billing window is exhaustion until it resets; a
  // rejected session window is a session limit; anything else is throttling
  // that clears on its own.
  let limitClass = "throttled";
  if (/week|month|quota|billing|credit/i.test(String(limitType))) limitClass = "quota_exhausted";
  else if (status === "rejected") limitClass = "session_limit";
  let message = `Claude rate limit (${limitType}): status is ${status}`;
  if (resetsAt) message += ` (resets at ${resetsAt})`;
  return new ClaudeRateLimitError(message, limitClass, String(limitType), resetsAt, "reported");
}

export function classifyClaudeError(message: unknown, errorCode: unknown): typeof ClaudeRateLimitError | typeof ClaudeOverloadedError | null {
  const text = String(message ?? "");
  if (errorCode === "rate_limit" || /rate.?limit|weekly.?limit|quota|credit|session.?limit|too many requests/i.test(text)) {
    return ClaudeRateLimitError;
  }
  if (errorCode === "overloaded_error" || /overload|high.?demand|capacity/i.test(text)) {
    return ClaudeOverloadedError;
  }
  return null;
}

export function raiseClassifiedClaudeError(message: unknown, errorCode: unknown): void {
  const errorType = classifyClaudeError(message, errorCode);
  if (!errorType) return;
  if (errorType === ClaudeRateLimitError) {
    // An error message is free text, so whatever it yields stays `inferred`
    // and cannot trigger a long hard cooldown downstream.
    const limit = classifyCliLimit(message);
    throw new ClaudeRateLimitError(
      String(message),
      limit?.limitClass ?? "throttled",
      limit?.limitType ?? null,
      limit?.resetsAt ?? null,
      "inferred",
    );
  }
  throw new ClaudeOverloadedError(String(message));
}

/** Node lowercases inbound header names; intermediaries may not. */
function headerValue(headers: NodeJS.Dict<string | string[]> | undefined, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord | null> {
  let body = "";
  for await (const chunk of request) body += chunk;
  try { return JSON.parse(body) as JsonRecord; } catch { return null; }
}

/**
 * The delegated task text alone.
 *
 * Role policy reaches the CLI through the system prompt, so repeating it
 * here would state the same instructions twice with the untrusted task text
 * between them.
 */
export function promptFromInput(value: unknown, instructions: string | null = null): string {
  if (typeof value === "string") {
    return instructions ? `${instructions}\n\n${value}` : `Delegated task:\n${value}`;
  }
  if (!Array.isArray(value)) {
    const text = JSON.stringify(value ?? "");
    return instructions ? `${instructions}\n\n${text}` : `Delegated task:\n${text}`;
  }
  const userItems = value.filter((item) => item && typeof item === "object" && (item as JsonRecord).role === "user");
  const items = userItems.length > 0 ? userItems : value.filter((item) => !item || typeof item !== "object" || ![ "developer", "system" ].includes((item as JsonRecord).role as string));
  const task = items.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return JSON.stringify(item);
    const record = item as JsonRecord;
    return textFromContent(record.content ?? record.text ?? "");
  }).join("\n\n");
  return instructions ? `${instructions}\n\n${task}` : `Delegated task:\n${task}`;
}

export function claudeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    // These authenticate only the local router-to-bridge hop; never pass
    // them through to the OAuth-authenticated Claude CLI subprocess.
    "LITELLM_API_KEY",
    "LITELLM_MASTER_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    delete environment[key];
  }
  // Claude Code ships its own skill catalogue, none of which is AutoDev
  // policy. A bridge turn is governed by the role prompts and the target
  // repository's own skills, so the bundled set is dead weight in the context
  // window and a second, unversioned source of instructions.
  environment.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1";
  if (!environment.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not available to the Claude bridge");
  }
  return environment;
}

// The launch definition of every AutoDev MCP server.
//
// The installer renders this catalogue from ``.rulesync/mcp.jsonc``, the one
// place each server is declared, so the Claude and Copilot bridges reuse it
// instead of restating commands and URLs.
export function bridgeMcpServers(): Record<string, JsonRecord> {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const path = join(codexHome, "provider-runtime", "mcp-servers.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, JsonRecord>;
    throw new ClaudeOverloadedError(`bridge MCP catalogue is invalid: ${path}; rerun install.sh`);
  } catch (error) {
    if (error instanceof ClaudeOverloadedError) throw error;
    throw new ClaudeOverloadedError(`bridge MCP catalogue is missing or invalid: ${path}; rerun install.sh (${(error as Error).message})`);
  }
}

/** Return the generated Claude-native skill discovery view for a role. */
export function claudeSkillViewForRole(role: unknown): string | null {
  const contract = claudeRoleContract(role);
  if (!Array.isArray(contract.skills) || contract.skills.length === 0) return null;
  const roleKey = isOrchestratorRole(typeof role === "string" ? role : null) ? "orchestrator" : (typeof role === "string" && role.trim() ? role.trim().toLowerCase() : "default");
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const view = join(codexHome, "provider-runtime", "claude", roleKey);
  if (!existsSync(join(view, ".claude", "skills"))) {
    throw new ClaudeOverloadedError(
      `Claude skill bootstrap view is missing for role ${roleKey}: ${view}; rerun install.sh`,
    );
  }
  return view;
}

/**
 * The MCP servers a Claude turn sees. Inline JSON, ``--mcp-config``, and the
 * bridge always passes ``--strict-mcp-config``, so these are the only
 * servers a bridged turn sees: user-level ``~/.claude.json`` servers and a
 * workspace's own ``.mcp.json`` never widen a role's contract. Launch
 * definitions come from the bridge MCP catalogue; only the delegation shim
 * is built here, because it carries this turn's session.
 */
export function mcpConfigForRole(role: unknown, spawnSession: string | null = null): string | null {
  const servers: Record<string, JsonRecord> = {};
  const available = bridgeMcpServers();
  const contract = claudeRoleContract(role);
  for (const name of (contract.mcp ?? []) as string[]) {
    if (name === "autodev_spawn") continue;
    const server = available[name];
    if (!server || typeof server !== "object") {
      throw new ClaudeOverloadedError(
        `MCP server ${JSON.stringify(name)} granted to role ${String(role)} is not in the bridge MCP catalogue; rerun install.sh`,
      );
    }
    const typed = server as JsonRecord;
    if (typeof typed.url === "string") servers[name] = { url: typed.url };
    else servers[name] = { command: typed.command, args: Array.isArray(typed.args) ? typed.args as unknown[] : [] };
  }
  if (isOrchestratorRole(typeof role === "string" ? role : null) && spawnSession) {
    const shim = resolve(join(import.meta.dirname, "..", "mcp", "spawn-shim.ts"));
    servers.autodev_spawn = {
      command: process.env.AUTODEV_NODE_BIN ?? "node",
      args: [ shim ],
      env: {
        AUTODEV_BRIDGE_URL: `http://${HOST}:${PORT}`,
        AUTODEV_BRIDGE_TOKEN: AUTH_TOKEN,
        AUTODEV_SPAWN_SESSION: spawnSession,
      },
    };
  }
  return Object.keys(servers).length > 0 ? JSON.stringify({ mcpServers: servers }) : null;
}

/** Build the CLI argv for one Claude turn. */
export function claudeCliArgs(prompt: string, model: string, effort: string, agentRole: unknown = null, cwd: string = ".", spawnSession: string | null = null): string[] {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const dirs = (process.env.CLAUDE_CODE_ADDITIONAL_DIRS ?? codexHome).split(":").filter(Boolean);
  const skillView = claudeSkillViewForRole(agentRole);
  if (skillView && !dirs.includes(skillView)) dirs.push(skillView);
  // Workspace-local skills and policy are part of the target contract. Expose
  // the workspace's .agents tree to Claude without making it a global user
  // registry or guessing from task prose.
  const workspaceAgents = cwd ? join(cwd, ".agents") : "";
  if (workspaceAgents && existsSync(workspaceAgents) && !dirs.includes(workspaceAgents)) dirs.push(workspaceAgents);
  const additionalDirs = dirs;
  const orchestrator = isOrchestratorRole(typeof agentRole === "string" ? agentRole : null);
  // Delegation is the root orchestrator's job, so it keeps the delegation
  // tool the recursion boundary removes from every leaf role -- but *which*
  // tool it keeps depends on whether this turn can reach Codex's own spawner.
  //
  // With the shim available, Claude's own `Agent` tool is denied to the
  // orchestrator too. That is the entire point: a child spawned inside this
  // CLI is invisible to Codex and to the app, so leaving `Agent` in place
  // would just offer a second, worse door that the model would sometimes
  // choose. Without a session to hold, the shim cannot work and `Agent` stays
  // as the fallback -- an invisible child still beats no delegation at all.
  // Cross-session reach is denied in every case: see CROSS_SESSION_CLAUDE_TOOLS.
  const shimAvailable = orchestrator && Boolean(spawnSession);
  const denied: string[] = [ ...DISALLOWED_CLI_COMMANDS ];
  if (orchestrator && !shimAvailable) {
    denied.push(...CROSS_SESSION_CLAUDE_TOOLS);
  } else {
    denied.push(...DISALLOWED_CLAUDE_TOOLS, ...CROSS_SESSION_CLAUDE_TOOLS);
  }
  const roleContract = claudeRoleContract(typeof agentRole === "string" ? agentRole : null);
  if (roleContract.readOnly) {
    // Prompt text is not an enforcement boundary. Read-only roles must not
    // receive shell or file-mutating Claude tools even when the bridge uses
    // a non-interactive permission mode.
    denied.push("Bash", "Edit", "Write", "NotebookEdit");
  }
  if (PLAYWRIGHT_AGENT_ROLES.has(typeof agentRole === "string" ? agentRole : "")) {
    denied.push(...PLAYWRIGHT_DISALLOWED_TOOLS);
  }
  const subagentBoundary = [ "--disallowed-tools", denied.join(","), "--strict-mcp-config" ];
  const mcpConfig = mcpConfigForRole(agentRole, shimAvailable ? spawnSession : null);
  if (mcpConfig) subagentBoundary.push("--mcp-config", mcpConfig);
  const allowedBoundary: string[] = [];
  if (RESEARCH_CAPABLE_ROLES.has(typeof agentRole === "string" ? agentRole : "")) {
    allowedBoundary.push("--allowed-tools", CLAUDE_RESEARCH_ALLOWED_TOOLS.join(","));
  }
  return [
    CLI,
    "-p",
    prompt,
    "--model", model,
    "--effort", effort,
    ...subagentBoundary,
    ...allowedBoundary,
    "--permission-mode",
    // The parent explicitly authorizes runtime diagnostics outside the
    // workspace. Role instructions remain read-only; this mode prevents
    // Claude Code's interactive approval gate from hiding those reads or
    // localhost checks behind an approval request the parent cannot answer.
    process.env.CLAUDE_CODE_PERMISSION_MODE ?? "bypassPermissions",
    // Replace rather than append: appending leaves Claude Code's own default
    // prompt in force, which carries harness guidance (including a standing
    // instruction not to spawn agents unless asked) that competes with the
    // role policy this bridge is responsible for.
    "--system-prompt", composeProviderPrompt(typeof agentRole === "string" && agentRole ? agentRole : null, cwd),
    "--add-dir", ...additionalDirs,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
    "--include-hook-events",
    "--no-chrome",
  ];
}

/**
 * The complete system prompt for one bridge turn.
 *
 * `--system-prompt` replaces the Claude CLI's default prompt outright, which
 * also drops the per-machine sections it would otherwise inject (working
 * directory, platform, git status). The workspace the bridge resolved from
 * structured request metadata is therefore stated here: without it the agent
 * starts a turn not knowing which repository it is in. Role policy comes
 * last so it is the most recent instruction the model reads.
 */
export function systemPrompt(role: unknown, cwd: string): string {
  return composeProviderPrompt(typeof role === "string" && role ? role : null, cwd);
}

function responseMessageItem(text: string, itemId: string): JsonRecord {
  return {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [ { type: "output_text", text, annotations: [] } ],
  };
}

function responsePayload(model: unknown, text: string, metadata: JsonRecord | null, responseId: string = `resp_${randomBytes(12).toString("hex")}`, itemId: string = `msg_${randomBytes(10).toString("hex")}`, output: JsonRecord[] | null = null, status = "completed"): JsonRecord {
  const usage = (metadata?.usage as JsonRecord | undefined) ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const message = responseMessageItem(text, itemId);
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output: output ?? [ message ],
    output_text: text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: JsonRecord, extraHeaders: Record<string, string | number> = {}): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close", ...extraHeaders });
  response.end(encoded);
}

function sseLine(eventName: string, body: JsonRecord, sequenceNumber?: number): string {
  const payload = sequenceNumber === undefined ? body : { ...body, sequence_number: sequenceNumber };
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// Stage 0 diagnostic, enabled with AUTODEV_LOG_TOOLS=1.
//
// The design for bridging delegation into Codex's own spawn tool rests on one
// unverified claim: that the router's outbound tool flattening actually puts a
// `multi_agent_v1__*` entry in front of this bridge, and that Codex sends the
// matching `function_call_output` back in a shape this bridge can pair up.
// Both are cheap to observe and expensive to guess wrong, so observe them
// first. This is scaffolding -- it comes out once the spawn bridge is built.
const LOG_TOOLS = process.env.AUTODEV_LOG_TOOLS === "1";

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const record = tool as JsonRecord;
      if (typeof record.name === "string") return record.name;
      const fn = record.function;
      if (fn && typeof fn === "object" && typeof (fn as JsonRecord).name === "string") return (fn as JsonRecord).name as string;
      return null;
    })
    .filter((name): name is string => typeof name === "string");
}

/** Record what Codex offered and what the router said about this turn. */
function logInboundRequest(payload: JsonRecord, headers: NodeJS.Dict<string | string[]>): void {
  if (!LOG_TOOLS) return;
  const routing: JsonRecord = {};
  for (const [ key, v ] of Object.entries(headers ?? {})) {
    if (/^x-(autodev|codex)-/i.test(key)) routing[key] = v;
  }
  console.error(`[stage0] tool_names=${JSON.stringify(toolNames(payload?.tools).sort())}`);
  console.error(`[stage0] routing_headers=${JSON.stringify(routing)}`);
  for (const tool of Array.isArray(payload?.tools) ? payload.tools as JsonRecord[] : []) {
    if (typeof tool?.name === "string" && tool.name.startsWith("multi_agent_v1")) {
      console.error(`[stage0] spawn_tool=${JSON.stringify(tool)}`);
    }
  }
  for (const item of Array.isArray(payload?.input) ? payload.input as JsonRecord[] : []) {
    if (item?.type === "function_call" || item?.type === "function_call_output") {
      console.error(`[stage0] input_item=${JSON.stringify(item).slice(0, 2000)}`);
    }
  }
}

// Delegate requests the shim collects while a turn is in flight. See
// src/agents/bridge-spawn-session.ts for why the session key matters.
const spawnSessions = new SpawnSessionRegistry();

/** The environment a Claude child runs in, when an MCP-delegation shim carries its session. */
function claudeShimEnv(spawnSession: string | null): NodeJS.ProcessEnv {
  const environment = claudeEnvironment();
  return {
    ...environment,
    AUTODEV_BRIDGE_URL: `http://${HOST}:${PORT}`,
    AUTODEV_BRIDGE_TOKEN: AUTH_TOKEN,
    AUTODEV_SPAWN_SESSION: spawnSession ?? "",
  };
}

/** Normalize a provider-supplied reset time to an ISO-8601 UTC string. */
export function normalizeResetsAt(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let ms: number | null = null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds and epoch milliseconds are told apart by magnitude: a
    // seconds value large enough to be ambiguous would be in the year 33658.
    ms = value > 1e11 ? value : value * 1000;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      ms = numeric > 1e11 ? numeric : numeric * 1000;
    } else {
      const parsed = Date.parse(trimmed);
      ms = Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// A typed stream event yielded by the CLI driver so the caller can forward
// it into Responses SSE without knowing the CLI's wire format.
type ClaudeStreamEvent =
  | { kind: "tools"; value: unknown }
  | { kind: "delta"; value: string }
  | { kind: "tool_use"; value: JsonRecord }
  | { kind: "tool_result"; value: JsonRecord }
  | { kind: "activity"; value: string }
  | { kind: "heartbeat" }
  | { kind: "complete"; value: { text: string; metadata: JsonRecord } };

interface ClaudeStreamOptions {
  cwd: string;
  agentRole: string | null;
  spawnSession: string | null;
  env: NodeJS.ProcessEnv;
}

export async function* runClaudeStream(prompt: string, model: string, effort: string, options: ClaudeStreamOptions): AsyncGenerator<ClaudeStreamEvent, void, void> {
  const argv = claudeCliArgs(prompt, model, effort, options.agentRole, options.cwd, options.spawnSession);
  const child = spawn(CLI, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: [ "ignore", "pipe", "pipe" ] });
  let stderr = "";
  let terminalResult: JsonRecord | null = null;
  let emitted = "";
  let assistantSnapshot = "";
  let sawStreamText = false;
  const activityKeys = new Set<string>();
  const toolUses = new ToolUseAccumulator();

  const lines = createInterface({ input: child.stdout });
  const lineQueue: string[] = [];
  let resolveNext: (() => void) | null = null;
  lines.on("line", (line: string) => {
    lineQueue.push(line);
    if (resolveNext) resolveNext();
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const childClosed = new Promise<void>((resolveClose) => { child.once("close", () => resolveClose()); });

  try {
    for (;;) {
      // Drain the queue first.
      while (lineQueue.length > 0) {
        const line = lineQueue.shift()!;
        let event: JsonRecord;
        try {
          event = JSON.parse(line) as JsonRecord;
        } catch {
          // Stderr that landed on stdout (it happens): skip but keep draining.
          continue;
        }
        const eventType = event.type;
        if (eventType === "rate_limit_event") {
          const rateError = rateLimitEventError(event);
          if (rateError !== null) throw rateError;
          continue;
        }
        const isApiError = event.is_api_error_message || event.error === "rate_limit" || event.error === "overloaded_error";
        if (isApiError) {
          const errMsg = textFromContent((event.message as JsonRecord | undefined)?.content) || String(event.error ?? "Claude API error");
          raiseClassifiedClaudeError(errMsg, event.error);
          continue;
        }
        if (eventType === "system" && Array.isArray(event.tools)) {
          yield { kind: "tools", value: event.tools };
        }
        const completedBlock = toolUses.feed(event);
        if (completedBlock !== null) {
          yield { kind: "tool_use", value: completedBlock };
        }
        for (const block of toolResultsFromEvent(event)) {
          yield { kind: "tool_result", value: block };
        }
        const activity = activityFromEvent(event, activityKeys);
        if (activity) yield { kind: "activity", value: activity };
        let delta = eventType === "stream_event" ? nestedText(event) : "";
        if (eventType === "stream_event") {
          // With `--include-partial-messages` Claude emits both the canonical
          // stream_event text deltas and assistant events containing a full
          // message snapshot. The latter must not be forwarded after a stream
          // delta or the same text is rendered twice by the downstream
          // Responses client.
          if (!sawStreamText && assistantSnapshot) {
            if (emitted.endsWith(delta)) delta = "";
            else if (delta.startsWith(assistantSnapshot)) delta = delta.slice(assistantSnapshot.length);
          }
          sawStreamText = true;
        }
        if (eventType === "assistant") {
          const fullText = textFromContent((event.message as JsonRecord | undefined)?.content);
          if (sawStreamText) delta = "";
          else if (fullText.startsWith(assistantSnapshot)) delta = fullText.slice(assistantSnapshot.length);
          else if (fullText === assistantSnapshot || emitted.endsWith(fullText)) delta = "";
          else delta = fullText;
          assistantSnapshot = fullText;
        }
        if (delta) {
          emitted += delta;
          yield { kind: "delta", value: delta };
        }
        if (eventType === "result") {
          terminalResult = event;
          if (event.is_error) {
            const message = String(event.result ?? "Claude CLI returned an error");
            raiseClassifiedClaudeError(message, undefined);
            throw new Error(message);
          }
          continue;
        }
        await Promise.resolve();
      }
      if (terminalResult !== null) break;
      // Wait for more lines or child exit.
      const next = new Promise<void>((res) => { resolveNext = () => res(); });
      const raced = await Promise.race([
        next,
        childClosed.then(() => "close" as const),
        new Promise<"timeout">((res) => setTimeout(() => res("timeout"), CLAUDE_TIMEOUT_SECONDS * 1000)),
      ]);
      resolveNext = null;
      if (raced === "close") break;
      if (raced === "timeout") {
        child.kill("SIGTERM");
        await childClosed.catch(() => undefined);
        throw new Error(`Claude CLI timed out after ${CLAUDE_TIMEOUT_SECONDS}s`);
      }
    }
    if (terminalResult === null) {
      throw new Error(`Claude CLI exited without a terminal result event: ${stderr.slice(-4000)}`);
    }
    const result = terminalResult;
    if (result.is_error) {
      const message = String(result.result ?? "Claude CLI returned an error");
      raiseClassifiedClaudeError(message, undefined);
      throw new Error(message);
    }
    const cliText = String(result.result ?? emitted);
    if (cliText && cliText !== emitted && !emitted.endsWith(cliText)) {
      const suffix = cliText.startsWith(emitted) ? cliText.slice(emitted.length) : cliText;
      if (suffix) {
        emitted += suffix;
        yield { kind: "delta", value: suffix };
      }
    }
    yield { kind: "complete", value: { text: cliText || emitted, metadata: result } };
      } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await childClosed.catch(() => undefined);
    }
    throw error;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await childClosed.catch(() => undefined);
    }
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", spawnSessions: spawnSessions.status() });
    return;
  }
  // The shim runs as a child of the Claude process this bridge started and
  // reaches back over the same loopback port, behind the same bearer check.
  if (pathname === "/v1/bridge-spawn/attach" || pathname === "/v1/bridge-spawn/call") {
    if (AUTH_TOKEN && request.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      sendJson(response, 401, { error: "invalid local gateway key" });
      return;
    }
    const body = await readJsonBody(request);
    const session = typeof body?.session === "string" ? body.session : "";
    if (pathname.endsWith("/attach")) {
      // A leaf turn, or a CLI that outlived its request, is simply not offered
      // the tool rather than being offered one that fails.
      sendJson(response, 200, { spawnAllowed: spawnSessions.mayDelegate(session) });
      return;
    }
    const result = spawnSessions.record(session, body?.children);
    if (!result.accepted) {
      sendJson(response, 409, { error: result.message });
      return;
    }
    // Delegation is dispatched, not awaited: Codex creates the children and
    // tracks them, so a model that waits for them here would wait forever.
    sendJson(response, 200, {
      text: `Dispatched ${result.count} subagent(s): ${result.roles}. They are running now and are tracked by `
        + "the orchestration layer, not by you. End your turn now with a brief statement of what you delegated -- "
        + "do not wait for them, and do not do their work yourself. Their results are delivered to you "
        + "automatically on your next turn.",
    });
    return;
  }
  if (pathname === "/v1/models") {
    sendJson(response, 200, { object: "list", data: [ { id: MODEL, object: "model", owned_by: "anthropic" } ], models: [ claudeModelMetadata() ] });
    return;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, { error: { type: "invalid_request_error", message: "not found" } });
    return;
  }
  if (AUTH_TOKEN && request.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    sendJson(response, 401, { error: { type: "authentication_error", message: "invalid local gateway key" } });
    return;
  }

  let body = "";
  for await (const chunk of request) body += chunk;
  let payload: JsonRecord;
  try { payload = JSON.parse(body); } catch { sendJson(response, 400, { error: { type: "invalid_request_error", message: "invalid JSON" } }); return; }
  const model = resolvedModel(payload.model);
  const effort = resolveClaudeEffort(requestedEffort(payload));
  // The router classifies the turn; only it can tell this bridge that it is
  // serving the root orchestrator rather than a delegated leaf.
  const agentRole = resolveAgentRole(request.headers as Record<string, unknown>);
  const agentEvents = resolveAgentEventReporter(request.headers as Record<string, unknown>);
  logInboundRequest(payload, request.headers);
  const sessionHeader = headerValue(request.headers, "x-autodev-session-id");
  const sessionScope = headerValue(request.headers, "x-autodev-session-scope");
  const spawnSession = SpawnSessionRegistry.canHold(sessionHeader, sessionScope) ? sessionHeader : null;
  let cwd: string;
  try {
    cwd = resolveCwd(payload, request.headers as Record<string, string | string[] | undefined>, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    console.error(`claude workspace resolution failed: ${error.message}`);
    sendJson(response, 400, { error: { type: "invalid_request_error", message: error.message } });
    return;
  }
  // Only hold delegation state once all pre-flight validation has succeeded.
  // An invalid workspace cannot leave an orphaned entry that a later shim
  // process could attach to.
  if (spawnSession) spawnSessions.open(spawnSession, { orchestrator: isOrchestratorRole(agentRole) });
  const prompt = promptFromInput(payload.input ?? "");
  const bootstrapContract = claudeRoleContract(agentRole);
  const skillView = claudeSkillViewForRole(agentRole);
  console.error(`claude bootstrap provider=claude model=${model} role=${agentRole ?? "default"} cwd=${cwd} skills=${JSON.stringify(bootstrapContract.skills ?? [])} skill_view=${skillView ?? "none"} mcp=${JSON.stringify(bootstrapContract.mcp ?? [])}`);
  console.error(`claude request model=${model} effort=${effort} role=${isOrchestratorRole(agentRole) ? "orchestrator" : "leaf"} cwd=${cwd}`);
  // Exposure is decided here, before the CLI starts: the role contract picks
  // the skills and the generated view is how Claude discovers them. Reporting
  // it from the model's behaviour instead would report nothing for a turn
  // that was given skills and never reached for one -- exactly the case
  // per-workspace skill attribution has to be able to show.
  if (agentEvents) {
    for (const exposedSkill of (bootstrapContract.skills ?? []) as string[]) {
      void agentEvents.reportSkillExposed({ skill: exposedSkill, source: CLAUDE_SKILL_EXPOSURE_SOURCE });
    }
    for (const exposedMcp of (bootstrapContract.mcp ?? []) as string[]) {
      void agentEvents.reportMcpExposed({ server: exposedMcp, source: CLAUDE_MCP_EXPOSURE_SOURCE });
    }
  }

  // The tool inventory the CLI reported for this turn, from its init event.
  // A tool the model then asks for that is absent from it was removed from
  // under the turn -- a workspace `permissions.deny`, an MCP server that
  // failed to start -- which is a different fact from a tool that ran and
  // failed.
  const offeredTools = new Set<string>();
  const pendingToolCalls = new Map<string, { name: string; input: JsonValue; startedAt: number }>();
  // Per-turn dedupe for skill reads: keyed on the skill name, not the call,
  // so re-reading the same SKILL.md from a second tool call in the same turn
  // still reports one use, not two.
  const seenSkillReads = new Set<string>();

  const noteToolUse = (block: JsonRecord): void => {
    const name = block.name;
    if (!agentEvents) return;
    if (agentEvents.isSpawnTool(name)) {
      void agentEvents.reportSpawn({ tool: String(name), role: subagentRoleFromInput(block) });
      void agentEvents.reportActivity({ state: "subagent_wait" });
    } else if (String(name).trim().toLowerCase() === "ask_question") {
      void agentEvents.reportActivity({ state: "user_wait" });
    } else {
      void agentEvents.reportActivity({ state: "tool_wait" });
    }
    if (typeof name !== "string" || !name.trim()) return;
    const rawId = block.id;
    const callId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
    // The model asking is not the tool running: the call is only ever
    // reported as `tool_requested` here, and is upgraded to `tool_executed`
    // when its result block arrives.
    if (offeredTools.size > 0 && !offeredTools.has(name)) {
      void agentEvents.reportToolUnavailable({ tool: name, callId, reason: "not_offered", server: claudeToolServer(name) });
      return;
    }
    if (callId !== null) pendingToolCalls.set(callId, { name, input: block.input, startedAt: Date.now() });
    void agentEvents.reportToolRequested({ tool: name, callId, server: claudeToolServer(name) });
  };

  const noteToolResult = (block: JsonRecord): void => {
    if (!agentEvents) return;
    const rawId = block.tool_use_id;
    const callId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
    const opened = callId !== null ? pendingToolCalls.get(callId) : undefined;
    pendingToolCalls.delete(callId ?? "");
    // A result whose call this bridge never saw open names no tool, and the
    // router cannot attribute an unnamed one.
    if (!opened) return;
    const { name, input, startedAt } = opened;
    const classification = classifyToolResult(block);
    if (classification.kind === "unavailable") {
      void agentEvents.reportToolUnavailable({ tool: name, callId, reason: classification.detail, server: claudeToolServer(name) });
      void agentEvents.reportActivity({ state: "resumed" });
      return;
    }
    void agentEvents.reportToolExecuted({
      tool: name,
      callId,
      status: classification.detail,
      server: claudeToolServer(name),
      durationMs: Date.now() - startedAt,
    });
    // A failed call proves nothing was actually read, so only a call the
    // CLI itself reports as successful can surface a `skill_used` event.
    if (classification.detail === "ok") {
      const skill = matchSkillReadPath(normaliseSkillReadPath(extractSkillReadPath(name, input)));
      if (skill !== null && !seenSkillReads.has(skill)) {
        seenSkillReads.add(skill);
        void agentEvents.reportSkillUsed({
          skill,
          source: CLAUDE_SKILL_READ_SOURCE,
          eventId: `skill_read:${callId ?? "no-call-id"}:${skill}`,
        });
      }
    }
    void agentEvents.reportActivity({ state: "resumed" });
  };

  const noteAvailableTools = (tools: unknown): void => {
    const names: string[] = Array.isArray(tools) ? tools.filter((n): n is string => typeof n === "string") : [];
    for (const n of names) offeredTools.add(n);
    if (!agentEvents || !isOrchestratorRole(agentRole)) return;
    if (names.some((n) => agentEvents.isSpawnTool(n))) return;
    const expected = [ ...(agentEvents["spawnTools" as keyof typeof agentEvents] as unknown as Set<string> | undefined ?? new Set<string>()) ].sort();
    console.error(`claude orchestrator has no delegation tool in ${cwd}: expected one of ${JSON.stringify(expected)}; check permissions.deny in that workspace's .claude/settings.json`);
    void agentEvents.reportSpawnToolsUnavailable({ available: names });
  };

  if (!payload.stream) {
    try {
      let text = "";
      let metadata: JsonRecord = {};
      for await (const event of runClaudeStream(prompt, model, effort, { cwd, agentRole, spawnSession, env: claudeShimEnv(spawnSession) })) {
        if (event.kind === "tools") noteAvailableTools(event.value);
        else if (event.kind === "delta") text += event.value;
        else if (event.kind === "tool_use") noteToolUse(event.value);
        else if (event.kind === "tool_result") noteToolResult(event.value);
        else if (event.kind === "complete") ({ text, metadata } = event.value);
      }
      const output = [ responseMessageItem(text, `msg_${randomBytes(10).toString("hex")}`) ];
      const spawnChildren = spawnSession ? spawnSessions.close(spawnSession) : [];
      if (spawnSession && spawnChildren.length > 0) {
        const spawnEvents = execToolCallSseEvents({
          itemId: mintCallItemId(),
          callId: mintCallId(spawnSession, output.length),
          source: buildSpawnScript(spawnChildren, { recoverParentId: spawnSession }),
          outputIndex: output.length,
        });
        output.push(spawnEvents[3][1].item as unknown as JsonRecord);
        console.error(`claude delegating ${spawnChildren.length} subagent(s) through Codex`);
      }
      if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
      sendJson(response, 200, responsePayload(payload.model ?? model, text, metadata, undefined, undefined, output));
    } catch (error) {
      if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "failed" });
      if (spawnSession) spawnSessions.close(spawnSession);
      handleNonStreamingError(response, error, payload, model, agentRole);
    }
    return;
  }

  const responseId = `resp_${randomBytes(12).toString("hex")}`;
  const reasoningId = `rs_${randomBytes(12).toString("hex")}`;
  const itemId = `msg_${randomBytes(10).toString("hex")}`;
  const activityParts: string[] = [];
  const seenActivities = new Set<string>();
  // Exactly what this client already received, so flushing it on a failure is
  // truthful by construction rather than a second guess at the turn's output.
  let partialText = "";
  let sequenceNumber = 0;
  let streamStarted = false;
  const pendingEvents: string[] = [];
  let clientClosed = false;
  const isWritable = (): boolean => !clientClosed && !response.writableEnded && !response.destroyed && !response.closed;
  const emit = (eventName: string, body: JsonRecord): void => {
    const event = sseLine(eventName, { ...body, sequence_number: ++sequenceNumber });
    if (!isWritable()) return;
    if (streamStarted) {
      try { response.write(event); } catch { /* ignore */ }
    } else {
      pendingEvents.push(event);
    }
  };
  const startStream = (): void => {
    if (streamStarted || !isWritable()) return;
    streamStarted = true;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    response.flushHeaders();
    response.shouldKeepAlive = false;
    for (const event of pendingEvents.splice(0)) {
      if (!isWritable()) break;
      try { response.write(event); } catch { /* ignore */ }
    }
  };
  const emitActivity = (text: string, key: string = text): void => {
    if (!text || seenActivities.has(key) || !isWritable()) return;
    seenActivities.add(key);
    activityParts.push(text);
    emit("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: `${text}\n`,
    });
  };
  emit("response.created", { type: "response.created", response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: payload.model ?? model, status: "in_progress", output: [] } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: reasoningId, type: "reasoning", status: "in_progress", summary: [], content: [] } });
  emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
  emit("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  const keepAlive = setInterval(() => {
    if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
      void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }
    if (streamStarted && isWritable()) {
      try { response.write(": claude-bridge keep-alive\n\n"); } catch { /* ignore */ }
    }
  }, 2000);

  response.on("close", () => { clientClosed = true; clearInterval(keepAlive); });

  try {
    let finalMetadata: JsonRecord = {};
    for await (const event of runClaudeStream(prompt, model, effort, { cwd, agentRole, spawnSession, env: claudeShimEnv(spawnSession) })) {
      if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
        void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
      }
      if (event.kind === "tools") {
        noteAvailableTools(event.value);
      } else if (event.kind === "delta") {
        startStream();
        partialText += event.value;
        emit("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, delta: event.value, content_index: 0, output_index: 1 });
      } else if (event.kind === "tool_use") {
        noteToolUse(event.value);
      } else if (event.kind === "tool_result") {
        noteToolResult(event.value);
      } else if (event.kind === "activity") {
        startStream();
        activityParts.push(event.value);
        emit("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: reasoningId, output_index: 0, summary_index: 0, delta: event.value });
        if (agentEvents && typeof agentEvents.reportHeartbeat === "function") void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
      } else if (event.kind === "complete") {
        partialText = event.value.text;
        finalMetadata = event.value.metadata;
      }
    }
    clearInterval(keepAlive);
    const reasoningText = activityParts.join("\n");
    const completedReasoning = { id: reasoningId, type: "reasoning", status: "completed", summary: [ { type: "summary_text", text: reasoningText } ], content: [] };
    const completedMessage = responseMessageItem(partialText, itemId);
    const completed = responsePayload(payload.model ?? model, partialText, finalMetadata, responseId, itemId, [ completedReasoning, completedMessage ]) as JsonRecord & { output: JsonRecord[] };
    emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: 0, summary_index: 0, text: reasoningText });
    emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: reasoningText } });
    emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: completedReasoning });
    emit("response.output_text.done", { type: "response.output_text.done", item_id: itemId, text: partialText, content_index: 0, output_index: 1 });
    emit("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: partialText, annotations: [] } });
    emit("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: completedMessage });
    // Delegation this turn, collected out-of-band by the shim while Claude
    // ran. Emitted as one `exec` call after the message: Codex runs the
    // script, creates the children itself, and they become real sessions
    // the app can show -- which is the whole reason this path exists.
    const spawnChildren = spawnSession ? spawnSessions.close(spawnSession) : [];
    if (spawnSession && spawnChildren.length > 0) {
      const source = buildSpawnScript(spawnChildren, { recoverParentId: spawnSession });
      const spawnEvents = execToolCallSseEvents({
        itemId: mintCallItemId(),
        callId: mintCallId(spawnSession, completed.output.length),
        source,
        outputIndex: completed.output.length,
      });
      for (const [ name, ev ] of spawnEvents) emit(name, ev as unknown as JsonRecord);
      completed.output.push(spawnEvents[3][1].item as unknown as JsonRecord);
      console.error(`claude delegating ${spawnChildren.length} subagent(s) through Codex`);
    }
    emit("response.completed", { type: "response.completed", response: completed });
    if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
    if (isWritable()) {
      try { response.end("data: [DONE]\n\n"); } catch { /* ignore */ }
    }
  } catch (error) {
    clearInterval(keepAlive);
    if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "failed" });
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Claude upstream failure: ${message}`);
    if (streamStarted) {
      const limit = error instanceof ClaudeRateLimitError ? error.toLimit() : (message ? classifyCliLimit(message) : null);
      for (const [ eventName, body ] of terminalIncompleteEvents({
        responseId,
        itemId,
        reasoningId,
        text: partialText,
        reasoningText: activityParts.join("\n"),
        reason: limit ? INCOMPLETE_REASON_PROVIDER_LIMIT : error instanceof ClaudeOverloadedError || /timed out/i.test(message) ? INCOMPLETE_REASON_TIMEOUT : INCOMPLETE_REASON_INTERRUPTED,
        limit,
        provider: "claude",
        response: responsePayload(payload.model ?? model, partialText, null, responseId, itemId, [], "incomplete"),
      })) emit(eventName, body);
      if (isWritable()) {
        try { response.end("data: [DONE]\n\n"); } catch { /* ignore */ }
      }
    } else {
      handleNonStreamingError(response, error, payload, model, agentRole);
    }
  } finally {
    clearInterval(keepAlive);
    // The registry must not outlive the turn on any path. A stale entry would
    // accept a delegation from a CLI that outlived its request and attach it
    // to nothing, and on a reused session key it would attach it to the
    // *next* turn. `spawnSession` is bound before the try, so a failure
    // before that point leaves nothing to clean up.
    if (spawnSession) spawnSessions.close(spawnSession);
  }
}

function handleNonStreamingError(response: ServerResponse, error: unknown, payload: JsonRecord, model: string, agentRole: string | null): void {
  const message = error instanceof Error ? error.message : String(error);
  const limit = error instanceof ClaudeRateLimitError ? error.toLimit() : (message ? classifyCliLimit(message) : null);
  if (error instanceof ClaudeRateLimitError) {
    const retryAfter = retryAfterSecondsFromLimit(limit);
    const extra: Record<string, string | number> = { ...limitResponseHeaders(limit) };
    if (retryAfter !== null) extra["retry-after"] = String(retryAfter);
    sendJson(response, 429, { error: { message, type: "rate_limit_error", limit: limitPayload(limit) } }, extra);
    return;
  }
  if (error instanceof ClaudeOverloadedError) {
    const capacity: ProviderLimit = { limitClass: "capacity", limitType: "capacity", resetsAt: null, source: "inferred" };
    const retryAfter = retryAfterSecondsFromLimit(capacity);
    const extra: Record<string, string | number> = { ...limitResponseHeaders(capacity) };
    if (retryAfter !== null) extra["retry-after"] = String(retryAfter);
    sendJson(response, 503, { error: { message, type: "overloaded_error", limit: limitPayload(capacity) } }, extra);
    return;
  }
  if (message && /timed out/i.test(message)) {
    sendJson(response, 504, { error: { message: "Claude CLI timed out", type: "timeout_error" } });
    return;
  }
  sendJson(response, 502, { error: { message, type: "upstream_error" } });
  // Suppress unused parameter lint when callers omit cwd/agentRole context.
  void payload;
  void model;
  void agentRole;
}

if (IS_MAIN) {
  createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
    console.error(`Claude Responses proxy listening at http://${HOST}:${PORT}`);
  });
}
