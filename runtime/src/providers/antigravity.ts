#!/usr/bin/env node

/** OpenAI Responses compatibility proxy for the subscription-authenticated agy CLI. */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { homedir, tmpdir } from "node:os";
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
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
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
  INCOMPLETE_REASON_CLIENT_DISCONNECTED,
  INCOMPLETE_REASON_INTERRUPTED,
  INCOMPLETE_REASON_PROVIDER_LIMIT,
  limitPayload,
  limitResponseHeaders,
  type ProviderFailureDiagnostic,
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
  REQUEST_ID_HEADER,
  resolveAgentEventReporter,
  SKILL_READ_SOURCE
} from "@simulatorlife/autodev-runtime/telemetry";
import {
  AUTODEV_WORKSPACE_KEY_HEADER,
  withAutoDevOtelResourceContext
} from "@simulatorlife/autodev-runtime/telemetry/resource-context";

// Bind the port only when run as a program. The shared request-shaping helpers
// below are pure and worth testing directly; importing this file must not take
// the port out from under the running bridge.
const IS_MAIN =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const HOST = process.env.AGY_PROXY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.AGY_PROXY_PORT ?? "4002");
const CLI =
  process.env.AGY_CLI_PATH ??
  `${process.env.HOME ?? process.cwd()}/.local/bin/agy`;
const DEFAULT_MODEL = "gemini-3.8-flash-medium";
const DEFAULT_EFFORT = "medium";
const AGY_MODE = process.env.AGY_MODE ?? "accept-edits";
const AGY_SKIP_PERMISSIONS = process.env.AGY_SKIP_PERMISSIONS ?? "true";
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT ?? "0";
const AUTH_TOKEN = process.env.LITELLM_API_KEY ?? "";
const PROJECT_ROOT =
  process.env.CODEX_PROJECT_ROOT ?? process.env.AGY_PROJECT_ROOT ?? null;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EFFORTS = new Set(["low", "medium", "high"]);
