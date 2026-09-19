#!/usr/bin/env node

/** OpenAI Responses compatibility proxy for the subscription-authenticated Copilot CLI. */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  composeProviderPrompt,
  isOrchestratorRole,
  resolveAgentRole
} from "../agents/bridge-role.ts";
import { SpawnSessionRegistry } from "../agents/bridge-spawn-session.ts";
import {
  buildSpawnScript,
  execToolCallSseEvents,
  mintCallId,
  mintCallItemId
} from "../agents/spawn-tools.ts";
import type { RoleContract } from "../shared/execution-contract.ts";
import { roleContract } from "../shared/execution-contract.ts";
import { writeErrorLine } from "../shared/output.ts";
import {
  classifyCliLimit,
  INCOMPLETE_REASON_INTERRUPTED,
  INCOMPLETE_REASON_PROVIDER_LIMIT,
  limitPayload,
  limitResponseHeaders,
  retryAfterSecondsFromLimit,
  terminalIncompleteEvents
} from "../shared/provider-limits.ts";
import {
  resolveCwd,
  WorkspaceResolutionError
} from "../shared/resolve-workspace.ts";
import {
  resolveAgentEventReporter,
  SKILL_READ_SOURCE
} from "../telemetry/agent-events.ts";

// Bind the port only when run as a program, so this file can be imported for
// its pure helpers without taking the port from the running bridge. Mirrors
// the MiniMax adapter's guard.
const IS_MAIN =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const HOST = process.env.COPILOT_PROXY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.COPILOT_PROXY_PORT ?? "4003", 10);
const TIMEOUT_MS = Number.parseInt(
  process.env.COPILOT_PROXY_TIMEOUT_MS ?? "900000",
  10
);
const PROJECT_ROOT =
  process.env.CODEX_PROJECT_ROOT ?? process.env.COPILOT_PROJECT_ROOT ?? null;
const AUTH_TOKEN = process.env.CODEX_ROUTER_COPILOT_API_KEY ?? "";

// Provider/CLI payloads are JSON-shaped but intentionally retain fields this
// bridge does not own (the Copilot CLI's event stream is not a formally
// specified schema; see COPILOT_TOOL_OUTPUT_KEYS below). Keep the dynamic edge
// explicit while the transport and boundary operations remain typed.
type JsonRecord = Record<string, any>;
type AgentReporter = import("../telemetry/agent-events.ts").AgentEventReporter;
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

const spawnSessions = new SpawnSessionRegistry();

// Canonical skill roots whose `SKILL.md` a successful read counts as actual
// usage, mirroring the approved roots `src/hooks/skill-read-telemetry.ts`
// uses for Codex's own PreToolUse hook. The Copilot CLI's tool calls never
// reach that hook -- it runs entirely inside its own runtime -- so this
// bridge is the only place a read of one of these files is observable at all.
const HOME = homedir();
// Two levels up from `src/providers/` reaches the repository root in a
// checkout and `$CODEX_HOME` once installed there, mirroring every other
// typed `src/` module's `../..` depth (see src/shared/execution-contract.ts).
const REPO_ROOT =
  process.env.AUTODEV_REPO_ROOT ||
  resolve(join(import.meta.dirname, "..", ".."));