// agy encodes reasoning depth in the model id itself (`gemini-3.8-flash-high`)
// and rejects the whole invocation when a separate --effort disagrees with it:
// "invalid model selection: --model gemini-3.8-flash-high conflicts with
// --effort=medium". The router picks the model per tier and the caller's
// effort is an independent value, so the two routinely disagree and the turn
// fails before the CLI starts. The model id is the more specific choice, so it
// wins and --effort is omitted for models that already carry one.
const MODEL_EFFORT_SUFFIX = /-(low|medium|high)$/;
const SAFE_PROVIDER_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const READ_URL_PERMISSION_PATTERN = /^read_url\(/i;

// The agy CLI's `stream-json` step updates are JSON-shaped but are not a
// formally specified schema: field names and nesting have moved across CLI
// versions (see the `Subagents` walk below), and this bridge deliberately
// tolerates shapes it does not own rather than pinning one path a CLI update
// can silently break. Keep that dynamic edge explicit and named while the
// transport, telemetry, and boundary operations around it stay typed. Mirrors
// the MiniMax and Copilot adapters.
//
// Bounded JSON value/record types: `JsonObject` carries an index signature so
// vendor fields agy adds across CLI versions stay readable by name without a
// cast; `JsonArray` and `JsonPrimitive` close the union. The recursive shape
// means `noUncheckedIndexedAccess` adds `undefined` to indexed access, which
// the guards below turn back into a `JsonValue` once narrow. `unknown`-typed
// CLI input flows through `structured()` to land as one of these records.
type JsonPrimitive = string | number | boolean | null;
type JsonArray = JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type JsonRecord = JsonObject;

interface AntigravityMcpServerConfig extends JsonRecord {
  command?: string;
  args?: string[];
  cwd?: JsonValue;
  env?: JsonRecord;
  serverUrl?: string;
  bearer_token_env_var?: string;
  headers?: JsonRecord;
}

interface AntigravityMcpConfig extends JsonRecord {
  mcpServers: Record<string, AntigravityMcpServerConfig>;
}

interface AntigravityPermissionConfig extends JsonRecord {
  allow: JsonArray;
  deny: JsonArray;
}

interface AntigravitySettings extends JsonRecord {
  permissions: AntigravityPermissionConfig;
}

interface AgyErrorDetails extends JsonRecord {
  type: string;
  message: string;
  provider: "antigravity";
  role: string;
  workspace: string;
  requestId: string | null;
  code?: string;
  phase?: string | null;
  tool?: string | null;
  limit?: Record<string, string | null>;
}

type AgentReporter = AgentEventReporter;

/** One subagent a spawn step created, as this bridge tracks it. */
type SpawnedChild = {
  id: string;
  role: string | null;
  model: string | null;
  logUri: string | null;
};

/**
 * The delegation tracker the request handler owns and `updateDelegationState`
 * mutates in place. Command/wait counters are maintained by the step observer.
 */
interface DelegationState {
  activeTool: string | null;
  activeStep: number | null;
  activatedAt: number;
  pendingChildren: number;
  activeCommands: number;
  activeWaits: number;
  activeCommand?: string | null;
  activeWait?: string | null;
}

type DelegationTransition =
  | { kind: "entered"; tool: string }
  | { kind: "exited"; tool: string | null }
  | { kind: "unchanged" };

/** What a response close/error handler should do given the tracker. */
interface CloseDecision {
  kill: boolean;
  reason: string;
  tool: string | null;
  pendingChildren: number;
  activeCommands: number;
  activeWaits: number;
}

/**
 * agy reports a failure as an error string plus an exit status; the bridge
 * attaches the classification it recovered from stderr (via `Object.assign`
 * on a real `Error`) so the router can act on it. Callers receive whatever was
 * thrown, so `agyFailure` decodes these fields from any value.
 */
interface AgyFailure {
  message: string | null;
  exitCode: number | null;
  failureCode: string | null;
  failurePhase: string | null;
  failureTool: string | null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The agy classification fields carried by a thrown value, each validated. */
function agyFailure(error: unknown): AgyFailure {
  if (typeof error !== "object" || error === null)
    return {
      message: null,
      exitCode: null,
      failureCode: null,
      failurePhase: null,
      failureTool: null
    };
  return {
    message: "message" in error ? textOrNull(error.message) : null,
    exitCode:
      "exitCode" in error && typeof error.exitCode === "number"
        ? error.exitCode
        : null,
    failureCode: "failureCode" in error ? textOrNull(error.failureCode) : null,
    failurePhase:
      "failurePhase" in error ? textOrNull(error.failurePhase) : null,
    failureTool: "failureTool" in error ? textOrNull(error.failureTool) : null
  };
}

interface RunAgyResult {
  text: string;
  result: JsonRecord;
}

/** One tool-info block carried inside an agy step_update. */
interface AgyToolInfo extends JsonRecord {
  name?: string;
  args?: JsonValue;
  output?: JsonValue;
  result?: JsonValue;
  status_message?: string;
  error?: string;
  duration_seconds?: number;
  server?: string;
}

/** The fields of one agy step_update event this bridge actually reads. */
interface AgyStepUpdate extends JsonRecord {
  step_index?: number;
  step_type?: string;
  state?: string;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  tool_input?: JsonValue;
  status_message?: string;
  error?: string;
  duration_seconds?: number;
  output?: JsonValue;
  result?: JsonValue;
  text_delta?: string;
  server?: string;
}

/**
 * What one `step_type: "tool"` update proves about the call, as a discriminated
 * union callers can switch on without a cast.
 *
 *   requested   -- the model asked; the router's `tool_requested`.
 *   executed    -- the call ran; the router's `tool_executed`.
 *   unavailable -- the call was refused/cancelled; `tool_unavailable`.
 *   none        -- the step carries no useful evidence either way.
 */
type ToolStepEvidence =
  | { kind: "requested" }
  | { kind: "executed"; status: "ok" | "error"; durationMs: number | null }
  | {
      kind: "unavailable";
      reason: "permission_denied" | "denied" | "cancelled";
    }
  | { kind: "none" };

/** A decoded JSON line from agy's stream-json protocol. */
interface AgyStreamEvent extends JsonRecord {
  event?: string;
  step_update?: JsonValue;
  result?: JsonValue;
  type?: string;
  text?: string;
}

interface AgyProcessEvent {
  type: "process";
  child: ChildProcess;
}

interface AgyBackgroundTasksEvent {
  type: "background_tasks_active";
  text: string;
}

interface AgyTextDeltaEvent {
  type: "text_delta";
  text: string;
}

type AgyEvent =
  | AgyStreamEvent
  | AgyProcessEvent
  | AgyBackgroundTasksEvent
  | AgyTextDeltaEvent;

type OnAgyEvent = (event: AgyEvent) => void;

/** Validate a decoded value recursively as JSON, rejecting cycles. */
function isJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set<object>()
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

/** A JSON object: non-null, non-array `object`. */
function isJsonRecord(value: unknown): value is JsonRecord {
  return (
    isJsonValue(value) &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/** A JSON array. */
function isJsonArray(value: unknown): value is JsonArray {
  return isJsonValue(value) && Array.isArray(value);
}

/** True when value looks like one agy step_update payload. */
function isStepUpdate(value: unknown): value is AgyStepUpdate {
  return isJsonRecord(value);
}

/** The finite step index a step_update carries, or null when absent/invalid. */
function stepIndexOf(update: AgyStepUpdate): number | null {
  const index: JsonValue | undefined = update.step_index;
  return typeof index === "number" && Number.isFinite(index) ? index : null;
}

/** True when value looks like an agy tool_info block. */
function isToolInfo(value: unknown): value is AgyToolInfo {
  return isJsonRecord(value);
}

/** True when value looks like an agy stream-json event. */
function isStreamEvent(value: unknown): value is AgyStreamEvent {
  return isJsonRecord(value);
}

/**
 * True for a decoded agy step_update line. Control events are built in-process
 * without an `event` key, so the key alone separates them from stream lines
 * without re-validating the payload that decoding already proved to be JSON.
 */
function isStepUpdateEvent(event: AgyEvent): event is AgyStreamEvent {
  return "event" in event && event.event === "step_update";
}

/** Narrow the internal process notification without treating it as JSON. */
function isProcessEvent(event: AgyEvent): event is AgyProcessEvent {
  return (
    "type" in event &&
    event.type === "process" &&
    "child" in event &&
    typeof event.child === "object" &&
    event.child !== null &&
    "kill" in event.child &&
    typeof event.child.kill === "function" &&
    "killed" in event.child &&
    typeof event.child.killed === "boolean"
  );
}

function isBackgroundTasksEvent(
  event: AgyEvent
): event is AgyBackgroundTasksEvent {
  return (
    "type" in event &&
    event.type === "background_tasks_active" &&
    "text" in event &&
    typeof event.text === "string"
  );
}

function isTextDeltaEvent(event: AgyEvent): event is AgyTextDeltaEvent {
  return (
    "type" in event &&
    event.type === "text_delta" &&
    "text" in event &&
    typeof event.text === "string"
  );
}

// `roleContract` types the fields every consumer shares (`mcp`) and leaves the
// rest behind an index signature. This bridge additionally reads `readOnly`
// and `skills`, which are real contract fields; narrow them here rather than
// widening the shared type for one bridge's shape. Mirrors the Copilot adapter.
type AntigravityRoleContract = RoleContract & {
  readOnly?: boolean;
  skills?: string[];
  mcpTools?: Record<string, string[]>;
};

function antigravityRoleContract(role: unknown): AntigravityRoleContract {
  return roleContract(role) as AntigravityRoleContract;
}

// agy's spawn tool takes a batch, not one child: the orchestrator calls
// `invoke_subagent` with `{"Subagents":[{"TypeName":...,"Model":...,"Prompt":...}, ...]}`
// and agy's own guidance is to dispatch "subagents in batches of at most 16 per
// invoke_subagent call". Reporting the tool call rather than its entries turned
// a twelve-way fan-out into a count of one and named no role at all, which left
// `antigravity/null` as the only trace of a delegation in `/status`.
//
// Where the batch sits inside the step update is agy's business, not this
// bridge's: the stream-json step carries tool arguments under `tool_info`, and
// nests or serializes them differently across CLI versions. Rather than pin one
// path that a CLI update can silently break -- and silently is how this failure
// mode always presents -- the walk below finds the first `Subagents` array
// anywhere in the update, at any of the shapes agy has used. Finding none is not
// an error: the step simply did not export its arguments, and the call is
// reported as one roleless spawn exactly as it was before.
const MAX_SPAWN_ARG_DEPTH = 6;

/** A JSON-encoded object/array parsed, a plain object/array as-is, else null. */
function structured(value: unknown): JsonObject | JsonArray | null {
  if (isJsonRecord(value) || isJsonArray(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonRecord(parsed) || isJsonArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The `Subagents` batch somewhere inside a step update, or null. */
function subagentBatch(value: unknown, depth = 0): JsonValue[] | null {
  if (depth > MAX_SPAWN_ARG_DEPTH) return null;
  const node = structured(value);
  if (!node) return null;
  if (!Array.isArray(node)) {
    const key = Object.keys(node).find(
      (candidate) => candidate.toLowerCase() === "subagents"
    );
    if (key !== undefined) {
      const batch = node[key];
      if (isJsonArray(batch) && batch.length > 0) return batch;
    }
  }
  for (const child of Array.isArray(node) ? node : Object.values(node)) {
    const found = subagentBatch(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The role one batch entry names, or null when it names none. */
// `self` is agy's back-reference to the caller's own archetype -- "invoke_subagent
// with your archetype TypeName (or `self`)" -- not the name of one. Recorded
// verbatim it becomes a `self` row in the router's byRole breakdown, sitting
// beside real roles as though it were one and collapsing every self-dispatched
// child under a label that describes nothing. The child declared no archetype of
// its own, which is exactly what the router's unattributed bucket is for.
const SELF_ARCHETYPE = "self";

function subagentRole(child: JsonValue): string | null {
  if (!isJsonRecord(child)) return null;
  // agy identifies a child by its archetype, and `define_subagent` registers
  // that archetype under `name`. Model is deliberately not a fallback: it is
  // the model, not the role, and would pollute `byRole` with model ids.
  for (const key of [
    "TypeName",
    "type_name",
    "typeName",
    "Name",
    "name",
    "Agent",
    "agent"
  ]) {
    const value = child[key];
    if (typeof value !== "string" || !value.trim()) continue;
    return value.trim().toLowerCase() === SELF_ARCHETYPE ? null : value.trim();
  }
  return null;
}

/** The model one batch entry names, or null when it names none of its own. */
function subagentModel(child: JsonValue): string | null {
  if (!isJsonRecord(child)) return null;
  for (const key of ["Model", "model", "ModelName", "model_name"]) {
    const value = child[key];
    // agy writes `inherit` when the child runs on whatever the parent was
    // routed to, which is not a model id; the router resolves that itself.
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** agy's own id for a child conversation, or null when the entry carries none. */
function subagentConversationId(child: JsonValue): string | null {
  if (!isJsonRecord(child)) return null;
  for (const key of ["conversation_id", "conversationId", "ConversationId"]) {
    const value = child[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Where agy is writing the child's transcript, when it says. */
function subagentLogUri(child: JsonValue): string | null {
  if (!isJsonRecord(child)) return null;
  for (const key of ["log_uri", "logUri", "LogUri"]) {
    const value = child[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * One `{ id, role, model, logUri }` per subagent a spawn step created; always at
 * least one. The id is this bridge's handle on the child: it identifies the same
 * child again when the step finishes, so the router can measure the child's own
 * turn rather than the whole parent turn.
 *
 * agy names the child itself, and that name is what the id should be. A
 * position-derived id (`s<step>.<index>`) only pairs the open with the close
 * while the batch is emitted in the same order both times, which is an
 * assumption about agy's internals rather than something it promises -- and a
 * mispairing silently attributes one child's duration to another. The
 * `conversation_id` agy puts on every entry is stable across the ACTIVE and
 * DONE steps for the same child, so it pairs them by identity instead. The
 * positional id remains the fallback for an entry that carries no id of its own.
 */
let anonymousSpawnStep = 0;
function spawnedChildren(update: unknown): SpawnedChild[] {
  const stepIndex = isStepUpdate(update) ? stepIndexOf(update) : null;
  const step: number | string = stepIndex ?? `x${(anonymousSpawnStep += 1)}`;
  const batch = subagentBatch(update);
  if (!batch)
    return [{ id: `s${step}.0`, role: null, model: null, logUri: null }];
  return batch.map((child: JsonValue, index: number) => ({
    id: subagentConversationId(child) ?? `s${step}.${index}`,
    role: subagentRole(child),
    model: subagentModel(child),
    logUri: subagentLogUri(child)
  }));
}

// Confirming the shape agy actually emits needs a real spawn, and a spawn is
// rare enough that guessing wrong would go unnoticed for weeks. This prints the
// spawn step's structure -- keys kept, string values truncated, so a delegation
// prompt is not written to the launchd log -- when AGY_LOG_SPAWN_STEPS=1.
const LOG_SPAWN_STEPS = process.env.AGY_LOG_SPAWN_STEPS === "1";
const SPAWN_STEP_LOG_STRING_LIMIT = 80;

function shapeOnly(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === "string")
    return value.length > SPAWN_STEP_LOG_STRING_LIMIT
      ? `${value.slice(0, SPAWN_STEP_LOG_STRING_LIMIT)}...<${value.length}>`
      : value;
  if (
    value === null ||
    typeof value !== "object" ||
    depth > MAX_SPAWN_ARG_DEPTH
  )
    return value;
  if (Array.isArray(value))
    return value.map((entry) => shapeOnly(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      shapeOnly(entry, depth + 1)
    ])
  );
}

// agy's own name for its batch delegation tool. Reporting a spawn to the
// router needs the router's headers -- somewhere to post, and a request id to
// correlate the report -- so a caller that is not the router, or a header
// that failed to propagate through an intermediary, correctly gets no
// telemetry. But the delegation *lifecycle* this bridge tracks locally (not
// killing agy while a child it dispatched is still running) only needs to
// recognize the step as a spawn, not to report it anywhere. Falling back to
// agy's own tool name keeps that recognition working even with no reporter,
// without granting the caller anything a header would: nothing is ever
// posted to the router unless resolveAgentEventReporter actually authorized
// it, so this does not weaken the router/caller boundary.
const ANTIGRAVITY_SPAWN_TOOL_NAMES = new Set(["invoke_subagent"]);
function isSpawnToolName(
  agentEvents: AgentReporter | null,
  toolName: string
): boolean {
  if (agentEvents) return agentEvents.isSpawnTool(toolName);
  return ANTIGRAVITY_SPAWN_TOOL_NAMES.has(toolName);
}

// How an agy turn comes by the skills its role contract grants it: agy has no
// per-invocation skill flag, so the contract rendered into the turn's prompt
// and the workspace's own `.agents/skills.json` registry are the exposure.
// Carried on every `skill_exposed` event so the router's rows say which
// mechanism made the skill available rather than only that something did.
const ANTIGRAVITY_SKILL_EXPOSURE_SOURCE = "role_contract";
const ANTIGRAVITY_MCP_EXPOSURE_SOURCE = "role_contract";

// Canonical skill roots whose `SKILL.md` a successful read counts as actual
// usage, mirroring the approved roots `runtime/src/hooks/skill-read-telemetry.ts`
// uses for Codex's own PreToolUse hook. agy's own tool calls never reach that
// hook -- its CLI runs entirely inside its own runtime -- so this bridge is
// the only place a `read_file`/`view_file` or shell read of one of these
// files is observable at all.
const HOME = homedir();
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

// Tool names agy uses to read a file's contents outright, versus the shell
// tools whose command line may contain a read of one. Anything else --
// `write_file`, `edit_file`, `str_replace`, agy's own delegation tool -- is
// deliberately excluded: a mutation or an unrelated call must never be
// counted as a skill activation just because its arguments happen to name a
// path.
const AGY_READ_TOOL_NAMES = new Set(["read_file", "view_file", "cat_file"]);
const AGY_EXEC_TOOL_NAMES = new Set([
  "run_command",
  "exec_command",
  "execute_command",
  "bash"
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
// plain file arguments agy's own tool calls put on these command lines.
function tokenizeShellWords(cmd: string): string[] {
  const tokens = [];
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
function flattenCommandValue(raw: unknown): string {
  let value: unknown = raw;
  if (isJsonRecord(value)) {
    value = value.cmd ?? value.command ?? value.script ?? value.value ?? null;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join(" ");
  }
  return typeof value === "string" ? value : "";
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

/** The path a `read_file`-shaped or shell-read tool call names, if any. */
function extractSkillReadPath(
  toolName: string,
  argsObject: unknown
): string | null {
  const name = String(toolName ?? "")
    .trim()
    .toLowerCase();
  const args: JsonRecord = isJsonRecord(argsObject) ? argsObject : {};
  if (AGY_READ_TOOL_NAMES.has(name)) {
    for (const key of [
      "file_path",
      "filePath",
      "path",
      "filepath",
      "AbsolutePath",
      "absolutePath",
      "targetFile",
      "TargetFile"
    ]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }
  if (AGY_EXEC_TOOL_NAMES.has(name)) {
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

/** Report a successful, canonical `SKILL.md` read as `skill_used`, once per skill per turn. */
function reportSkillReadIfMatched({
  agentEvents,
  seenSkills,
  toolName,
  args,
  callId
}: {
  agentEvents: AgentReporter | null;
  seenSkills: Set<string>;
  toolName: string;
  args: unknown;
  callId: string | null;
}): void {
  if (!agentEvents || typeof agentEvents.reportSkillUsed !== "function") return;
  const candidate = extractSkillReadPath(toolName, args);
  if (!candidate) return;
  const normalised = normaliseSkillReadPath(candidate);
  const skill = matchSkillReadPath(normalised);
  if (!skill) return;
  if (seenSkills.has(skill)) return;
  seenSkills.add(skill);
  const eventId = `skill_read:${callId ?? "no-call-id"}:${skill}`;
  void agentEvents.reportSkillUsed({
    skill,
    source: SKILL_READ_SOURCE,
    eventId
  });
}

// Where agy puts a tool call's output. Its own changelog describes `tool_info`
// as carrying "canonical tool name, parameters, and output", and which key
// holds the payload has moved between CLI versions, so any of these counts as
// the output that proves the call ran. Guessing one and pinning it would make
// a CLI update silently downgrade every executed call to a requested one.
const TOOL_OUTPUT_KEYS = [
  "output",
  "result",
  "tool_output",
  "tool_result",
  "response",
  "content"
];
const TERMINAL_TOOL_STATES = new Set(["DONE", "ERROR", "FAILED", "CANCELLED"]);

const AGY_DENIED_PATTERN =
  /permission[_\s-]?denied|auto[_\s-]?denied|denied|not[_\s-]?permitted|not[_\s-]?allowed|no such tool|tool not found/i;
const PERMISSION_DENIED_REASON_PATTERN = /permission|auto[_\s-]?denied/i;

/** True when a step carries the tool call's own output. */
function isToolOutput(value: JsonValue | undefined): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || value.trim() !== "")
  );
}

function toolOutputPresent(update: JsonValue): boolean {
  const record = isStepUpdate(update) ? update : null;
  const parsed = structured(record?.tool_info);
  const info = parsed !== null && !Array.isArray(parsed) ? parsed : {};
  return TOOL_OUTPUT_KEYS.some((key) =>
    isToolOutput(info[key] ?? record?.[key])
  );
}

/** The MCP server an Antigravity tool belongs to, or null if builtin / unspecified. */
function antigravityToolServer(
  update: JsonValue,
  toolName: string
): string | null {
  const record = isStepUpdate(update) ? update : null;
  const toolInfo = isToolInfo(record?.tool_info) ? record?.tool_info : null;
  const rawServer = record?.server ?? toolInfo?.server;
  if (typeof rawServer === "string" && rawServer.trim())
    return rawServer.trim();
  const name = typeof toolName === "string" ? toolName.trim() : "";
  const serverFromName = mcpServerFromToolName(name);
  if (serverFromName) return serverFromName;
  return (
    serverFromArguments(structured(toolInfo?.args)) ??
    serverFromArguments(structured(record?.tool_input))
  );
}

function mcpServerFromToolName(name: string): string | null {
  const separator = name.startsWith("mcp__")
    ? "__"
    : name.startsWith("mcp_")
      ? "_"
      : null;
  if (!separator) return null;
  const parts = name.split(separator);
  return parts.length >= 3 ? (parts[1] ?? null) : null;
}

function serverFromArguments(
  value: JsonObject | JsonArray | null
): string | null {
  if (!isJsonRecord(value)) return null;
  for (const key of ["ServerName", "server_name"]) {
    const server = value[key];
    if (typeof server === "string" && server.trim()) return server.trim();
  }
  return null;
}

/** How long agy says the call took, in ms, or null when it does not say. */
function toolDurationMs(update: JsonValue): number | null {
  const record = isStepUpdate(update) ? update : null;
  const toolInfo = isToolInfo(record?.tool_info) ? record?.tool_info : null;
  const seconds: JsonValue | undefined =
    record?.duration_seconds ?? toolInfo?.duration_seconds;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * 1000))
    : null;
}

/**
 * What one `step_type: "tool"` update proves about the call.
 *
 * `requested` is the model asking; `executed` is the call having run. The
 * router treats `tool_executed` as the first-class evidence that unlocks
 * per-workspace tool attribution, so a call is only ever reported as executed
 * on agy's own completion record for it: `DONE` (which carries
 * `duration_seconds` for the call), or a terminal state carrying the call's
 * output. A terminal state with neither -- a cancelled call, one agy refused
 * -- proves only that the model asked, which the ACTIVE step already said.
 *
 * The result is a discriminated union; switch on `kind` rather than re-reading
 * loose fields from the returned record.
 */
function toolStepEvidence(update: JsonValue): ToolStepEvidence {
  const record = isStepUpdate(update) ? update : null;
  const toolInfo = isToolInfo(record?.tool_info) ? record?.tool_info : null;
  const state = String(record?.state ?? "").toUpperCase();
  if (state === "ACTIVE") return { kind: "requested" };
  if (!TERMINAL_TOOL_STATES.has(state)) return { kind: "none" };
  const statusMessage = String(
    record?.status_message ??
      record?.error ??
      toolInfo?.error ??
      toolInfo?.status_message ??
      ""
  );
  const outputText = String(
    toolInfo?.output ??
      toolInfo?.result ??
      record?.output ??
      record?.result ??
      ""
  );
  if (
    AGY_DENIED_PATTERN.test(statusMessage) ||
    (state !== "DONE" && AGY_DENIED_PATTERN.test(outputText))
  ) {
    const reason = PERMISSION_DENIED_REASON_PATTERN.test(
      statusMessage || outputText
    )
      ? "permission_denied"
      : "denied";
    return { kind: "unavailable", reason };
  }
  if (state !== "DONE" && !toolOutputPresent(update)) {
    if (state === "CANCELLED")
      return { kind: "unavailable", reason: "cancelled" };
    return { kind: "none" };
  }
  return {
    kind: "executed",
    status: state === "DONE" ? "ok" : "error",
    durationMs: toolDurationMs(update)
  };
}

/** agy's handle on a tool call within this turn: its step index. */
function toolCallId(update: JsonValue): string | null {
  const stepIndex = isStepUpdate(update) ? stepIndexOf(update) : null;
  return stepIndex === null ? null : `s${stepIndex}`;
}

/**
 * Reports the tools one agy turn asked for and the ones it actually ran.
 *
 * Delegation is deliberately out of scope here: agy emits its
 * `invoke_subagent` dispatch as `step_type: "subagent"`, and those are already
 * reported through the spawn channel as children rather than as tool calls.
 * Only `step_type: "tool"` steps reach this observer, so a fan-out is never
 * counted twice under two different meanings.
 *
 * A step repeats its state (ACTIVE while the call runs, then a terminal one),
 * so both halves are de-duplicated per call: the router counts events, and a
 * chatty stream would otherwise report one call as several.
 */
function createToolObserver(agentEvents: AgentReporter | null) {
  const requested = new Set<string>();
  const settled = new Set<string>();
  // Per-turn dedupe for skill reads: keyed on the skill name, not the call,
  // so re-reading the same SKILL.md from a second tool call in the same turn
  // still reports one use rather than two.
  const seenSkills = new Set<string>();
  const observeToolStep = (update: JsonValue) => {
    if (!agentEvents) return;
    if (!isStepUpdate(update)) return;
    if (String(update.step_type ?? "").toLowerCase() !== "tool") return;
    const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
    const tool = String(update.tool_name ?? toolInfo?.name ?? "").trim();
    if (!tool) return;
    const callId = toolCallId(update);
    const key = callId ?? tool;
    const evidence = toolStepEvidence(update);
    const server = antigravityToolServer(update, tool);
    if (evidence.kind === "requested") {
      if (requested.has(key)) return;
      requested.add(key);
      void agentEvents.reportToolRequested({ tool, callId, server });
      return;
    }
    if (evidence.kind === "unavailable") {
      if (settled.has(key)) return;
      settled.add(key);
      void agentEvents.reportToolUnavailable({
        tool,
        callId,
        reason: evidence.reason,
        server
      });
      return;
    }
    if (evidence.kind !== "executed" || settled.has(key)) return;
    settled.add(key);
    void agentEvents.reportToolExecuted({
      tool,
      callId,
      status: evidence.status,
      durationMs: evidence.durationMs,
      server
    });
    // A denied or failed call proves nothing was actually read, so only a
    // call agy itself reports as `ok` can ever surface a skill_used event.
    if (evidence.status === "ok") {
      const toolInfoArgs = structured(toolInfo?.args);
      const toolInputArgs = structured(update.tool_input);
      const args: JsonObject =
        (toolInfoArgs !== null && !Array.isArray(toolInfoArgs)
          ? toolInfoArgs
          : null) ??
        (toolInputArgs !== null && !Array.isArray(toolInputArgs)
          ? toolInputArgs
          : null) ??
        {};
      reportSkillReadIfMatched({
        agentEvents,
        seenSkills,
        toolName: tool,
        args,
        callId
      });
    }
  };
  // agy auto-denies a tool whose permission the run was not granted and says
  // so only on stderr, which this bridge already parses into the failure it
  // raises. That is the one case where the turn knows a tool the model asked
  // for was never allowed to run, and reporting it is what stops the
  // dashboard reading a permission gap as "the workspace never used it".
  const reportPermissionDenial = (error: unknown) => {
    if (!agentEvents) return;
    const failure = agyFailure(error);
    if (failure.failureCode !== "AGY_PERMISSION_DENIED") return;
    // `reportToolUnavailable` drops a nameless tool anyway; returning here
    // keeps that same outcome without inventing a tool name for the report.
    const failureTool = failure.failureTool;
    if (!failureTool) return;
    const server = antigravityToolServer(null, failureTool);
    void agentEvents.reportToolUnavailable({
      tool: failureTool,
      reason: "permission_denied",
      server
    });
  };
  return { observeToolStep, reportPermissionDenial };
}

/**
 * Tracks the subagents one agy turn dispatches, so each is reported once when it
 * starts and once when it ends.
 *
 * Extracted from the request handler because the lifecycle below is subtle and
 * was wrong: it treated the dispatch step's completion as the child's, which is
 * exactly the kind of mistake that needs a test able to reach it.
 *
 * `openSpawnCount()` is also the source of truth for pending children outside
 * this module: the request handler folds it into its delegation state so a
 * disconnect or heartbeat decision made while children are still open does
 * not depend on the dispatch step (which closes on `DONE`, long before its
 * children do) being the only signal of delegation in flight.
 */
interface TrackedSpawn {
  readonly tool: string;
  readonly children: SpawnedChild[];
  readonly startedAt: number;
}

interface SpawnTrackerState {
  readonly agentEvents: AgentReporter | null;
  readonly reportedSpawns: Set<number>;
  readonly openSpawns: Map<number | string, TrackedSpawn>;
}

function createSpawnTracker(agentEvents: AgentReporter | null) {
  const state: SpawnTrackerState = {
    agentEvents,
    reportedSpawns: new Set<number>(),
    openSpawns: new Map()
  };
  const observeSpawnStep = (update: JsonValue) => {
    reportSpawns(state, update);
    reportSpawnResults(state, update);
  };
  const flushSpawns = (outcome: string) => flushOpenSpawns(state, outcome);
  return {
    observeSpawnStep,
    flushSpawns,
    openSpawnCount: () => state.openSpawns.size
  };
}

// Count a spawn once, when its dispatch step opens, and record the pending
// child independently of whether telemetry was authorized for this turn.
function reportSpawns(state: SpawnTrackerState, update: JsonValue): void {
  const { agentEvents, reportedSpawns, openSpawns } = state;
  if (!isStepUpdate(update)) return;
  const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
  const toolName = String(update.tool_name ?? toolInfo?.name ?? "");
  if (!isSpawnToolName(agentEvents, toolName)) return;
  if (String(update.state ?? "").toUpperCase() !== "ACTIVE") return;
  const stepIndex = stepIndexOf(update);
  if (stepIndex !== null) {
    if (reportedSpawns.has(stepIndex)) return;
    reportedSpawns.add(stepIndex);
  }
  if (LOG_SPAWN_STEPS)
    writeErrorLine(`agy spawn step ${JSON.stringify(shapeOnly(update))}`);
  const children = spawnedChildren(update);
  writeErrorLine(
    `agy spawn tool=${toolName} children=${children.length} roles=${children.map(({ role }: SpawnedChild) => role ?? "unattributed").join(",")}`
  );
  const key: number | string = stepIndex ?? children[0]?.id ?? "anonymous";
  openSpawns.set(key, {
    tool: toolName,
    children,
    startedAt: Date.now()
  });
  // `invoke_subagent` is fire-and-forget: its DONE step closes the dispatch,
  // not the child. Pending state therefore remains open until the parent turn.
  if (agentEvents) void agentEvents.reportSpawns({ tool: toolName, children });
  if (typeof agentEvents?.reportActivity === "function") {
    void agentEvents.reportActivity({
      state: "subagent_wait",
      childIds: children.map((child) => child.id)
    });
  }
}

// Close one pending child group once; deleting first makes duplicate terminal
// events and a later parent flush harmless.
function closeSpawn(
  state: SpawnTrackerState,
  key: number | string,
  outcome: string
): void {
  const { agentEvents, openSpawns } = state;
  const open = openSpawns.get(key);
  if (!open) return;
  openSpawns.delete(key);
  if (agentEvents)
    void agentEvents.reportResults({
      tool: open.tool,
      children: open.children,
      outcome,
      durationMs: Date.now() - open.startedAt
    });
  if (
    openSpawns.size === 0 &&
    typeof agentEvents?.reportActivity === "function"
  ) {
    void agentEvents.reportActivity({ state: "resumed" });
  }
}

// Only failed hand-offs close immediately; DONE settles dispatch, not the child.
function reportSpawnResults(state: SpawnTrackerState, update: JsonValue): void {
  const { agentEvents } = state;
  if (!isStepUpdate(update)) return;
  const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
  const toolName = String(update.tool_name ?? toolInfo?.name ?? "");
  if (!isSpawnToolName(agentEvents, toolName)) return;
  const status = String(update.state ?? "").toUpperCase();
  const stepIndex = stepIndexOf(update);
  if (!status || status === "ACTIVE" || status === "DONE" || stepIndex === null)
    return;
  closeSpawn(state, stepIndex, "failure");
}

// The parent turn bounds any child whose completion is not observable in agy's
// stream, so flush every still-open child with the parent's outcome.
function flushOpenSpawns(state: SpawnTrackerState, outcome: string): void {
  for (const key of state.openSpawns.keys()) closeSpawn(state, key, outcome);
}

/**
 * Update a delegation tracker from one step_update event and report whether
 * the transition started, ended, or changed nothing. A pure helper so tests
 * can drive it without spinning up the request handler.
 *
 * The caller owns the `delegation` state object -- { activeTool, activeStep,
 * activatedAt } -- and this helper mutates it in place. The `isSpawnTool`
 * callback mirrors the AgentEventReporter.isSpawnTool contract: true for
 * tools that spawn sub-agents, false for everything else.
 *
 * Returns one of:
 *   { kind: "entered", tool }
 *   { kind: "exited", tool }
 *   { kind: "unchanged" }
 */
function updateDelegationState(
  delegation: DelegationState,
  update: JsonValue,
  isSpawnTool: (name: string) => boolean
): DelegationTransition {
  if (!delegation || typeof delegation !== "object")
    return { kind: "unchanged" };
  // Without a spawn-tools callback we cannot classify the event, and a wrong
  // classification here would either miss the kill-on-close path or trigger
  // it falsely. Leave the tracker untouched; the bridge always passes a
  // callback in production but this keeps the helper safe under partial mocks.
  if (typeof isSpawnTool !== "function") return { kind: "unchanged" };
  if (!isStepUpdate(update)) return { kind: "unchanged" };
  const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
  const stepToolName = String(update.tool_name ?? toolInfo?.name ?? "");
  const stepState = String(update.state ?? "").toUpperCase();
  const stepIndex = stepIndexOf(update);
  const isDelegator = Boolean(isSpawnTool(stepToolName));
  if (isDelegator && stepState === "ACTIVE") {
    delegation.activeTool = stepToolName;
    delegation.activeStep = stepIndex;
    delegation.activatedAt = Date.now();
    return { kind: "entered", tool: stepToolName };
  }
  // Clear on a terminal state for the *same* step the delegator is running
  // on. A non-delegator event for a different step (the wrap-up that arrives
  // after a spawn step's DONE, or a fresh tool call) must NOT clear the
  // tracker -- the close handler would still see us as delegating and the
  // heartbeat would still be ticking, and that is exactly what we want.
  const isTerminal =
    stepState === "DONE" ||
    stepState === "ERROR" ||
    stepState === "FAILED" ||
    stepState === "CANCELLED";
  if (isTerminal && delegation.activeStep === stepIndex) {
    const previous = delegation.activeTool;
    delegation.activeTool = null;
    delegation.activeStep = null;
    delegation.activatedAt = 0;
    return { kind: "exited", tool: previous };
  }
  return { kind: "unchanged" };
}

function isCommandStep(update: JsonValue): boolean {
  if (!isStepUpdate(update)) return false;
  const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
  const stepType = String(update.step_type ?? "").toLowerCase();
  if (stepType === "command") return true;
  const tool = String(update.tool_name ?? toolInfo?.name ?? "").toLowerCase();
  return (
    tool === "run_command" ||
    tool === "exec_command" ||
    tool === "execute_command" ||
    tool === "bash"
  );
}

function isWaitStep(update: JsonValue): boolean {
  if (!isStepUpdate(update)) return false;
  const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
  const stepType = String(update.step_type ?? "").toLowerCase();
  if (stepType === "wait") return true;
  const tool = String(update.tool_name ?? toolInfo?.name ?? "").toLowerCase();
  return (
    tool === "ask_question" || tool === "schedule" || tool === "manage_task"
  );
}

/**
 * True while agy is either inside a delegator step, still has children the
 * spawn tracker has not closed, has active commands running, or has active waits.
 * `invoke_subagent` hands work to children and reports its own step `DONE`
 * immediately -- the dispatch finished, not the work -- so `activeTool` alone
 * goes false long before the children do. Active commands and waits keep the turn
 * live so disconnect protection and heartbeats protect in-flight execution.
 */
function isDelegationActive(delegation: DelegationState): boolean {
  if (!delegation || typeof delegation !== "object") return false;
  if (delegation.activeTool) return true;
  if (
    Number(delegation.activeCommands) > 0 ||
    Boolean(delegation.activeCommand)
  )
    return true;
  if (Number(delegation.activeWaits) > 0 || Boolean(delegation.activeWait))
    return true;
  return Number(delegation.pendingChildren) > 0;
}

/** Why a close/error handler left agy running, for the turn log. */
function delegationDetail(decision: CloseDecision): string {
  if (decision.tool) return `during ${decision.tool}`;
  if (decision.pendingChildren > 0)
    return `while ${decision.pendingChildren} delegated child(ren) were still running`;
  if (decision.activeCommands > 0)
    return `while ${decision.activeCommands} active command(s) were still running`;
  if (decision.activeWaits > 0)
    return `while ${decision.activeWaits} active wait(s) were pending`;
  return "while active commands or waits were still running";
}

/**
 * Decide what a response.on("close") / response.on("error") handler should
 * do given the current delegation tracker. Pure helper so the close handler
 * and tests share one decision point.
 *
 * `kill: false` while a delegator step is active, children it dispatched are
 * still open, active commands are running, or active waits are pending, so a
 * turn mid-flight is not mistaken for an ordinary idle turn.
 */
function decideCloseOnDelegation(delegation: DelegationState): CloseDecision {
  if (isDelegationActive(delegation)) {
    const activeCommands =
      Number(delegation?.activeCommands) || (delegation?.activeCommand ? 1 : 0);
    const activeWaits =
      Number(delegation?.activeWaits) || (delegation?.activeWait ? 1 : 0);
    return {
      kill: false,
      reason: "client_disconnected",
      tool: delegation?.activeTool ?? delegation?.activeCommand ?? null,
      pendingChildren: Number(delegation?.pendingChildren) || 0,
      activeCommands,
      activeWaits
    };
  }
  return {
    kill: true,
    reason: "provider_interrupted",
    tool: null,
    pendingChildren: 0,
    activeCommands: 0,
    activeWaits: 0
  };
}
function modelMetadata() {
  return {
    slug: DEFAULT_MODEL,
    apply_patch_tool_type: "freeform",
    base_instructions: "You are a bounded external-provider Codex agent.",
    display_name: "Antigravity CLI subscription",
    description:
      "Antigravity CLI subscription through the local Responses adapter.",
    default_reasoning_level: DEFAULT_EFFORT,
    default_reasoning_summary: "none",
    default_verbosity: "low",
    supported_reasoning_levels: ["low", "medium", "high"].map((effort) => ({
      effort,
      description: `Antigravity ${effort} reasoning`
    })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    model_messages: {
      instructions_template: "You are a bounded external-provider Codex agent."
    },
    input_modalities: ["text"],
    experimental_supported_tools: ["web_search", "web_fetch"],
    support_verbosity: false,
    supports_parallel_tool_calls: false,
    supports_search_tool: true,
    tool_mode: "code_mode_only",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    use_responses_lite: true,
    multi_agent_version: "v1",
    node_repl_auto_review_required: false,
    node_repl_disabled: true,
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_skills_usage_instructions: false,
    comp_hash: "local-antigravity-bridge",
    effective_context_window_percent: 95
  };
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
    .map((tool) =>
      typeof tool?.name === "string" ? tool.name : tool?.function?.name
    )
    .filter((name) => typeof name === "string");
}

/** Record what Codex offered and what the router said about this turn. */
const ROUTING_HEADER_PATTERN = /^x-(autodev|codex)-/i;

function logInboundRequest(
  payload: JsonRecord,
  headers: NodeJS.Dict<string | string[]>
) {
  if (!LOG_TOOLS) return;
  const routing = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) =>
      ROUTING_HEADER_PATTERN.test(key)
    )
  );
  writeErrorLine(
    `[stage0] tool_names=${JSON.stringify(toolNames(payload.tools).sort())}`
  );
  writeErrorLine(`[stage0] routing_headers=${JSON.stringify(routing)}`);
  const tools = payload.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (
        isJsonRecord(tool) &&
        typeof tool.name === "string" &&
        tool.name.startsWith("multi_agent_v1")
      ) {
        writeErrorLine(`[stage0] spawn_tool=${JSON.stringify(tool)}`);
      }
    }
  }
  const input = payload.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (
        isJsonRecord(item) &&
        (item.type === "function_call" || item.type === "function_call_output")
      ) {
        writeErrorLine(
          `[stage0] input_item=${JSON.stringify(item).slice(0, 2000)}`
        );
      }
    }
  }
}

function resolveModel(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_MODEL;
  const model = value.trim();
  if (
    !model ||
    model === "antigravity-subscription" ||
    !MODEL_PATTERN.test(model)
  )
    return DEFAULT_MODEL;
  return model;
}

/** The effort a model id encodes, or null when it encodes none. */
function modelEffort(model: unknown): string | null {
  return typeof model === "string"
    ? (MODEL_EFFORT_SUFFIX.exec(model)?.[1] ?? null)
    : null;
}

function resolveEffort(request: JsonValue): string {
  const record = isJsonRecord(request) ? request : null;
  const reasoning = isJsonRecord(record?.reasoning) ? record?.reasoning : null;
  const value = reasoning
    ? reasoning.effort
    : (record?.model_reasoning_effort ?? record?.reasoning_effort);
  if (typeof value !== "string") return DEFAULT_EFFORT;
  const effort = value.trim().toLowerCase();
  if (EFFORTS.has(effort)) return effort;
  if (effort === "xhigh" || effort === "max") return "high";
  return DEFAULT_EFFORT;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((part) =>
      typeof part === "object"
        ? (part.text ?? JSON.stringify(part))
        : String(part)
    )
    .join("\n");
}

function promptFromInput(value: unknown, instructions?: unknown): string {
  if (typeof value === "string") return `${instructions}\n\n${value}`;
  if (!Array.isArray(value))
    return `${instructions}\n\n${JSON.stringify(value)}`;
  const userItems = value.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      (item.role === "user" ||
        (item.type === "message" && item.role === "user"))
  );
  const items =
    userItems.length > 0
      ? userItems
      : value.filter(
          (item) =>
            item &&
            typeof item === "object" &&
            !["developer", "system"].includes(item.role)
        );
  const task = items
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return JSON.stringify(item);
      return contentText(item.content ?? item.text ?? "");
    })
    .join("\n\n");
  return `${instructions}\n\n${task}`;
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

/**
 * Preserve the provider's terminal status and stderr when agy returns no
 * answer. A successful process with an empty `response` is not a successful
 * model turn, and reducing either case to "completed without a response
 * message" makes an intermittent provider failure impossible to diagnose.
 * Stderr is bounded because agy can echo verbose tool diagnostics.
 */
const AGY_PERMISSION_FAILURE_PATTERN =
  /tool required the ["']([^"']+)["'] permission[^\n]*auto-denied/i;

function agyPermissionFailure(stderr = "") {
  const text = String(stderr ?? "");
  const match = text.match(AGY_PERMISSION_FAILURE_PATTERN);
  if (!match) return {};
  return {
    failureCode: "AGY_PERMISSION_DENIED",
    failurePhase: "tool_permission",
    failureTool: match[1]
  };
}

function agyProviderFailureDiagnostic(
  error: unknown
): ProviderFailureDiagnostic | null {
  const failure = agyFailure(error);
  if (failure.failureCode !== "AGY_PERMISSION_DENIED") return null;
  const tool = failure.failureTool;
  return {
    code: "AGY_PERMISSION_DENIED",
    phase: "tool_permission",
    ...(typeof tool === "string" && SAFE_PROVIDER_TOOL_NAME.test(tool)
      ? { tool }
      : {})
  };
}

function agyFailureMessage({
  status = null,
  error = null,
  stderr = "",
  code = null,
  signal = null
}: {
  status?: string | null;
  error?: unknown;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
} = {}): string {
  const details: string[] = [];
  if (status) details.push(`status ${status}`);
  if (error) details.push(String(error));
  if (signal) details.push(`signal ${signal}`);
  else if (code !== null && code !== undefined)
    details.push(`exit code ${code}`);
  const stderrTail = String(stderr ?? "")
    .trim()
    .slice(-2000);
  if (stderrTail) details.push(`stderr: ${stderrTail}`);
  return details.join("; ") || "agy returned no diagnostic details";
}

/**
 * The Responses API payload this bridge returns. `output` holds JSON records
 * this module builds alongside typed items from sibling modules (the Codex
 * `exec` tool call), so it is typed at the serialization boundary.
 */
type ResponsePayload = {
  id: string;
  object: "response";
  created_at: number;
  model: JsonValue;
  status: string;
  output: object[];
  output_text: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
};

function responsePayload(
  model: JsonValue,
  text: string,
  result: JsonValue,
  responseId: string = `resp_${randomBytes(12).toString("hex")}`,
  itemId: string = `msg_${randomBytes(10).toString("hex")}`,
  output: object[] | null = null,
  status = "completed"
): ResponsePayload {
  const resultRecord = isJsonRecord(result) ? result : null;
  const usage = isJsonRecord(resultRecord?.usage) ? resultRecord.usage : {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const message = responseMessageItem(text, itemId);
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output: output ?? [message],
    output_text: text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  };
}

const EVENT_OUTPUT_ITEM_ADDED = "response.output_item.added";
const EVENT_OUTPUT_ITEM_DONE = "response.output_item.done";
const EVENT_REASONING_SUMMARY_TEXT_DELTA =
  "response.reasoning_summary_text.delta";

function sseLine(eventName: string, body: object): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`;
}

const ANTIGRAVITY_WEB_RESEARCH_TOOLS = new Set([
  "search_web",
  "read_url_content"
]);

function activityText(event: AgyStreamEvent): string {
  if (event.event !== "step_update") return "";
  if (!isStepUpdate(event.step_update)) return "";
  const update = event.step_update;
  const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
  const state = String(update.state ?? "").toUpperCase();
  const stepType = String(update.step_type ?? "").toLowerCase();
  const toolName = String(update.tool_name ?? toolInfo?.name ?? "tool");

  switch (stepType) {
    case "tool": {
      return toolActivityText(toolName, state);
    }
    case "agent_response": {
      return agentResponseActivityText(state);
    }
    case "checkpoint": {
      return state === "DONE" ? "Antigravity reached a checkpoint." : "";
    }
  }
  return "";
}

function toolActivityText(toolName: string, state: string): string {
  const specific = specificToolActivityText(toolName, state);
  if (specific) return specific;
  if (state === "ACTIVE") return `Antigravity is using ${toolName}.`;
  if (state === "DONE") return `Antigravity finished ${toolName}.`;
  return `Antigravity tool ${toolName}: ${state.toLowerCase()}.`;
}

function specificToolActivityText(
  toolName: string,
  state: string
): string | null {
  switch (toolName) {
    case "search_web": {
      if (state === "ACTIVE") return "Antigravity is searching the web.";
      if (state === "DONE") return "Antigravity finished searching the web.";
      return null;
    }
    case "read_url_content": {
      if (state === "ACTIVE") return "Antigravity is reading web URL content.";
      if (state === "DONE")
        return "Antigravity finished reading web URL content.";
      return null;
    }
    default: {
      return null;
    }
  }
}

function agentResponseActivityText(state: string): string {
  if (state === "ACTIVE") return "Antigravity is processing the next step.";
  if (state === "DONE") return "Antigravity completed a processing step.";
  return "";
}

// Delegation requests the shim collects while a turn is in flight. See
// runtime/src/agents/bridge-spawn-session.ts for why the session key matters.
const spawnSessions = new SpawnSessionRegistry();

interface IsolatedHomeOptions {
  originalHome?: string;
  codexHome?: string;
  cwd?: string;
  sandboxMode?: "read-only" | "workspace-write" | null;
  isolatedHome?: string;
}

const GEMINI_DIRECTORY = ".gemini";
const GEMINI_CONFIG_DIRECTORY = "config";
const AGY_CLI_DIRECTORY = "antigravity-cli";
const MCP_CONFIG_FILENAME = "mcp_config.json";
const SETTINGS_FILENAME = "settings.json";

interface IsolatedHomeResult {
  isolatedHome: string;
  mcpConfig: AntigravityMcpConfig;
  settings: AntigravitySettings;
  cleanup: () => void;
}

/** The launch definition of every AutoDev MCP server, rendered by the installer from `.rulesync/mcp.jsonc`. */
function bridgeMcpCatalogue(codexHome?: string): Record<string, JsonRecord> {
  const basePath =
    codexHome ?? process.env.CODEX_HOME ?? pathApi.join(homedir(), ".codex");
  const path = pathApi.join(basePath, "provider-runtime", "mcp-servers.json");
  try {
    const raw = readFileSync(path, "utf8");
    const catalogue = JSON.parse(raw);
    if (catalogue && typeof catalogue === "object" && !Array.isArray(catalogue))
      return catalogue;
  } catch {
    /* reported below */
  }
  throw new Error(
    `bridge MCP catalogue is missing or invalid: ${path}; rerun scripts/install.sh`
  );
}

/**
 * Builds the invocation-scoped Antigravity MCP config containing only the current
 * role contract's declared MCP servers (from the bridge catalogue), plus the
 * autodev_spawn shim only for an authorized orchestrator turn with an active spawn session.
 * Leaf roles never receive the spawn shim.
 */
function bridgeMcpEntry(
  name: string,
  server: JsonRecord,
  tools: unknown
): AntigravityMcpServerConfig {
  const remoteUrl = server.serverUrl ?? server.url;
  if (remoteUrl !== undefined) {
    if (Array.isArray(tools))
      throw new Error(
        `MCP server ${name} has a per-tool role allowlist but uses a remote transport that Antigravity cannot filter`
      );
    if (typeof remoteUrl !== "string" || !remoteUrl.trim())
      throw new Error(`MCP server ${name} has an invalid remote URL`);
    return bridgeHttpMcpEntry(name, server, remoteUrl);
  }
  return bridgeStdioMcpEntry(name, server, tools);
}

function bridgeHttpMcpEntry(
  name: string,
  server: JsonRecord,
  remoteUrl: string
): AntigravityMcpServerConfig {
  const entry: JsonRecord = { serverUrl: remoteUrl };
  if (server.bearer_token_env_var !== undefined) {
    if (
      typeof server.bearer_token_env_var !== "string" ||
      !server.bearer_token_env_var.trim()
    )
      throw new Error(
        `MCP server ${name} has an invalid bearer-token variable`
      );
    entry.bearer_token_env_var = server.bearer_token_env_var;
  }
  const headers = server.http_headers ?? server.headers;
  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers))
      throw new Error(`MCP server ${name} has invalid HTTP headers`);
    entry.headers = { ...headers };
  }
  return entry;
}

function bridgeStdioMcpEntry(
  name: string,
  server: JsonRecord,
  tools: unknown
): AntigravityMcpServerConfig {
  if (typeof server.command !== "string" || !server.command.trim())
    throw new Error(`MCP server ${name} has no supported launch definition`);
  if (
    server.args !== undefined &&
    (!Array.isArray(server.args) ||
      !server.args.every((arg: unknown) => typeof arg === "string"))
  )
    throw new Error(`MCP server ${name} has invalid arguments`);
  const serverArgs: string[] = Array.isArray(server.args)
    ? [...server.args]
    : [];
  const entry: JsonRecord = {};
  if (server.cwd !== undefined) entry.cwd = server.cwd;
  if (server.env !== undefined) {
    if (!isJsonRecord(server.env))
      throw new Error(`MCP server ${name} has an invalid environment`);
    entry.env = { ...server.env };
  }
  if (tools === undefined) {
    entry.command = server.command;
    entry.args = serverArgs;
    return entry;
  }
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))
    throw new Error(`MCP server ${name} has an invalid role tool allowlist`);
  const filterScript = resolveRuntimeSourcePath(
    REPO_ROOT,
    "mcp/tool-filter.ts"
  );
  if (!existsSync(filterScript))
    throw new Error(
      `Antigravity role MCP tool filter is missing: ${filterScript}`
    );
  entry.command = process.execPath;
  entry.args = [
    filterScript,
    server.command,
    JSON.stringify(serverArgs),
    JSON.stringify(tools)
  ];
  return entry;
}

function bridgeSpawnMcpEntry(options?: IsolatedHomeOptions): JsonRecord {
  const codexHome =
    options?.codexHome ??
    process.env.CODEX_HOME ??
    pathApi.join(
      options?.originalHome ?? process.env.HOME ?? homedir(),
      ".codex"
    );
  const repoShim = resolveRuntimeSourcePath(REPO_ROOT, "mcp/spawn-shim.ts");
  const codexShim = pathApi.join(codexHome, "src", "mcp", "spawn-shim.ts");
  const targetShim = existsSync(repoShim) ? repoShim : codexShim;
  return {
    command: "bash",
    args: ["-lc", `exec node "${targetShim}"`]
  };
}

function buildInvocationMcpConfig(
  agentRole: string | null,
  spawnSession: string | null = null,
  options?: IsolatedHomeOptions
): AntigravityMcpConfig {
  const contract = antigravityRoleContract(agentRole);
  const catalogue = bridgeMcpCatalogue(options?.codexHome);
  const mcpServers: Record<string, AntigravityMcpServerConfig> = {};
  for (const name of contract.mcp ?? []) {
    if (name === "autodev_spawn") continue;
    const server = catalogue[name];
    if (!server || typeof server !== "object" || Array.isArray(server))
      throw new Error(
        `MCP server ${name} granted to role ${agentRole ?? "default"} is not in the bridge MCP catalogue; rerun scripts/install.sh`
      );
    mcpServers[name] = bridgeMcpEntry(name, server, contract.mcpTools?.[name]);
  }
  if (isOrchestratorRole(agentRole) && spawnSession)
    mcpServers.autodev_spawn = bridgeSpawnMcpEntry(options);
  return { mcpServers };
}

function invocationMcpPermissionGrants(
  contract: AntigravityRoleContract,
  mcpConfig: AntigravityMcpConfig
): string[] {
  const grants: string[] = [];
  for (const server of Object.keys(mcpConfig.mcpServers ?? {})) {
    const tools = contract.mcpTools?.[server];
    if (Array.isArray(tools)) {
      for (const tool of tools) grants.push(`mcp(${server}/${tool})`);
    } else {
      grants.push(`mcp(${server})`);
    }
  }
  return grants;
}

function isReadOnlyRole(
  agentRole: string | null = null,
  sandboxMode: "read-only" | "workspace-write" | null = null
): boolean {
  return (
    sandboxMode === "read-only" ||
    (sandboxMode !== "workspace-write" &&
      Boolean(antigravityRoleContract(agentRole).readOnly))
  );
}

function buildReadOnlyInvocationSettings({
  userSettings,
  userPermissions,
  existingAllow,
  existingDeny,
  mcpGrants,
  cwd,
  originalHome,
  codexHome,
  isolatedHome
}: {
  userSettings: JsonRecord;
  userPermissions: JsonRecord;
  existingAllow: JsonArray;
  existingDeny: JsonArray;
  mcpGrants: string[];
  cwd: string | undefined;
  originalHome?: string | undefined;
  codexHome?: string | undefined;
  isolatedHome?: string | undefined;
}): AntigravitySettings {
  if (!cwd || !pathApi.isAbsolute(cwd))
    throw new Error(
      "Antigravity read-only invocation requires a validated absolute workspace"
    );

  const home = originalHome ?? process.env.HOME ?? homedir();
  const resolvedCodexHome =
    codexHome ?? process.env.CODEX_HOME ?? pathApi.join(home, ".codex");

  const workspaceRoot = pathApi.resolve(cwd);
  const workspaceReal = existsSync(workspaceRoot)
    ? realpathSync(workspaceRoot)
    : workspaceRoot;
  const workspaceReadGrants = [
    `read_file(${workspaceRoot})`,
    ...(workspaceReal !== workspaceRoot ? [`read_file(${workspaceReal})`] : [])
  ];

  const agentRoot = pathApi.join(home, ".agents");
  const agentReal = existsSync(agentRoot) ? realpathSync(agentRoot) : agentRoot;
  const codexReal = existsSync(resolvedCodexHome)
    ? realpathSync(resolvedCodexHome)
    : resolvedCodexHome;
  const geminiRoot = pathApi.join(home, ".gemini");
  const geminiReal = existsSync(geminiRoot)
    ? realpathSync(geminiRoot)
    : geminiRoot;

  const sharedReadGrants = [
    `read_file(${agentRoot})`,
    ...(agentReal !== agentRoot ? [`read_file(${agentReal})`] : []),
    `read_file(${resolvedCodexHome})`,
    ...(codexReal !== resolvedCodexHome ? [`read_file(${codexReal})`] : []),
    `read_file(${geminiRoot})`,
    ...(geminiReal !== geminiRoot ? [`read_file(${geminiReal})`] : [])
  ];

  if (isolatedHome) {
    const isolatedReal = existsSync(isolatedHome)
      ? realpathSync(isolatedHome)
      : isolatedHome;
    sharedReadGrants.push(`read_file(${isolatedHome})`);
    if (isolatedReal !== isolatedHome) {
      sharedReadGrants.push(`read_file(${isolatedReal})`);
    }
  }

  const systemTmp = tmpdir();
  const systemTmpReal = existsSync(systemTmp)
    ? realpathSync(systemTmp)
    : systemTmp;
  sharedReadGrants.push(`read_file(${systemTmp})`);
  if (systemTmpReal !== systemTmp) {
    sharedReadGrants.push(`read_file(${systemTmpReal})`);
  }

  const urlReadGrants = existingAllow.filter(
    (entry): entry is string =>
      typeof entry === "string" &&
      READ_URL_PERMISSION_PATTERN.test(entry.trim())
  );

  return {
    ...userSettings,
    permissions: {
      ...userPermissions,
      allow: Array.from(
        new Set([
          ...urlReadGrants,
          ...workspaceReadGrants,
          ...sharedReadGrants,
          ...mcpGrants
        ])
      ),
      deny: existingDeny
    }
  };
}

/**
 * Builds invocation-scoped settings with MCP permissions limited to the role
 * contract. Write-capable roles retain user non-MCP permissions; read-only
 * roles receive workspace-scoped and shared agent/codex file reads plus user-configured URL reads.
 */
function buildInvocationSettings(
  agentRole: string | null,
  mcpConfig: AntigravityMcpConfig,
  originalHome: string = process.env.HOME ?? homedir(),
  options?: IsolatedHomeOptions
): AntigravitySettings {
  const contract = antigravityRoleContract(agentRole);
  const settingsPath = pathApi.join(
    originalHome,
    GEMINI_DIRECTORY,
    AGY_CLI_DIRECTORY,
    SETTINGS_FILENAME
  );
  let userSettings: JsonRecord = {};
  if (existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Antigravity settings are invalid at ${settingsPath}; refusing to drop user permissions`,
        { cause: error }
      );
    }
    if (!isJsonRecord(parsed))
      throw new Error(
        `Antigravity settings must be a JSON object at ${settingsPath}`
      );
    userSettings = parsed;
  }

  const permissions = userSettings.permissions;
  if (permissions !== undefined && !isJsonRecord(permissions))
    throw new Error(
      `Antigravity permissions must be an object at ${settingsPath}`
    );
  const userPermissions: JsonRecord = permissions ?? {};
  if (
    userPermissions.allow !== undefined &&
    !Array.isArray(userPermissions.allow)
  )
    throw new Error(
      `Antigravity permissions.allow must be an array at ${settingsPath}`
    );
  if (
    userPermissions.deny !== undefined &&
    !Array.isArray(userPermissions.deny)
  )
    throw new Error(
      `Antigravity permissions.deny must be an array at ${settingsPath}`
    );

  const existingAllow: JsonArray = Array.isArray(userPermissions.allow)
    ? [...userPermissions.allow]
    : [];
  const nonMcpAllow = existingAllow.filter(
    (entry) => typeof entry !== "string" || !entry.startsWith("mcp(")
  );
  const existingDeny: JsonArray = Array.isArray(userPermissions.deny)
    ? [...userPermissions.deny]
    : [];

  const mcpGrants = invocationMcpPermissionGrants(contract, mcpConfig);

  if (isReadOnlyRole(agentRole, options?.sandboxMode))
    return buildReadOnlyInvocationSettings({
      userSettings,
      userPermissions,
      existingAllow,
      existingDeny,
      mcpGrants,
      cwd: options?.cwd,
      originalHome: options?.originalHome ?? originalHome,
      codexHome: options?.codexHome,
      isolatedHome: options?.isolatedHome
    });

  return {
    ...userSettings,
    permissions: {
      ...userPermissions,
      allow: [...nonMcpAllow, ...mcpGrants],
      deny: existingDeny
    }
  };
}

const activeIsolatedHomeCleanups = new Set<() => void>();
const cleanupIsolatedHomesAtExit = () => {
  for (const cleanup of activeIsolatedHomeCleanups) cleanup();
};

function symlinkGeminiDirectory(
  source: string,
  target: string,
  excludedFile: string
): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) {
    if (name !== excludedFile)
      symlinkSync(pathApi.join(source, name), pathApi.join(target, name));
  }
}

function symlinkGeminiState(source: string, target: string): void {
  for (const name of readdirSync(source)) {
    const sourcePath = pathApi.join(source, name);
    if (name === GEMINI_CONFIG_DIRECTORY) {
      symlinkGeminiDirectory(
        sourcePath,
        pathApi.join(target, GEMINI_CONFIG_DIRECTORY),
        MCP_CONFIG_FILENAME
      );
    } else if (name === AGY_CLI_DIRECTORY) {
      symlinkGeminiDirectory(
        sourcePath,
        pathApi.join(target, AGY_CLI_DIRECTORY),
        SETTINGS_FILENAME
      );
    } else {
      symlinkSync(sourcePath, pathApi.join(target, name));
    }
  }
}

/** Creates an invocation-scoped home while retaining the user's authenticated state. */
function createIsolatedAntigravityHome(
  agentRole: string | null,
  spawnSession: string | null = null,
  options?: IsolatedHomeOptions
): IsolatedHomeResult {
  const originalHome = options?.originalHome ?? process.env.HOME ?? homedir();
  const origGemini = pathApi.join(originalHome, GEMINI_DIRECTORY);
  if (!existsSync(origGemini))
    throw new Error(
      `Antigravity user state is missing at ${origGemini}; sign in with agy before using the bridge`
    );

  let tempHome: string | null = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeIsolatedHomeCleanups.delete(cleanup);
    if (activeIsolatedHomeCleanups.size === 0)
      process.removeListener("exit", cleanupIsolatedHomesAtExit);
    if (tempHome) {
      try {
        rmSync(tempHome, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  };

  try {
    tempHome = mkdtempSync(pathApi.join(tmpdir(), "autodev-agy-home-"));
    chmodSync(tempHome, 0o700);

    const mcpConfig = buildInvocationMcpConfig(
      agentRole,
      spawnSession,
      options
    );
    const settings = buildInvocationSettings(
      agentRole,
      mcpConfig,
      originalHome,
      { ...options, isolatedHome: tempHome }
    );
    const geminiDir = pathApi.join(tempHome, GEMINI_DIRECTORY);
    mkdirSync(geminiDir, { mode: 0o700 });

    symlinkGeminiState(origGemini, geminiDir);

    const configDir = pathApi.join(geminiDir, GEMINI_CONFIG_DIRECTORY);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      pathApi.join(configDir, MCP_CONFIG_FILENAME),
      `${JSON.stringify(mcpConfig, null, 2)}\n`,
      { mode: 0o600 }
    );

    const cliDir = pathApi.join(geminiDir, AGY_CLI_DIRECTORY);
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      pathApi.join(cliDir, SETTINGS_FILENAME),
      `${JSON.stringify(settings, null, 2)}\n`,
      { mode: 0o600 }
    );

    if (process.platform === "darwin") {
      const origKeychains = pathApi.join(originalHome, "Library", "Keychains");
      if (existsSync(origKeychains)) {
        const libDir = pathApi.join(tempHome, "Library");
        mkdirSync(libDir, { mode: 0o700 });
        symlinkSync(origKeychains, pathApi.join(libDir, "Keychains"));
      }
    }

    if (activeIsolatedHomeCleanups.size === 0)
      process.once("exit", cleanupIsolatedHomesAtExit);
    activeIsolatedHomeCleanups.add(cleanup);

    return { isolatedHome: tempHome, mcpConfig, settings, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * The environment an agy child runs in.
 *
 * agy resolves its MCP servers and permissions from $HOME/.gemini.
 * The bridge constructs an invocation-scoped temporary HOME containing only
 * the current role's contract MCP servers and permissions.
 */
function agyEnvironment(
  spawnSession: string | null,
  isolatedHome: string | null = null
): NodeJS.ProcessEnv {
  const codexHome = process.env.CODEX_HOME ?? pathApi.join(homedir(), ".codex");
  return {
    ...process.env,
    ...(isolatedHome ? { HOME: isolatedHome } : {}),
    CODEX_HOME: codexHome,
    AUTODEV_BRIDGE_URL: `http://${HOST}:${PORT}`,
    AUTODEV_BRIDGE_TOKEN: AUTH_TOKEN,
    AUTODEV_SPAWN_SESSION: spawnSession ?? ""
  };
}

function agyArgs(
  prompt: string,
  model: string,
  effort: string,
  agentRole: string | null = null,
  sandboxMode: "read-only" | "workspace-write" | null = null
): string[] {
  // The router forwards the declared sandbox via x-autodev-sandbox-mode. We
  // trust that header over roleContract(agentRole).readOnly because the
  // header is the authoritative wire signal for this turn, and falls back
  // to the contract for backwards compatibility with bridges that have not
  // been updated to send it yet.
  const readOnly = isReadOnlyRole(agentRole, sandboxMode);
  // Headless print mode (-p) cannot prompt interactively for tool approvals.
  // AGY_SKIP_PERMISSIONS ("true" by default) auto-approves tool permission
  // requests so the turn does not crash on unpromptable tool confirmations.
  // Read-only turns are restricted by settings.json permissions scoping and
  // agy's --sandbox terminal restrictions.
  const permissionArgs =
    AGY_SKIP_PERMISSIONS === "true" ? ["--dangerously-skip-permissions"] : [];
  const sandboxArgs = readOnly ? ["--sandbox"] : [];
  // Only pass --effort when the model id does not already fix it; see
  // MODEL_EFFORT_SUFFIX.
  const effortArgs = modelEffort(model) ? [] : ["--effort", effort];
  return [
    "-p",
    prompt,
    "--model",
    model,
    ...effortArgs,
    "--mode",
    AGY_MODE,
    ...permissionArgs,
    ...sandboxArgs,
    "--output-format",
    "stream-json",
    "--print-timeout",
    PRINT_TIMEOUT
  ];
}

/**
 * Build the prompt agy will receive, with the read-only contract preamble
 * the bridge role's contract already implies but the header-based sandbox
 * mode confirms authoritatively on every turn.
 */
function buildAgyPrompt(
  prompt: string,
  agentRole: string | null,
  sandboxMode: "read-only" | "workspace-write" | null,
  skillContext: string | null
): string {
  const preamble = readOnlySystemPromptInjection(
    sandboxMode === null ? null : { "x-autodev-sandbox-mode": sandboxMode }
  );
  const skillPreamble = skillContext
    ? `

## Selected skill context (propagated from orchestrator)

${skillContext}
`
    : "";
  if (!preamble && !skillPreamble) return prompt;
  return `${preamble}${skillPreamble}

${prompt}`;
}

const BACKGROUND_TASKS_ACTIVE_PATTERN =
  /waiting up to .* for \d+ background task/i;

function runAgy(
  prompt: string,
  model: string,
  effort: string,
  cwd: string,
  onEvent: OnAgyEvent | null,
  spawnSession: string | null = null,
  agentRole: string | null = null,
  sandboxMode: "read-only" | "workspace-write" | null = null,
  skillContext: string | null = null,
  workspaceKey: unknown = null
): Promise<RunAgyResult> {
  let isolatedState: IsolatedHomeResult;
  try {
    isolatedState = createIsolatedAntigravityHome(agentRole, spawnSession, {
      cwd,
      sandboxMode
    });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<RunAgyResult>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      isolatedState.cleanup();
      callback();
    };
    const fail = (error: unknown) => settle(() => reject(error));
    const succeed = (result: RunAgyResult) => settle(() => resolve(result));

    let child: ChildProcess;
    try {
      const finalPrompt = buildAgyPrompt(
        prompt,
        agentRole,
        sandboxMode,
        skillContext
      );
      child = spawn(
        CLI,
        agyArgs(finalPrompt, model, effort, agentRole, sandboxMode),
        {
          cwd,
          env: withAutoDevOtelResourceContext(
            {
              ...agyEnvironment(spawnSession, isolatedState.isolatedHome),
              // Commits this agent makes carry its own bounded identity, so
              // attribution is read back from git rather than guessed by the
              // observing Runtime. Set as env, not repo config, so nothing is
              // persisted into the workspace.
              ...gitCommitIdentityEnv({
                role: agentRole,
                provider: "antigravity"
              })
            },
            workspaceKey,
            agentRole
          ),
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
    } catch (error) {
      fail(error);
      return;
    }
    let stderr = "";
    let terminalResult: JsonRecord | null = null;
    let emitted = "";
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        return;
      }
      // Only JSON objects are agy stream events; decode once, here.
      if (!isStreamEvent(decoded)) return;
      const event = decoded;
      onEvent?.(event);
      if (event.event === "step_update") {
        const update = event.step_update;
        if (isStepUpdate(update)) {
          const delta = String(update.text_delta ?? "");
          if (delta) {
            emitted += delta;
            onEvent?.({ type: "text_delta", text: delta });
          }
        }
      }
      // A result line without a JSON-object payload still ends the turn; it
      // reads as an empty result rather than a missing one.
      if (event.event === "result")
        terminalResult = isJsonRecord(event.result) ? event.result : {};
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (BACKGROUND_TASKS_ACTIVE_PATTERN.test(text)) {
        onEvent?.({ type: "background_tasks_active", text });
      }
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      const result = terminalResult;
      if (!result) {
        // The failure mode that ends long delegating turns: agy stops without
        // ever emitting a terminal result. Which of the three it was -- killed
        // because the client went away, exited on its own, or died on a signal
        // -- is only recoverable from the exit status and whatever it last
        // wrote to stderr, so all of it travels with the error instead of
        // being discarded into a bare sentence.
        const how = signal ? `on ${signal}` : `with code ${code}`;
        const tail = stderr.trim().slice(-2000);
        fail(
          Object.assign(
            new Error(
              `agy exited ${how} without a terminal result event${tail ? `: ${tail}` : " and wrote nothing to stderr"}`
            ),
            { exitCode: code, ...agyPermissionFailure(stderr) }
          )
        );
        return;
      }
      const resultRecord: JsonObject = result;
      const resultStatus =
        typeof resultRecord.status === "string" ? resultRecord.status : "";
      const resultError = resultRecord.error;
      const resultResponse =
        typeof resultRecord.response === "string" ? resultRecord.response : "";
      if (resultStatus && resultStatus !== "SUCCESS") {
        fail(
          Object.assign(
            new Error(
              agyFailureMessage({
                status: resultStatus,
                error: resultError,
                stderr,
                code
              })
            ),
            { exitCode: code, ...agyPermissionFailure(stderr) }
          )
        );
        return;
      }
      if (code !== 0) {
        fail(
          Object.assign(
            new Error(
              stderr.trim().slice(-4000) || `agy exited with code ${code}`
            ),
            { exitCode: code, ...agyPermissionFailure(stderr) }
          )
        );
        return;
      }
      const finalText = String(resultResponse || emitted);
      if (finalText && finalText !== emitted) {
        const suffix = finalText.startsWith(emitted)
          ? finalText.slice(emitted.length)
          : finalText;
        if (suffix) onEvent?.({ type: "text_delta", text: suffix });
      }
      if (!finalText.trim()) {
        fail(
          Object.assign(
            new Error(
              agyFailureMessage({
                status: resultStatus || "SUCCESS",
                error: "empty response",
                stderr,
                code
              })
            ),
            agyPermissionFailure(stderr)
          )
        );
        return;
      }
      succeed({ text: finalText || emitted, result: resultRecord });
    });
    onEvent?.({ type: "process", child });
  });
}

/** Node lowercases inbound header names; intermediaries may not. */
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

async function readJsonBody(
  request: IncomingMessage
): Promise<JsonRecord | null> {
  let body = "";
  for await (const chunk of request) body += chunk;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// The router already knows role/workspace for this request -- it chose both
// before routing here -- but has no way to correlate a failure this bridge
// reports back to the request it issued, short of diffing timestamps. The
// router-generated request id already travels on every router-issued request
// as a header (the same one AgentEventReporter authorizes telemetry from), so
// echoing it back costs nothing new to plumb and nothing that was not already
// there: no prompt text, just the identity the router itself assigned.
function agyErrorDetails(
  error: unknown,
  role: string | null,
  workspace: string,
  requestId: string | null = null
): AgyErrorDetails {
  const failure = agyFailure(error);
  const permissionFailure = agyProviderFailureDiagnostic(error);
  const message = permissionFailure
    ? "Antigravity denied a required tool permission in headless mode."
    : (failure.message ?? String(error));
  const details: AgyErrorDetails = {
    type: permissionFailure?.code ?? failure.failureCode ?? "upstream_error",
    message,
    provider: "antigravity",
    role: role ?? "default",
    workspace,
    requestId: requestId ?? null
  };
  if (permissionFailure) {
    details.code = permissionFailure.code;
    details.phase = permissionFailure.phase ?? null;
    details.tool = permissionFailure.tool ?? null;
  } else if (failure.failureCode) {
    details.code = failure.failureCode;
    details.phase = failure.failurePhase;
    details.tool = failure.failureTool;
  }
  return details;
}

async function handleLocalRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<boolean> {
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, {
      status: "ok",
      spawnSessions: spawnSessions.status()
    });
    return true;
  }
  if (
    pathname === "/v1/bridge-spawn/attach" ||
    pathname === "/v1/bridge-spawn/call"
  ) {
    await handleBridgeSpawnRoute(pathname, request, response);
    return true;
  }
  if (pathname === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: [
        { id: DEFAULT_MODEL, object: "model", owned_by: "google-antigravity" }
      ],
      models: [modelMetadata()]
    });
    return true;
  }
  return false;
}

async function handleBridgeSpawnRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  // The shim reaches this loopback route behind the same bearer check.
  if (AUTH_TOKEN && request.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    sendJson(response, 401, { error: "invalid local gateway key" });
    return;
  }
  const body = await readJsonBody(request);
  const session = typeof body?.session === "string" ? body.session : "";
  if (pathname.endsWith("/attach")) {
    // A leaf turn, or a CLI that outlived its request, is simply not offered
    // the tool rather than being offered one that fails.
    sendJson(response, 200, {
      spawnAllowed: spawnSessions.mayDelegate(session)
    });
    return;
  }
  const result = spawnSessions.record(session, body?.children);
  if (!result.accepted) {
    sendJson(response, 409, { error: result.message });
    return;
  }
  // Dispatch, rather than await: Codex creates and tracks these children.
  sendJson(response, 200, {
    text:
      `Dispatched ${result.count} subagent(s): ${result.roles}. They are running now and are tracked by ` +
      "the orchestration layer, not by you. End your turn now with a brief statement of what you delegated -- " +
      "do not wait for them, and do not do their work yourself. Their results are delivered to you " +
      "automatically on your next turn."
  });
}

function authorizeResponsesRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  if (pathname === "/v1/responses" && request.method === "POST") {
    if (!AUTH_TOKEN || request.headers.authorization === `Bearer ${AUTH_TOKEN}`)
      return true;
    sendJson(response, 401, {
      error: {
        type: "authentication_error",
        message: "invalid local gateway key"
      }
    });
    return false;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, {
      error: { type: "invalid_request_error", message: "not found" }
    });
    return false;
  }
  return true;
}

async function readResponsePayload(
  request: IncomingMessage,
  response: ServerResponse
): Promise<JsonObject | null> {
  let requestBody = "";
  for await (const chunk of request) requestBody += chunk;
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    sendJson(response, 400, {
      error: { type: "invalid_request_error", message: "invalid JSON" }
    });
    return null;
  }
  if (!isJsonRecord(parsed)) {
    sendJson(response, 400, {
      error: { type: "invalid_request_error", message: "invalid payload" }
    });
    return null;
  }
  return parsed;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (await handleLocalRoute(pathname, request, response)) return;
  if (!authorizeResponsesRoute(pathname, request, response)) return;
  const payload = await readResponsePayload(request, response);
  if (!payload) return;
  await handleResponsesRequest(request, response, payload);
}

/** A request header a sibling module has not already decoded for this bridge. */
function headerSandboxMode(
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

function resolveSandboxMode(
  headers: Record<string, unknown>
): "read-only" | "workspace-write" | null {
  return readOnlySystemPromptInjection(headers) === ""
    ? headerSandboxMode(headers)
    : "read-only";
}

function reportTurnHeartbeat(agentEvents: AgentReporter | null): void {
  if (typeof agentEvents?.reportHeartbeat === "function") {
    void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
  }
}

// Exposure, not invocation: the role contract decides which skills this turn
// can reach before agy starts, and that decision is the fact the router
// needs. Deriving it from what the model happened to invoke would report
// nothing for a turn that was given skills and never reached for one --
// exactly the case per-workspace skill attribution has to be able to show.
function reportRoleExposure(
  agentEvents: AgentReporter | null,
  bootstrapContract: AntigravityRoleContract
): void {
  if (!agentEvents) return;
  for (const skill of bootstrapContract.skills ?? []) {
    void agentEvents.reportSkillExposed({
      skill,
      source: ANTIGRAVITY_SKILL_EXPOSURE_SOURCE
    });
  }
  for (const server of bootstrapContract.mcp ?? []) {
    if (typeof agentEvents.reportMcpExposed === "function") {
      void agentEvents.reportMcpExposed({
        server,
        source: ANTIGRAVITY_MCP_EXPOSURE_SOURCE
      });
    } else if (typeof agentEvents.post === "function") {
      void agentEvents.post([
        { type: "mcp_exposed", server, source: ANTIGRAVITY_MCP_EXPOSURE_SOURCE }
      ]);
    }
  }
}

// A turn logged its start and nothing else, so a failed one left only the
// step lines that happened to precede it -- the reason it died reached the
// router as an HTTP status and was never written down anywhere. Every exit
// names itself and how long it took. The request id rides along so this line
// can be matched to the router's own log of the same request without
// exposing anything the router did not already assign.
function createTurnLog(
  requestId: string | null
): (outcome: string, detail?: string) => void {
  const turnStartedAt = Date.now();
  const elapsed = () => `${((Date.now() - turnStartedAt) / 1000).toFixed(1)}s`;
  return (outcome, detail = "") =>
    writeErrorLine(
      `agy turn ${outcome} after ${elapsed()} request=${requestId ?? "none"}${detail ? `: ${detail}` : ""}`
    );
}

/** Everything one Responses turn resolved before agy starts. */
interface ResponsesTurn {
  /** The model the client named, echoed back in every response body. */
  responseModel: JsonValue;
  model: string;
  effort: string;
  agentRole: string | null;
  workspaceKey: unknown;
  sandboxMode: "read-only" | "workspace-write" | null;
  skillContext: string | null;
  agentEvents: AgentReporter | null;
  spawnSession: string | null;
  requestId: string | null;
  cwd: string;
  prompt: string;
  spawnTracker: ReturnType<typeof createSpawnTracker>;
  toolObserver: ReturnType<typeof createToolObserver>;
  logTurnEnd: (outcome: string, detail?: string) => void;
}

/**
 * Validates and resolves one Responses request. Answers the request itself
 * (400) and returns null when the workspace cannot be resolved; delegation
 * state is opened only after every pre-flight check passed.
 */
function prepareResponsesTurn(
  request: IncomingMessage,
  response: ServerResponse,
  payload: JsonObject
): ResponsesTurn | null {
  const model = resolveModel(payload.model);
  const effort = resolveEffort(payload);
  // The router classifies the turn; only it can tell this bridge that it is
  // serving the root orchestrator rather than a delegated leaf.
  const agentRole = resolveAgentRole(request.headers);
  const workspaceKey = request.headers[AUTODEV_WORKSPACE_KEY_HEADER];
  const sandboxMode = resolveSandboxMode(request.headers);
  const skillContext = bridgeSkillContext(request.headers);
  // agy delegates through its own `invoke_subagent` tool, so those children
  // never reach the router as requests. Report them, or an orchestrator turn
  // served here reads as "never delegated".
  const agentEvents = resolveAgentEventReporter(request.headers);
  logInboundRequest(payload, request.headers);
  // Router-generated identity of the Codex conversation. Delegation through
  // Codex needs it so the shim's out-of-band call can find the turn it belongs
  // to; a turn the router could not identify holds none and falls back to agy's
  // own in-CLI delegation.
  const sessionHeader = headerValue(request.headers, "x-autodev-session-id");
  const sessionScope = headerValue(request.headers, "x-autodev-session-scope");
  const spawnSession = SpawnSessionRegistry.canHold(sessionHeader, sessionScope)
    ? sessionHeader
    : null;
  // The router's own correlation id for this request. It already travels on
  // every router-issued call (AgentEventReporter is authorized from the same
  // header) so a failure this bridge reports back can be matched to the
  // router request that produced it without carrying any prompt content.
  const requestId = headerValue(request.headers, REQUEST_ID_HEADER);
  const spawnTracker = createSpawnTracker(agentEvents);
  // The other half of what agy does inside its own runtime: the tools it
  // reaches for. Like delegation, none of it reaches the router as a request.
  const toolObserver = createToolObserver(agentEvents);
  let cwd: string;
  try {
    cwd = resolveCwd(payload, request.headers, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    sendWorkspaceResolutionFailure(response, "agy", error);
    return null;
  }
  const prompt = promptFromInput(
    payload.input ?? "",
    composeProviderPrompt(agentRole, cwd)
  );
  // Only hold delegation state once all pre-flight validation has succeeded.
  // An invalid workspace must not leave an orphaned entry that a later shim
  // process could attach to.
  if (spawnSession)
    spawnSessions.open(spawnSession, {
      orchestrator: isOrchestratorRole(agentRole)
    });
  const bootstrapContract = antigravityRoleContract(agentRole);
  const home = process.env.HOME ?? "";
  writeErrorLine(
    `agy bootstrap provider=antigravity model=${model} role=${agentRole ?? "default"} cwd=${cwd} skills=${JSON.stringify(bootstrapContract.skills ?? [])} mcp=${JSON.stringify(bootstrapContract.mcp ?? [])} permission_settings=${home}/.gemini/antigravity-cli/settings.json skill_registry=${cwd}/.agents/skills.json mcp_registry=${home}/.gemini/config/mcp_config.json`
  );
  writeErrorLine(
    `agy request model=${model} effort=${effort} role=${isOrchestratorRole(agentRole) ? "orchestrator" : "leaf"} cwd=${cwd}`
  );
  reportRoleExposure(agentEvents, bootstrapContract);
  return {
    responseModel: payload.model ?? model,
    model,
    effort,
    agentRole,
    workspaceKey,
    sandboxMode,
    skillContext,
    agentEvents,
    spawnSession,
    requestId,
    cwd,
    prompt,
    spawnTracker,
    toolObserver,
    logTurnEnd: createTurnLog(requestId)
  };
}

function runTurnAgy(
  turn: ResponsesTurn,
  onEvent: OnAgyEvent
): Promise<RunAgyResult> {
  return runAgy(
    turn.prompt,
    turn.model,
    turn.effort,
    turn.cwd,
    onEvent,
    turn.spawnSession,
    turn.agentRole,
    turn.sandboxMode,
    turn.skillContext,
    turn.workspaceKey
  );
}

/**
 * Delegation this turn asked for, collected out-of-band by the shim while agy
 * ran. Closing the session drains it; a non-empty batch becomes one `exec`
 * call so Codex creates the children itself and they become sessions the app
 * can show.
 */
function closeSpawnDelegation(
  spawnSession: string | null,
  outputIndex: number
): SpawnToolCallOutput | null {
  if (!spawnSession) return null;
  return buildSpawnToolCallOutput(
    spawnSessions.close(spawnSession),
    spawnSession,
    outputIndex
  );
}

async function runNonStreamingTurn(
  turn: ResponsesTurn,
  response: ServerResponse
): Promise<void> {
  const { agentEvents, spawnSession, agentRole, cwd, requestId } = turn;
  try {
    const heartbeat = setInterval(() => reportTurnHeartbeat(agentEvents), 5000);
    let result: RunAgyResult;
    try {
      result = await runTurnAgy(turn, (event) => {
        reportTurnHeartbeat(agentEvents);
        if (!isStepUpdateEvent(event)) return;
        const update: JsonValue = isStepUpdate(event.step_update)
          ? event.step_update
          : {};
        turn.spawnTracker.observeSpawnStep(update);
        turn.toolObserver.observeToolStep(update);
      });
    } finally {
      clearInterval(heartbeat);
    }
    const output: object[] = [
      responseMessageItem(result.text, `msg_${randomBytes(10).toString("hex")}`)
    ];
    const delegation = closeSpawnDelegation(spawnSession, output.length);
    if (delegation) {
      output.push(delegation.events[3][1].item);
      writeErrorLine(
        `agy delegating ${delegation.childCount} subagent(s) through Codex`
      );
    }
    turn.logTurnEnd("succeeded");
    sendJson(
      response,
      200,
      responsePayload(
        turn.responseModel,
        result.text,
        result.result,
        undefined,
        undefined,
        output
      )
    );
  } catch (error) {
    turn.spawnTracker.flushSpawns("failure");
    turn.toolObserver.reportPermissionDenial(error);
    if (spawnSession) spawnSessions.close(spawnSession);
    turn.logTurnEnd("failed", errorMessage(error));
    sendJson(response, 502, {
      error: agyErrorDetails(error, agentRole, cwd, requestId)
    });
  }
}

/**
 * The SSE half of one streamed Responses turn. Events are buffered until the
 * first real provider work arrives, so a provider that fails before doing
 * anything can still be answered with an HTTP status the router can fall back
 * on. Every event is numbered whether or not it is still deliverable.
 */
class ResponseEventStream {
  readonly responseId = `resp_${randomBytes(12).toString("hex")}`;
  readonly reasoningId = `rs_${randomBytes(12).toString("hex")}`;
  readonly itemId = `msg_${randomBytes(10).toString("hex")}`;
  private readonly response: ServerResponse;
  private readonly pending: string[] = [];
  private readonly activityParts: string[] = [];
  private readonly seenActivities = new Set<string>();
  private sequenceNumber = 0;
  private streamStarted = false;
  private clientClosed = false;
  // Exactly what this client already received, so flushing it on a failure is
  // truthful by construction rather than a second guess at the turn's output.
  private sentText = "";

  constructor(response: ServerResponse) {
    this.response = response;
  }

  get started(): boolean {
    return this.streamStarted;
  }

  get partialText(): string {
    return this.sentText;
  }

  get reasoningText(): string {
    return this.activityParts.join("\n");
  }

  markClientClosed(): void {
    this.clientClosed = true;
  }

  isWritable(): boolean {
    return (
      !this.clientClosed &&
      !this.response.writableEnded &&
      !this.response.destroyed &&
      !this.response.closed
    );
  }

  // `body` is serialized immediately: internal JSON records, typed payloads
  // from sibling modules, and shared terminal events all pass through here.
  emit(eventName: string, body: object): void {
    const event = sseLine(eventName, {
      ...body,
      sequence_number: ++this.sequenceNumber
    });
    if (!this.isWritable()) return;
    if (this.streamStarted) this.write(event);
    else this.pending.push(event);
  }

  start(): void {
    if (this.streamStarted || !this.isWritable()) return;
    this.streamStarted = true;
    this.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close"
    });
    this.response.flushHeaders();
    this.response.shouldKeepAlive = false;
    for (const event of this.pending.splice(0)) {
      if (!this.isWritable()) break;
      this.write(event);
    }
  }

  writeKeepAlive(): void {
    if (this.streamStarted && this.isWritable())
      this.write(": agy-bridge keep-alive\n\n");
  }

  end(): void {
    if (!this.isWritable()) return;
    try {
      this.response.end("data: [DONE]\n\n");
    } catch {
      // The peer may have already closed the connection; a write/end racing
      // that close is not actionable and must not crash the turn.
    }
  }

  emitTextDelta(text: string): void {
    this.sentText += text;
    this.emit("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.itemId,
      delta: text,
      content_index: 0,
      output_index: 1
    });
  }

  emitActivity(text: string, key: string = text): void {
    if (!text || this.seenActivities.has(key) || !this.isWritable()) return;
    this.seenActivities.add(key);
    this.activityParts.push(text);
    this.emitReasoningDelta(`${text}\n`);
  }

  emitReasoningDelta(delta: string): void {
    this.emit(EVENT_REASONING_SUMMARY_TEXT_DELTA, {
      type: EVENT_REASONING_SUMMARY_TEXT_DELTA,
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      delta
    });
  }

  emitPreamble(model: JsonValue): void {
    this.emit("response.created", {
      type: "response.created",
      response: {
        id: this.responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model,
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

  /** Closes both output items and returns the completed response payload. */
  emitCompletedItems(model: JsonValue, result: RunAgyResult): ResponsePayload {
    const reasoningText = this.reasoningText;
    const completedReasoning = {
      id: this.reasoningId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
      content: []
    };
    const completedMessage = responseMessageItem(result.text, this.itemId);
    const completed = responsePayload(
      model,
      result.text,
      result.result,
      this.responseId,
      this.itemId,
      [completedReasoning, completedMessage]
    );
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
      item: completedReasoning
    });
    this.emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: this.itemId,
      text: result.text,
      content_index: 0,
      output_index: 1
    });
    this.emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: this.itemId,
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: result.text, annotations: [] }
    });
    this.emit(EVENT_OUTPUT_ITEM_DONE, {
      type: EVENT_OUTPUT_ITEM_DONE,
      output_index: 1,
      item: completedMessage
    });
    return completed;
  }

  /** Ends the turn as incomplete, carrying the work it names and why. */
  emitIncomplete({
    model,
    ...incomplete
  }: IncompleteTurn & { model: JsonValue }): void {
    for (const [eventName, body] of terminalIncompleteEvents({
      ...incomplete,
      responseId: this.responseId,
      itemId: this.itemId,
      reasoningId: this.reasoningId,
      reasoningText: this.reasoningText,
      provider: "antigravity",
      response: responsePayload(
        model,
        incomplete.text,
        null,
        this.responseId,
        this.itemId,
        [],
        "incomplete"
      )
    })) {
      if (this.isWritable()) this.emit(eventName, body);
    }
    this.end();
  }

  private write(chunk: string): void {
    try {
      this.response.write(chunk);
    } catch {
      // The peer may have already closed the connection; a write/end racing
      // that close is not actionable and must not crash the turn.
    }
  }
}