const SKILL_ROOTS = [
  join(HOME, ".agents", "skills"),
  join(HOME, ".codex", "skills"),
  join(HOME, "AutoDev", ".agents", "skills"),
  join(HOME, "AutoDev", ".rulesync", "skills"),
  join(REPO_ROOT, ".agents", "skills"),
  join(REPO_ROOT, ".rulesync", "skills")
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
  if (path.startsWith("~")) path = join(HOME, path.slice(1));
  if (!isAbsolute(path)) path = resolve(path);
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
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as JsonRecord;
    value =
      record.cmd ?? record.command ?? record.script ?? record.value ?? null;
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
  const args: JsonRecord =
    argsObject && typeof argsObject === "object"
      ? (argsObject as JsonRecord)
      : {};
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
function matchSkillReadPath(path: string | null): string | null {
  if (!path) return null;
  const normalised = path.replaceAll(/[\\/]+/g, sep);
  for (const rootRaw of SKILL_ROOTS) {
    const root = rootRaw.replaceAll(/[\\/]+/g, sep);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!normalised.startsWith(rootWithSep)) continue;
    const relative = normalised.slice(root.length).replace(/^[\\/]+/, "");
    if (!relative.endsWith(`${sep}SKILL.md`) && relative !== "SKILL.md")
      continue;
    const segments = relative.split(sep).filter(Boolean);
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
}): JsonRecord | null {
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

/** The result payload of a terminal tool event, whatever it is called. */
function copilotToolResult(
  data: JsonRecord | null | undefined
): JsonRecord | null {
  const result = data?.toolResult ?? data?.tool_result ?? data?.result ?? null;
  return result && typeof result === "object" ? result : null;
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
    Number.isFinite(data.exitCode)
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
    if (data?.status === "cancelled" || /cancel/i.test(label)) {
      return { kind: "unavailable", reason: "cancelled" };
    }
    return { kind: "none" };
  }
  const failed =
    data?.success === false ||
    data?.isError === true ||
    Boolean(data?.error ?? data?.errorMessage) ||
    (Number.isFinite(data?.exitCode) && data?.exitCode !== 0) ||
    /error|fail/i.test(label);
  return { kind: "executed", status: failed ? "error" : "ok" };
}

/** Post one observation, when the router authorized reporting for this turn. */
function reportToolObservation(
  agentEvents: AgentReporter | null,
  event: JsonRecord
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

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonRecord,
  extraHeaders: Record<string, string> = {}
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    connection: "close",
    ...extraHeaders
  });
  response.end(encoded);
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
  output: JsonRecord[] | null = null,
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
      typeof part === "object"
        ? ((part as JsonRecord)?.text ?? JSON.stringify(part))
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
  const intent = data?.arguments?.intent;
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
  const path = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "provider-runtime",
    "mcp-servers.json"
  );
  try {
    const catalogue = JSON.parse(readFileSync(path, "utf8"));
    if (catalogue && typeof catalogue === "object" && !Array.isArray(catalogue))
      return catalogue;
  } catch {
    /* reported below */
  }
  throw new Error(
    `bridge MCP catalogue is missing or invalid: ${path}; rerun scripts/install.sh`
  );
}