/** The turn-specific half of a terminal incomplete event batch. */
type IncompleteTurn = Pick<
  Parameters<typeof terminalIncompleteEvents>[0],
  "reason" | "limit" | "providerFailure"
> & { text: string };

/** Provider-reported throttling that maps to HTTP 429 rather than 503. */
const THROTTLED_LIMIT_CLASSES = new Set([
  "throttled",
  "session_limit",
  "quota_exhausted"
]);

/**
 * Lifecycle of one streamed turn: which of agy's steps are still in flight,
 * whether a client close must kill agy or leave it to finish its delegation,
 * the keep-alive and delegation heartbeats, and how the turn ends.
 */
class StreamingTurn {
  // Tracks the most recent spawn-step tool the bridge saw from agy, and how
  // many of the children it dispatched the spawn tracker still has open.
  // Active spawn steps and open children are both the dangerous case: the
  // parent agy process is waiting on work the bridge's SSE stream cannot see
  // (only keep-alives), and any of the upstream idle / wall-clock ceilings
  // will close the connection. `activeTool` alone is not enough to detect
  // this: `invoke_subagent` reports its own step `DONE` as soon as the
  // hand-off succeeds, long before the children it dispatched finish, so
  // `pendingChildren` -- kept in sync with the spawn tracker's
  // `openSpawnCount()` -- is what keeps this true for the rest of the
  // children's run. Killing agy in that window also kills the children and
  // strands any work they had buffered, so we let agy run to its
  // PRINT_TIMEOUT instead and surface the cause as
  // INCOMPLETE_REASON_CLIENT_DISCONNECTED. The launchd log distinguishes the
  // two cases by name. An ordinary disconnected turn -- no delegator ever
  // ran, or every dispatched child has already closed -- is still killed.
  private readonly delegation: DelegationState = {
    activeTool: null,
    activeStep: null,
    activatedAt: 0,
    pendingChildren: 0,
    activeCommands: 0,
    activeWaits: 0
  };
  private readonly activeCommands = new Set<number | string>();
  private readonly activeWaits = new Set<number | string>();
  private readonly turn: ResponsesTurn;
  private readonly stream: ResponseEventStream;
  private readonly response: ServerResponse;
  private child: ChildProcess | undefined;
  private keepAlive: NodeJS.Timeout | undefined;
  // Synthetic activity the bridge emits while agy is mid-delegation, so the
  // Codex-side idle / wall-clock timers see real Responses traffic rather
  // than only SSE comment keep-alives. The 2-second keep-alive is not
  // counted as data by every fetch client; emitting a real event every 30 s
  // gives the upstream something it cannot strip.
  private delegationHeartbeat: NodeJS.Timeout | null = null;
  // Set once the turn has produced its final event, so the close that always
  // follows a completed stream is not reported as the client hanging up.
  private settled = false;
  // Why the client went away while agy was still delegating, if it did.
  private disconnectDetail: string | null = null;