/** Server names in the user-level Copilot MCP file that Rulesync writes. */
function userMcpServerNames(): string[] {
  const path = join(
    process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
    "mcp-config.json"
  );
  if (!existsSync(path)) return [];
  const servers = (JSON.parse(readFileSync(path, "utf8")) as JsonRecord)
    ?.mcpServers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
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
    if (!server || typeof server !== "object") {
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
    const shim = resolve(
      join(import.meta.dirname, "..", "mcp", "spawn-shim.ts")
    );
    additional.autodev_spawn = {
      type: "stdio",
      command: process.execPath,
      args: [shim],
      env: {
        AUTODEV_BRIDGE_URL: `http://${HOST}:${PORT}`,
        AUTODEV_BRIDGE_TOKEN: AUTH_TOKEN,
        AUTODEV_SPAWN_SESSION: spawnSession
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

type OnRunCopilotEvent = (event: JsonRecord) => void;

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
  spawnSession: string | null = null
): Promise<RunCopilotResult> {
  return new Promise<RunCopilotResult>((resolvePromise, rejectPromise) => {
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
    if (!contract.readOnly)
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
      stdio: ["ignore", "pipe", "pipe"]
    });
    const phases = new Map<string, string>();
    // Tool calls the CLI opened, keyed by the id its terminal event names, so
    // a result can be attributed to the tool and timed against its start.
    const toolCalls = new Map<
      string,
      { tool: string; startedAt: number; server: string | null; args: unknown }
    >();
    // Per-turn dedupe for skill reads: keyed on the skill name, not the call.
    const seenSkills = new Set<string>();
    let stderr = "";
    let answer = "";
    let terminalResult: JsonRecord | null = null;
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    const finishResolve = (value: RunCopilotResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    };
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let event: JsonRecord;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const data: JsonRecord = event?.data ?? {};
      switch (event?.type) {
        case "assistant.message_start": {
          if (data.messageId)
            phases.set(data.messageId, String(data.phase ?? ""));
          break;
        }
        case "assistant.message_delta": {
          const delta = String(data.deltaContent ?? "");
          if (!delta) break;
          if (phases.get(data.messageId) === "final_answer") {
            answer += delta;
            onEvent?.({ type: "text_delta", text: delta });
          } else {
            onEvent?.({ type: "activity", text: delta });
          }
          break;
        }
        case "assistant.message": {
          // Terminal snapshot for one message. Reconcile the answer against it
          // so a dropped delta cannot truncate the delegated result.
          if (String(data.phase ?? "") !== "final_answer") break;
          const full = String(data.content ?? "");
          if (full && !answer.endsWith(full)) {
            const suffix = full.startsWith(answer)
              ? full.slice(answer.length)
              : full;
            if (suffix) {
              answer += suffix;
              onEvent?.({ type: "text_delta", text: suffix });
            }
          }
          break;
        }
        case "tool.execution_start": {
          const callId = String(data.toolCallId ?? "").trim() || null;
          const toolName = String(data.toolName ?? "").trim();
          const server =
            typeof data.server === "string" && data.server.trim()
              ? data.server.trim()
              : typeof data.serverName === "string" && data.serverName.trim()
                ? data.serverName.trim()
                : toolName.startsWith("mcp__")
                  ? (toolName.split("__")[1] ?? null)
                  : null;
          if (toolName) {
            if (callId)
              toolCalls.set(callId, {
                tool: toolName,
                startedAt: Date.now(),
                server,
                args: data.arguments ?? null
              });
            // The model asking is not the tool running: this call is upgraded
            // to `tool_executed` only when its terminal event carries a result.
            onEvent?.({
              type: "tool_requested",
              tool: toolName,
              callId,
              server
            });
          }
          onEvent?.({
            type: "activity",
            text: toolActivityText(data),
            key: `tool:${data.toolCallId ?? ""}`
          });
          break;
        }
        case "result": {
          terminalResult = event;
          break;
        }
        default: {
          // `tool.execution_complete` settles a call the start event opened.
          // Matched by prefix rather than by that one name: the CLI's event
          // vocabulary is not a published schema, and a renamed terminal event
          // would otherwise silently stop every executed observation. An event
          // that carries no result still reports nothing (copilotToolOutcome).
          const eventType = String(event?.type ?? "");
          if (
            !eventType.startsWith("tool.") ||
            eventType === "tool.execution_start"
          )
            break;
          const callId = String(data.toolCallId ?? "").trim() || null;
          const open = callId ? toolCalls.get(callId) : null;
          const toolName = String(data.toolName ?? open?.tool ?? "").trim();
          if (!toolName) break;
          const outcome = copilotToolOutcome(data);
          if (outcome.kind === "none") break;
          if (callId) toolCalls.delete(callId);
          const server =
            (typeof data.server === "string" && data.server.trim()
              ? data.server.trim()
              : typeof data.serverName === "string" && data.serverName.trim()
                ? data.serverName.trim()
                : open?.server) ||
            (toolName.startsWith("mcp__")
              ? (toolName.split("__")[1] ?? null)
              : null);
          onEvent?.(
            outcome.kind === "unavailable"
              ? {
                  type: "tool_unavailable",
                  tool: toolName,
                  callId,
                  reason: outcome.reason,
                  server
                }
              : {
                  type: "tool_executed",
                  tool: toolName,
                  callId,
                  status: outcome.status,
                  durationMs: open ? Date.now() - open.startedAt : null,
                  server
                }
          );
          // A denied or failed call proves nothing was actually read, so only
          // a call the CLI itself reports as successful can surface a
          // skill_used event.
          if (outcome.kind === "executed" && outcome.status === "ok") {
            const skillEvent = skillReadEvent({
              seenSkills,
              toolName,
              args: open?.args ?? data.arguments,
              callId
            });
            if (skillEvent) onEvent?.(skillEvent);
          }
          break;
        }
      }
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finishReject(error));
    child.on("close", (code, signal) => {
      const exitCode = terminalResult?.exitCode ?? code;
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
      if (!answer.trim()) {
        finishReject(
          new Error("Copilot exited successfully without a final answer")
        );
        return;
      }
      finishResolve({ text: answer, result: terminalResult ?? {} });
    });
    onEvent?.({ type: "process", child });
  });
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sseLine(eventName: string, body: JsonRecord): string {
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

async function handle(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`)
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
    if (
      AUTH_TOKEN &&
      request.headers.authorization !== `Bearer ${AUTH_TOKEN}`
    ) {
      sendJson(response, 401, { error: "invalid local gateway key" });
      return;
    }
    let body: JsonRecord;
    try {
      body = JSON.parse(await bodyOf(request));
    } catch {
      sendJson(response, 400, { error: "invalid JSON" });
      return;
    }
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
      text: `Dispatched ${result.count} subagent(s): ${result.roles}. They are running now and are tracked by the orchestration layer, not by you.`
    });
    return;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, {
      error: { message: "not found", type: "invalid_request_error" }
    });
    return;
  }
  let payload: JsonRecord;
  try {
    payload = JSON.parse(await bodyOf(request));
  } catch {
    sendJson(response, 400, {
      error: { message: "invalid JSON", type: "invalid_request_error" }
    });
    return;
  }
  // The router classifies the turn; only it can tell this bridge that it is
  // serving the root orchestrator rather than a delegated leaf.
  const agentRole = resolveAgentRole(request.headers);
  // The CLI runs every tool inside its own runtime, so what this turn asked
  // for, ran, or was refused only reaches the router if this bridge says so.
  const agentEvents = resolveAgentEventReporter(request.headers);
  let cwd: string;
  try {
    cwd = resolveCwd(payload, request.headers, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    writeErrorLine(`copilot workspace resolution failed: ${error.message}`);
    sendJson(response, 400, {
      error: { type: "invalid_request_error", message: error.message }
    });
    return;
  }
  const prompt = inputText(
    payload.input,
    composeProviderPrompt(agentRole, cwd)
  );
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
    `copilot bootstrap provider=copilot model=${payload.model} role=${agentRole ?? "default"} cwd=${cwd} skills=${JSON.stringify(bootstrapContract.skills ?? [])} mcp=${JSON.stringify(bootstrapContract.mcp ?? [])}`
  );
  writeErrorLine(
    `copilot request model=${payload.model} role=${isOrchestratorRole(agentRole) ? "orchestrator" : "leaf"} cwd=${cwd}`
  );
  // Exposure, not invocation: the role contract decides which skills this turn
  // can reach before the CLI starts. Deriving it from what the model happened
  // to invoke would report nothing for a turn that was given skills and never
  // reached for one, which is the case per-workspace skill attribution exists
  // to be able to show.
  if (agentEvents) {
    for (const skill of bootstrapContract.skills ?? []) {
      void agentEvents.reportSkillExposed({
        skill,
        source: SKILL_EXPOSURE_SOURCE
      });
    }
    for (const server of bootstrapContract.mcp ?? []) {
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

  if (payload.stream === false) {
    try {
      const nonStreamHeartbeat = setInterval(() => {
        if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
          void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
        }
      }, 5000);
      let result: RunCopilotResult;
      try {
        result = await runCopilot(
          prompt,
          payload.model,
          cwd,
          (event) => {
            if (
              agentEvents &&
              typeof agentEvents.reportHeartbeat === "function"
            ) {
              void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
            }
            reportToolObservation(agentEvents, event);
          },
          agentRole,
          spawnSession
        );
      } finally {
        clearInterval(nonStreamHeartbeat);
      }
      const output = [
        responseMessageItem(
          result.text,
          `msg_${randomBytes(10).toString("hex")}`
        )
      ];
      const spawnChildren = spawnSession
        ? spawnSessions.close(spawnSession)
        : [];
      if (spawnSession && spawnChildren.length > 0) {
        const spawnEvents = execToolCallSseEvents({
          itemId: mintCallItemId(),
          callId: mintCallId(spawnSession, output.length),
          source: buildSpawnScript(spawnChildren, {
            recoverParentId: spawnSession
          }),
          outputIndex: output.length
        });
        output.push(spawnEvents[3][1].item as unknown as JsonRecord);
        writeErrorLine(
          `copilot delegating ${spawnChildren.length} subagent(s) through Codex`
        );
      }
      sendJson(
        response,
        200,
        responsePayload(
          payload.model,
          result.text,
          result.result,
          undefined,
          undefined,
          output
        )
      );
    } catch (error) {
      if (spawnSession) spawnSessions.close(spawnSession);
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 503, {
        error: { type: "copilot_proxy_error", message }
      });
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
  const isWritable = () =>
    !clientClosed &&
    !response.writableEnded &&
    !response.destroyed &&
    !response.closed;
  const emit = (eventName: string, body: JsonRecord) => {
    const event = sseLine(eventName, {
      ...body,
      sequence_number: ++sequenceNumber
    });
    if (!isWritable()) return;
    if (streamStarted) {
      try {
        response.write(event);
      } catch {}
    } else {
      pendingEvents.push(event);
    }
  };
  // Hold the SSE headers back until the CLI has produced real output. Until
  // then a provider failure can still be reported as an HTTP status the router
  // is able to fall back on; after it, the turn is genuinely under way and the
  // parent should watch it live.
  const startStream = () => {
    if (streamStarted || !isWritable()) return;
    streamStarted = true;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close"
    });
    response.flushHeaders();
    response.shouldKeepAlive = false;
    for (const event of pendingEvents.splice(0)) {
      if (!isWritable()) break;
      try {
        response.write(event);
      } catch {}
    }
  };
  const emitActivity = (text: string, key: string = text) => {
    if (!text || seenActivities.has(key) || !isWritable()) return;
    seenActivities.add(key);
    activityParts.push(text);
    emit("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: `${text}\n`
    });
  };
  emit("response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: payload.model,
      status: "in_progress",
      output: []
    }
  });
  emit("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: reasoningId,
      type: "reasoning",
      status: "in_progress",
      summary: [],
      content: []
    }
  });
  emit("response.reasoning_summary_part.added", {
    type: "response.reasoning_summary_part.added",
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: "" }
  });
  emit("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 1,
    item: {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: []
    }
  });
  emit("response.content_part.added", {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 1,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] }
  });

  const onResponseError = () => {
    clientClosed = true;
    clearInterval(keepAlive);
    if (child && !child.killed) child.kill("SIGTERM");
  };
  response.on("error", onResponseError);

  const keepAlive = setInterval(() => {
    if (typeof agentEvents?.reportHeartbeat === "function") {
      void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }
    if (streamStarted && isWritable()) {
      try {
        response.write(": copilot-bridge keep-alive\n\n");
      } catch {}
    }
  }, 2000);
  let child: ChildProcess | undefined;
  response.on("close", () => {
    clientClosed = true;
    clearInterval(keepAlive);
    response.removeListener("error", onResponseError);
    if (child && !child.killed) child.kill("SIGTERM");
  });
  try {
    const result = await runCopilot(
      prompt,
      payload.model,
      cwd,
      (event) => {
        if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
          void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
        }
        if (event.type === "process") {
          child = event.child;
          return;
        }
        // Telemetry only: a tool observation says nothing to the parent, and the
        // activity line the CLI emits alongside it is what commits the stream.
        if (TOOL_OBSERVATION_TYPES.has(event.type)) {
          reportToolObservation(agentEvents, event);
          return;
        }
        startStream();
        if (event.type === "text_delta") {
          partialText += event.text;
          emit("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: itemId,
            delta: event.text,
            content_index: 0,
            output_index: 1
          });
          return;
        }
        // Commentary and tool narration are appended verbatim; the CLI streams
        // commentary token by token, so those parts are keyed by their text.
        emitActivity(
          event.text,
          event.key ?? `activity:${activityParts.length}:${event.text}`
        );
      },
      agentRole,
      spawnSession
    );
    startStream();
    const reasoningText = activityParts.join("");
    const completedReasoning = {
      id: reasoningId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
      content: []
    };
    const completedMessage = responseMessageItem(result.text, itemId);
    const completed = responsePayload(
      payload.model,
      result.text,
      result.result,
      responseId,
      itemId,
      [completedReasoning, completedMessage]
    );
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      text: reasoningText
    });
    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: reasoningText }
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: completedReasoning
    });
    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      text: result.text,
      content_index: 0,
      output_index: 1
    });
    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: result.text, annotations: [] }
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 1,
      item: completedMessage
    });
    const spawnChildren = spawnSession ? spawnSessions.close(spawnSession) : [];
    if (spawnSession && spawnChildren.length > 0) {
      const spawnEvents = execToolCallSseEvents({
        itemId: mintCallItemId(),
        callId: mintCallId(spawnSession, completed.output.length),
        source: buildSpawnScript(spawnChildren, {
          recoverParentId: spawnSession
        }),
        outputIndex: completed.output.length
      });
      for (const [eventName, body] of spawnEvents)
        emit(eventName, body as unknown as JsonRecord);
      completed.output.push(spawnEvents[3][1].item as unknown as JsonRecord);
      writeErrorLine(
        `copilot delegating ${spawnChildren.length} subagent(s) through Codex`
      );
    }
    emit("response.completed", {
      type: "response.completed",
      response: completed
    });
    if (isWritable()) {
      try {
        response.end("data: [DONE]\n\n");
      } catch {}
    }
  } catch (error) {
    if (spawnSession) spawnSessions.close(spawnSession);
    if (!isWritable()) return;
    const message = error instanceof Error ? error.message : String(error);
    const exitCode =
      typeof (error as { exitCode?: unknown } | null)?.exitCode === "number"
        ? (error as { exitCode: number }).exitCode
        : null;
    // The CLI reports a usage limit as an error string like any other failure,
    // so this is the one place the two can be told apart. Only ever `inferred`:
    // enough to pick a status the router can act on, never enough on its own to
    // take the provider out for a long cooldown.
    const limit = classifyCliLimit(message, exitCode);
    if (!streamStarted) {
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
      const body: JsonRecord = {
        error: { type: "copilot_proxy_error", message }
      };
      const declaredLimit = limitPayload(limit);
      if (declaredLimit) body.error.limit = declaredLimit;
      sendJson(response, status, body, headers);
      return;
    }
    // A failure after the stream opened cannot be replayed elsewhere, so the
    // work already sent is all the parent will get for this turn. Close it as
    // incomplete carrying that work rather than discarding it with a bare
    // `response.failed`; it still counts as a provider failure upstream.
    for (const [eventName, body] of terminalIncompleteEvents({
      responseId,
      itemId,
      reasoningId,
      text: partialText,
      reasoningText: activityParts.join(""),
      reason: limit
        ? INCOMPLETE_REASON_PROVIDER_LIMIT
        : INCOMPLETE_REASON_INTERRUPTED,
      limit,
      provider: "copilot",
      response: responsePayload(
        payload.model,
        partialText,
        null,
        responseId,
        itemId,
        [],
        "incomplete"
      )
    }))
      emit(eventName, body);
    if (isWritable()) {
      try {
        response.end("data: [DONE]\n\n");
      } catch {}
    }
  } finally {
    clearInterval(keepAlive);
    if (spawnSession) spawnSessions.close(spawnSession);
    response.removeListener("error", onResponseError);
  }
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