  constructor(
    turn: ResponsesTurn,
    stream: ResponseEventStream,
    response: ServerResponse
  ) {
    this.turn = turn;
    this.stream = stream;
    this.response = response;
  }

  attach(): void {
    this.response.on("error", this.onResponseError);
    this.keepAlive = setInterval(() => {
      reportTurnHeartbeat(this.turn.agentEvents);
      this.stream.writeKeepAlive();
    }, 2000);
    this.response.on("close", () => {
      this.response.removeListener("error", this.onResponseError);
      // The router aborting its upstream fetch -- its 15-minute timeout, or
      // its own client going away -- reaches this bridge as nothing but a
      // closed socket. Naming it is the difference between "agy died", "agy
      // was killed because nobody was listening any more", and "agy was
      // delegating when nobody was listening any more".
      this.clientGone("the client disconnected");
    });
  }

  detach(): void {
    clearInterval(this.keepAlive);
    this.response.removeListener("error", this.onResponseError);
  }

  readonly onEvent = (event: AgyEvent): void => {
    reportTurnHeartbeat(this.turn.agentEvents);
    if (isProcessEvent(event)) {
      this.child = event.child;
    } else if (isBackgroundTasksEvent(event)) {
      this.stream.start();
      this.delegation.activeWaits = Math.max(
        Number(this.delegation.activeWaits || 0),
        1
      );
      this.startDelegationHeartbeat();
    } else if (isTextDeltaEvent(event)) {
      this.stream.start();
      this.stream.emitTextDelta(event.text);
    } else if (isStepUpdateEvent(event) && isStepUpdate(event.step_update)) {
      this.observeStep(event, event.step_update);
    }
  };

  complete(result: RunAgyResult): void {
    this.quiesce("success");
    // If the upstream closed mid-delegation, the run still completes here --
    // agy got its full PRINT_TIMEOUT -- but the parent is gone. Emit an
    // incomplete event carrying the cause so any future re-attach can replay
    // the work; for now the bytes go nowhere because isWritable() is false.
    if (this.disconnectDetail !== null) {
      this.settled = true;
      this.turn.logTurnEnd(
        "succeeded-mid-delegation",
        `agy finished after upstream close: ${this.disconnectDetail}`
      );
      this.stream.emitIncomplete({
        text: result.text,
        reason: INCOMPLETE_REASON_CLIENT_DISCONNECTED,
        limit: null,
        model: this.turn.responseModel
      });
      return;
    }
    this.stream.start();
    const completed = this.stream.emitCompletedItems(
      this.turn.responseModel,
      result
    );
    const delegation = closeSpawnDelegation(
      this.turn.spawnSession,
      completed.output.length
    );
    if (delegation) {
      for (const [name, event] of delegation.events)
        this.stream.emit(name, event);
      completed.output.push(delegation.events[3][1].item);
      writeErrorLine(
        `agy delegating ${delegation.childCount} subagent(s) through Codex`
      );
    }
    this.stream.emit("response.completed", {
      type: "response.completed",
      response: completed
    });
    this.settled = true;
    this.turn.logTurnEnd("succeeded");
    this.stream.end();
  }

  fail(error: unknown): void {
    this.quiesce("failure");
    // Reported before the writability check below returns: a permission gap
    // is a fact about the workspace, not about whether the parent is still
    // listening, and it is the only unavailability agy ever states out loud.
    this.turn.toolObserver.reportPermissionDenial(error);
    const message = errorMessage(error);
    // Logged before the writability check: a turn that failed *because* the
    // client had already gone is exactly the case worth seeing.
    if (!this.settled)
      this.turn.logTurnEnd(
        "failed",
        `${message}${this.stream.isWritable() ? "" : " (client already gone)"}`
      );
    this.settled = true;
    if (!this.stream.isWritable()) return;
    // agy reports a usage limit as nothing but an error string, so this is the
    // one place the difference between "out of quota" and "the CLI crashed"
    // can be recovered. It is only ever `inferred`, never enough on its own
    // to take the provider out for a long cooldown, but it is enough to pick a
    // status the router can act on and a retry hint it can size a wait against.
    const limit = classifyCliLimit(message, agyFailure(error).exitCode);
    if (!this.stream.started) {
      this.sendFailureStatus(error, limit);
      return;
    }
    // A failure after the stream opened cannot be replayed on another
    // provider, so the work already sent is all the parent will ever get for
    // this turn. Close the turn as incomplete, carrying that work and saying
    // why it stopped. The turn is still not completed, so the router still
    // counts it as a failure.
    this.stream.emitIncomplete({
      text: this.stream.partialText,
      reason: limit
        ? INCOMPLETE_REASON_PROVIDER_LIMIT
        : INCOMPLETE_REASON_INTERRUPTED,
      limit,
      providerFailure: agyProviderFailureDiagnostic(error),
      model: this.turn.responseModel
    });
  }

  private readonly onResponseError = (): void => {
    this.clientGone("the client connection errored");
  };

  private clientGone(cause: string): void {
    this.stream.markClientClosed();
    clearInterval(this.keepAlive);
    this.stopDelegationHeartbeat();
    const decision = decideCloseOnDelegation(this.delegation);
    if (!decision.kill) {
      // Do NOT kill agy: the upstream went away while agy was delegating,
      // and killing agy here strands the children it had spawned. runAgy
      // keeps awaiting agy's natural completion; whatever it produces is
      // discarded because the upstream is already gone.
      this.disconnectDetail = `${cause} ${delegationDetail(decision)}; agy will continue to print-timeout`;
      if (!this.settled)
        this.turn.logTurnEnd("aborted-delegation", this.disconnectDetail);
      return;
    }
    if (!this.settled)
      this.turn.logTurnEnd("aborted", `${cause}; agy was killed mid-turn`);
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }

  private observeStep(event: AgyStreamEvent, update: AgyStepUpdate): void {
    const toolInfo = isToolInfo(update.tool_info) ? update.tool_info : null;
    const stepToolName = String(update.tool_name ?? toolInfo?.name ?? "");
    const stepState = String(update.state ?? "").toUpperCase();
    const stepIndex: number | string =
      stepIndexOf(update) ?? (stepToolName || "unknown");
    trackActiveStep(
      this.activeCommands,
      isCommandStep(update),
      stepState,
      stepIndex
    );
    trackActiveStep(this.activeWaits, isWaitStep(update), stepState, stepIndex);
    this.delegation.activeCommands = this.activeCommands.size;
    this.delegation.activeWaits = this.activeWaits.size;
    this.turn.spawnTracker.observeSpawnStep(update);
    this.turn.toolObserver.observeToolStep(update);
    // Kept in sync on every step so a dispatch step's own DONE -- which
    // clears activeTool below -- does not read as "delegation over" while
    // the spawn tracker still has children it dispatched open.
    this.delegation.pendingChildren = this.turn.spawnTracker.openSpawnCount();
    const activity = activityText(event);
    if (activity) {
      // A step_update is provider-produced work, so the turn is genuinely
      // under way: commit to the SSE stream and let the parent watch the
      // activity live. Synthetic pre-run activity stays buffered so a
      // provider that fails before doing anything can still be reported
      // as an HTTP status the router can fall back on.
      this.stream.start();
      this.stream.emitActivity(activity, stepActivityKey(update));
    }
    this.trackDelegation(update);
    if (update.step_type === "tool")
      writeErrorLine(`agy tool=${update.tool_name ?? "unknown"}`);
  }

  // Track the most recent delegator step so the close and error handlers can
  // tell a turn that aborted during delegation apart from one that aborted
  // before delegation started. The synthetic heartbeat rides on the same
  // flag. isSpawnToolName falls back to agy's own tool name when the router
  // sent no reporter, so this classification -- and therefore the kill
  // decision -- still works when the telemetry headers are absent.
  private trackDelegation(update: AgyStepUpdate): void {
    const transition = updateDelegationState(this.delegation, update, (name) =>
      isSpawnToolName(this.turn.agentEvents, name)
    );
    if (transition.kind === "entered" || isDelegationActive(this.delegation))
      this.startDelegationHeartbeat();
    // The dispatch step closing does not by itself mean delegation is over:
    // only stop the heartbeat once the spawn tracker agrees no dispatched
    // children are still open.
    if (transition.kind === "exited" && !isDelegationActive(this.delegation))
      this.stopDelegationHeartbeat();
  }

  private startDelegationHeartbeat(): void {
    if (this.delegationHeartbeat) return;
    let tick = 0;
    this.delegationHeartbeat = setInterval(() => {
      reportTurnHeartbeat(this.turn.agentEvents);
      if (
        !isDelegationActive(this.delegation) ||
        !this.stream.started ||
        !this.stream.isWritable()
      )
        return;
      tick += 1;
      this.stream.emitReasoningDelta(
        ` (delegation heartbeat ${tick}; agy still working)\n`
      );
    }, 30_000);
  }

  private stopDelegationHeartbeat(): void {
    if (!this.delegationHeartbeat) return;
    clearInterval(this.delegationHeartbeat);
    this.delegationHeartbeat = null;
  }

  /** agy has exited: stop every timer and settle the step trackers. */
  private quiesce(outcome: "success" | "failure"): void {
    clearInterval(this.keepAlive);
    this.stopDelegationHeartbeat();
    this.turn.spawnTracker.flushSpawns(outcome);
    this.delegation.pendingChildren = this.turn.spawnTracker.openSpawnCount();
    this.activeCommands.clear();
    this.activeWaits.clear();
    this.delegation.activeCommands = 0;
    this.delegation.activeWaits = 0;
  }

  /** Nothing was streamed yet, so the failure can still be an HTTP status. */
  private sendFailureStatus(
    error: unknown,
    limit: ReturnType<typeof classifyCliLimit>
  ): void {
    const status =
      limit && THROTTLED_LIMIT_CLASSES.has(limit.limitClass) ? 429 : 503;
    const headers = limitResponseHeaders(limit);
    const retryAfter = retryAfterSecondsFromLimit(limit);
    if (retryAfter !== null) headers["retry-after"] = String(retryAfter);
    const { agentRole, cwd, requestId } = this.turn;
    const errorDetails: JsonRecord = agyErrorDetails(
      error,
      agentRole,
      cwd,
      requestId
    );
    const declaredLimit = limitPayload(limit);
    if (declaredLimit) errorDetails.limit = declaredLimit;
    sendJson(this.response, status, { error: errorDetails }, headers);
  }
}

function trackActiveStep(
  active: Set<number | string>,
  matches: boolean,
  state: string,
  index: number | string
): void {
  if (!matches) return;
  if (state === "ACTIVE") active.add(index);
  else if (TERMINAL_TOOL_STATES.has(state)) active.delete(index);
}

/** Deduplicates repeated step_updates that carry the same activity. */
function stepActivityKey(update: AgyStepUpdate): string {
  return `${String(stepIndexOf(update) ?? "?")}:${update.state ?? "?"}:${update.step_type ?? "?"}:${update.tool_name ?? ""}`;
}

async function runStreamingTurn(
  turn: ResponsesTurn,
  response: ServerResponse
): Promise<void> {
  const stream = new ResponseEventStream(response);
  stream.emitPreamble(turn.responseModel);
  stream.emitActivity("Antigravity started processing.", "initial");
  const streaming = new StreamingTurn(turn, stream, response);
  streaming.attach();
  try {
    streaming.complete(await runTurnAgy(turn, streaming.onEvent));
  } catch (error) {
    streaming.fail(error);
  } finally {
    streaming.detach();
    // The registry must not outlive the turn on any path. A stale entry would
    // accept a delegation from a CLI that outlived its request and attach it
    // to nothing, or -- on a reused session key -- to the next turn. Closing
    // twice is harmless; the success path has already drained it.
    if (turn.spawnSession) spawnSessions.close(turn.spawnSession);
  }
}

async function handleResponsesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  payload: JsonObject
): Promise<void> {
  const turn = prepareResponsesTurn(request, response, payload);
  if (!turn) return;
  if (payload.stream) await runStreamingTurn(turn, response);
  else await runNonStreamingTurn(turn, response);
}

if (IS_MAIN) {
  createServer((request, response) => {
    void handle(request, response);
  }).listen(PORT, HOST, () => {
    writeErrorLine(
      `Antigravity Responses proxy listening at http://${HOST}:${PORT}`
    );
  });
}

export {
  agyArgs,
  agyEnvironment,
  agyErrorDetails,
  agyFailureMessage,
  agyPermissionFailure,
  ANTIGRAVITY_MCP_EXPOSURE_SOURCE,
  ANTIGRAVITY_SKILL_EXPOSURE_SOURCE,
  ANTIGRAVITY_WEB_RESEARCH_TOOLS,
  antigravityToolServer,
  buildInvocationMcpConfig,
  createIsolatedAntigravityHome,
  createSpawnTracker,
  createToolObserver,
  decideCloseOnDelegation,
  extractSkillReadPath,
  isCommandStep,
  isDelegationActive,
  isWaitStep,
  matchSkillReadPath,
  modelEffort,
  promptFromInput,
  resolveEffort,
  resolveModel,
  runAgy,
  spawnedChildren,
  subagentModel,
  toolStepEvidence,
  updateDelegationState
};
export type { CloseDecision, DelegationState, DelegationTransition };
