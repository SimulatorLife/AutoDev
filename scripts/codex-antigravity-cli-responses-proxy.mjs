#!/usr/bin/env node

/** OpenAI Responses compatibility proxy for the subscription-authenticated agy CLI. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Bind the port only when run as a program. The shared request-shaping helpers
// below are pure and worth testing directly; importing this file must not take
// the port out from under the running bridge.
const IS_MAIN = process.argv[ 1 ] && import.meta.url === pathToFileURL(process.argv[ 1 ]).href;

const HOST = process.env.AGY_PROXY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.AGY_PROXY_PORT ?? "4002", 10);
const CLI = process.env.AGY_CLI_PATH ?? `${process.env.HOME ?? process.cwd()}/.local/bin/agy`;
const DEFAULT_MODEL = "gemini-3.8-flash-medium";
const DEFAULT_EFFORT = "medium";
const AGY_MODE = process.env.AGY_MODE ?? "accept-edits";
const AGY_SKIP_PERMISSIONS = process.env.AGY_SKIP_PERMISSIONS ?? "true";
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT ?? "15m";
const AUTH_TOKEN = process.env.LITELLM_API_KEY ?? "";
const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT ?? process.env.AGY_PROJECT_ROOT ?? null;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EFFORTS = new Set([ "low", "medium", "high" ]);
// agy encodes reasoning depth in the model id itself (`gemini-3.8-flash-high`)
// and rejects the whole invocation when a separate --effort disagrees with it:
// "invalid model selection: --model gemini-3.8-flash-high conflicts with
// --effort=medium". The router picks the model per tier and the caller's
// effort is an independent value, so the two routinely disagree and the turn
// fails before the CLI starts. The model id is the more specific choice, so it
// wins and --effort is omitted for models that already carry one.
const MODEL_EFFORT_SUFFIX = /-(low|medium|high)$/;

import { resolveCwd, WorkspaceResolutionError } from "./codex/lib/resolve-workspace.mjs";
import { composeProviderPrompt, isOrchestratorRole, resolveAgentRole } from "./codex/lib/bridge-role.mjs";
import { roleContract } from "./codex/lib/execution-contract.mjs";
import { classifyCliLimit, INCOMPLETE_REASON_CLIENT_DISCONNECTED, INCOMPLETE_REASON_INTERRUPTED, INCOMPLETE_REASON_PROVIDER_LIMIT, limitPayload, limitResponseHeaders, retryAfterSecondsFromLimit, terminalIncompleteEvents } from "./codex/lib/provider-limits.mjs";
import { REQUEST_ID_HEADER, SKILL_READ_SOURCE, resolveAgentEventReporter } from "./codex/lib/agent-events.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { SpawnSessionRegistry } from "./codex/lib/bridge-spawn-session.mjs";
import { buildSpawnScript, execToolCallSseEvents, mintCallId, mintCallItemId } from "./codex/lib/codex-spawn-tools.mjs";

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
function structured(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** The `Subagents` batch somewhere inside a step update, or null. */
function subagentBatch(value, depth = 0) {
  if (depth > MAX_SPAWN_ARG_DEPTH) return null;
  const node = structured(value);
  if (!node) return null;
  if (!Array.isArray(node)) {
    const key = Object.keys(node).find((candidate) => candidate.toLowerCase() === "subagents");
    if (key !== undefined && Array.isArray(node[ key ]) && node[ key ].length > 0) return node[ key ];
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

function subagentRole(child) {
  if (!child || typeof child !== "object") return null;
  // agy identifies a child by its archetype, and `define_subagent` registers
  // that archetype under `name`. Model is deliberately not a fallback: it is
  // the model, not the role, and would pollute `byRole` with model ids.
  for (const key of [ "TypeName", "type_name", "typeName", "Name", "name", "Agent", "agent" ]) {
    const value = child[ key ];
    if (typeof value !== "string" || !value.trim()) continue;
    return value.trim().toLowerCase() === SELF_ARCHETYPE ? null : value.trim();
  }
  return null;
}

/** The model one batch entry names, or null when it names none of its own. */
function subagentModel(child) {
  if (!child || typeof child !== "object") return null;
  for (const key of [ "Model", "model", "ModelName", "model_name" ]) {
    const value = child[ key ];
    // agy writes `inherit` when the child runs on whatever the parent was
    // routed to, which is not a model id; the router resolves that itself.
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** agy's own id for a child conversation, or null when the entry carries none. */
function subagentConversationId(child) {
  if (!child || typeof child !== "object") return null;
  for (const key of [ "conversation_id", "conversationId", "ConversationId" ]) {
    const value = child[ key ];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Where agy is writing the child's transcript, when it says. */
function subagentLogUri(child) {
  if (!child || typeof child !== "object") return null;
  for (const key of [ "log_uri", "logUri", "LogUri" ]) {
    const value = child[ key ];
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
function spawnedChildren(update) {
  const step = Number.isFinite(update?.step_index) ? update.step_index : `x${(anonymousSpawnStep += 1)}`;
  const batch = subagentBatch(update);
  if (!batch) return [ { id: `s${step}.0`, role: null, model: null, logUri: null } ];
  return batch.map((child, index) => ({
    id: subagentConversationId(child) ?? `s${step}.${index}`,
    role: subagentRole(child),
    model: subagentModel(child),
    logUri: subagentLogUri(child),
  }));
}

// Confirming the shape agy actually emits needs a real spawn, and a spawn is
// rare enough that guessing wrong would go unnoticed for weeks. This prints the
// spawn step's structure -- keys kept, string values truncated, so a delegation
// prompt is not written to the launchd log -- when AGY_LOG_SPAWN_STEPS=1.
const LOG_SPAWN_STEPS = process.env.AGY_LOG_SPAWN_STEPS === "1";
const SPAWN_STEP_LOG_STRING_LIMIT = 80;

function shapeOnly(value, depth = 0) {
  if (typeof value === "string") return value.length > SPAWN_STEP_LOG_STRING_LIMIT ? `${value.slice(0, SPAWN_STEP_LOG_STRING_LIMIT)}...<${value.length}>` : value;
  if (!value || typeof value !== "object" || depth > MAX_SPAWN_ARG_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => shapeOnly(entry, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([ key, entry ]) => [ key, shapeOnly(entry, depth + 1) ]));
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
const ANTIGRAVITY_SPAWN_TOOL_NAMES = new Set([ "invoke_subagent" ]);
function isSpawnToolName(agentEvents, toolName) {
  if (agentEvents) return agentEvents.isSpawnTool(toolName);
  return ANTIGRAVITY_SPAWN_TOOL_NAMES.has(toolName);
}

// How an agy turn comes by the skills its role contract grants it: agy has no
// per-invocation skill flag, so the contract rendered into the turn's prompt
// and the workspace's own `.agents/skills.json` registry are the exposure.
// Carried on every `skill_exposed` event so the router's rows say which
// mechanism made the skill available rather than only that something did.
const ANTIGRAVITY_SKILL_EXPOSURE_SOURCE = "role_contract";

// Canonical skill roots whose `SKILL.md` a successful read counts as actual
// usage, mirroring the approved roots `scripts/codex/skill-read-telemetry.mjs`
// uses for Codex's own PreToolUse hook. agy's own tool calls never reach that
// hook -- its CLI runs entirely inside its own runtime -- so this bridge is
// the only place a `read_file`/`view_file` or shell read of one of these
// files is observable at all.
const HOME = homedir();
const REPO_ROOT = process.env.AUTODEV_REPO_ROOT || resolve(join(import.meta.dirname, ".."));
const SKILL_ROOTS = [
  join(HOME, ".agents", "skills"),
  join(HOME, ".codex", "skills"),
  join(HOME, "AutoDev", ".agents", "skills"),
  join(HOME, "AutoDev", "scripts", "codex", "skills"),
  join(REPO_ROOT, ".agents", "skills"),
  join(REPO_ROOT, "scripts", "codex", "skills"),
].filter((path) => existsSync(path));

// Tool names agy uses to read a file's contents outright, versus the shell
// tools whose command line may contain a read of one. Anything else --
// `write_file`, `edit_file`, `str_replace`, agy's own delegation tool -- is
// deliberately excluded: a mutation or an unrelated call must never be
// counted as a skill activation just because its arguments happen to name a
// path.
const AGY_READ_TOOL_NAMES = new Set([ "read_file", "view_file", "cat_file" ]);
const AGY_EXEC_TOOL_NAMES = new Set([ "run_command", "exec_command", "execute_command", "bash" ]);

function normaliseSkillReadPath(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  let path = trimmed;
  if (path.startsWith("~")) path = join(HOME, path.slice(1));
  if (!isAbsolute(path)) path = resolve(path);
  return path;
}

// A cat/head/less/sed -n/awk/grep read of an absolute path inside a shell
// command. Bounded and deliberately narrow: a command that does not spell
// out an absolute path is not treated as a read of anything in particular.
function matchExecReadPath(cmd) {
  if (typeof cmd !== "string" || cmd.length > 4096) return null;
  const re = /(?:^|\s)(?:cat|head|tail|less|more|sed\s+-n|awk|grep)(?:\s+\S+){0,8}\s+((?:\/|~)[^\s'"]+)/;
  const match = re.exec(cmd);
  return match ? match[ 1 ] : null;
}

/** The path a `read_file`-shaped or shell-read tool call names, if any. */
function extractSkillReadPath(toolName, argsObject) {
  const name = String(toolName ?? "").trim().toLowerCase();
  const args = argsObject && typeof argsObject === "object" ? argsObject : {};
  if (AGY_READ_TOOL_NAMES.has(name)) {
    for (const key of [ "file_path", "filePath", "path", "filepath" ]) {
      const value = args[ key ];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }
  if (AGY_EXEC_TOOL_NAMES.has(name)) {
    const cmd = args.command ?? args.cmd;
    return typeof cmd === "string" ? matchExecReadPath(cmd) : null;
  }
  return null;
}

// True when `path` resolves to `<root>/<skill-name>/SKILL.md` for one of the
// approved roots. Returns the skill's directory name -- never the absolute
// path -- because that is all the router retains.
function matchSkillReadPath(path) {
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

/** Report a successful, canonical `SKILL.md` read as `skill_used`, once per skill per turn. */
function reportSkillReadIfMatched({ agentEvents, seenSkills, toolName, args, callId }) {
  if (!agentEvents || typeof agentEvents.reportSkillUsed !== "function") return;
  const candidate = extractSkillReadPath(toolName, args);
  if (!candidate) return;
  const normalised = normaliseSkillReadPath(candidate);
  const skill = matchSkillReadPath(normalised);
  if (!skill) return;
  if (seenSkills.has(skill)) return;
  seenSkills.add(skill);
  const eventId = `skill_read:${callId ?? "no-call-id"}:${skill}`;
  void agentEvents.reportSkillUsed({ skill, source: SKILL_READ_SOURCE, eventId });
}

// Where agy puts a tool call's output. Its own changelog describes `tool_info`
// as carrying "canonical tool name, parameters, and output", and which key
// holds the payload has moved between CLI versions, so any of these counts as
// the output that proves the call ran. Guessing one and pinning it would make
// a CLI update silently downgrade every executed call to a requested one.
const TOOL_OUTPUT_KEYS = [ "output", "result", "tool_output", "tool_result", "response", "content" ];
const TERMINAL_TOOL_STATES = new Set([ "DONE", "ERROR", "FAILED", "CANCELLED" ]);

const AGY_DENIED_PATTERN = /permission[_\s-]?denied|auto[_\s-]?denied|denied|not[_\s-]?permitted|not[_\s-]?allowed|no such tool|tool not found/i;

/** True when a step carries the tool call's own output. */
function toolOutputPresent(update) {
  const info = structured(update?.tool_info) ?? {};
  for (const key of TOOL_OUTPUT_KEYS) {
    const value = info[ key ] ?? update?.[ key ];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" ? value.trim() !== "" : true) return true;
  }
  return false;
}

/** The MCP server an Antigravity tool belongs to, or null if builtin / unspecified. */
function antigravityToolServer(update, toolName) {
  const rawServer = update?.server ?? update?.tool_info?.server;
  if (typeof rawServer === "string" && rawServer.trim()) return rawServer.trim();
  const name = typeof toolName === "string" ? toolName.trim() : "";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3 && parts[1]) return parts[1];
  }
  if (name.startsWith("mcp_")) {
    const parts = name.split("_");
    if (parts.length >= 3 && parts[1]) return parts[1];
  }
  const args = structured(update?.tool_info?.args) ?? structured(update?.tool_input) ?? {};
  if (args.ServerName && typeof args.ServerName === "string" && args.ServerName.trim()) {
    return args.ServerName.trim();
  }
  if (args.server_name && typeof args.server_name === "string" && args.server_name.trim()) {
    return args.server_name.trim();
  }
  return null;
}

/** How long agy says the call took, in ms, or null when it does not say. */
function toolDurationMs(update) {
  const seconds = update?.duration_seconds ?? update?.tool_info?.duration_seconds;
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
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
 */
function toolStepEvidence(update) {
  const state = String(update?.state ?? "").toUpperCase();
  if (state === "ACTIVE") return { kind: "requested" };
  if (!TERMINAL_TOOL_STATES.has(state)) return { kind: "none" };
  const info = structured(update?.tool_info) ?? {};
  const statusMessage = String(update?.status_message ?? update?.error ?? info.error ?? info.status_message ?? "");
  const outputText = String(info.output ?? info.result ?? update?.output ?? update?.result ?? "");
  if (AGY_DENIED_PATTERN.test(statusMessage) || (state !== "DONE" && AGY_DENIED_PATTERN.test(outputText))) {
    const reason = /permission|auto[_\s-]?denied/i.test(statusMessage || outputText) ? "permission_denied" : "denied";
    return { kind: "unavailable", reason };
  }
  if (state !== "DONE" && !toolOutputPresent(update)) {
    if (state === "CANCELLED") return { kind: "unavailable", reason: "cancelled" };
    return { kind: "none" };
  }
  return { kind: "executed", status: state === "DONE" ? "ok" : "error", durationMs: toolDurationMs(update) };
}

/** agy's handle on a tool call within this turn: its step index. */
function toolCallId(update) {
  return Number.isFinite(update?.step_index) ? `s${update.step_index}` : null;
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
function createToolObserver(agentEvents) {
  const requested = new Set();
  const settled = new Set();
  // Per-turn dedupe for skill reads: keyed on the skill name, not the call,
  // so re-reading the same SKILL.md from a second tool call in the same turn
  // still reports one use rather than two.
  const seenSkills = new Set();
  const observeToolStep = (update) => {
    if (!agentEvents) return;
    if (String(update?.step_type ?? "").toLowerCase() !== "tool") return;
    const tool = String(update?.tool_name ?? update?.tool_info?.name ?? "").trim();
    if (!tool) return;
    const callId = toolCallId(update);
    const key = callId ?? tool;
    const evidence = toolStepEvidence(update);
    const server = antigravityToolServer(update, tool);
    if (evidence.kind === "requested") {
      if (requested.has(key)) return;
      requested.add(key);
      void agentEvents.reportToolRequested({ tool, callId, server });
      if (typeof agentEvents.reportActivity === "function") {
        if (tool === "ask_question") void agentEvents.reportActivity({ state: "user_wait" });
        else void agentEvents.reportActivity({ state: "tool_wait" });
      }
      return;
    }
    if (evidence.kind === "unavailable") {
      if (settled.has(key)) return;
      settled.add(key);
      void agentEvents.reportToolUnavailable({ tool, callId, reason: evidence.reason, server });
      if (typeof agentEvents.reportActivity === "function") void agentEvents.reportActivity({ state: "resumed" });
      return;
    }
    if (evidence.kind !== "executed" || settled.has(key)) return;
    settled.add(key);
    void agentEvents.reportToolExecuted({ tool, callId, status: evidence.status, durationMs: evidence.durationMs, server });
    // A denied or failed call proves nothing was actually read, so only a
    // call agy itself reports as `ok` can ever surface a skill_used event.
    if (evidence.status === "ok") {
      const args = structured(update?.tool_info?.args) ?? structured(update?.tool_input) ?? {};
      reportSkillReadIfMatched({ agentEvents, seenSkills, toolName: tool, args, callId });
    }
    if (typeof agentEvents.reportActivity === "function") void agentEvents.reportActivity({ state: "resumed" });
  };
  // agy auto-denies a tool whose permission the run was not granted and says
  // so only on stderr, which this bridge already parses into the failure it
  // raises. That is the one case where the turn knows a tool the model asked
  // for was never allowed to run, and reporting it is what stops the
  // dashboard reading a permission gap as "the workspace never used it".
  const reportPermissionDenial = (error) => {
    if (!agentEvents) return;
    if (error?.failureCode !== "AGY_PERMISSION_DENIED") return;
    const server = antigravityToolServer(null, error.failureTool);
    void agentEvents.reportToolUnavailable({ tool: error.failureTool, reason: "permission_denied", server });
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
function createSpawnTracker(agentEvents) {
  const reportedSpawns = new Set();
  // Spawn steps whose children are still running.
  //
  // `invoke_subagent` is fire-and-forget: measured directly from agy's
  // stream-json, the dispatch step reports `state: DONE` with
  // `duration_seconds: 0.043` inside a turn that ran 45s while the child
  // actually did the work. Its terminal state says the dispatch finished, not
  // the child, and agy emits no later step when a child completes -- the
  // child's result reaches the parent as context, invisibly. So the child's
  // true runtime is not observable from this stream at all.
  //
  // Closing on that DONE therefore reported ~40ms for children that ran for
  // minutes, which is worse than reporting nothing: it fills the usage tables
  // with a number that looks like a measurement. These stay open instead and
  // are closed with the parent turn, which bounds the child honestly -- it ran
  // somewhere inside that window.
  const openSpawns = new Map();
  // Count a spawn once, when the step opens. A step reports ACTIVE then DONE
  // for the same step_index, and a run may end without a DONE at all, so the
  // opening transition is the only one that appears exactly once per
  // invocation. A step that carries no index cannot be de-duplicated that way,
  // and keying every such step under `undefined` would drop every spawn after
  // the first; ACTIVE alone still keeps those from being counted twice.
  const reportSpawns = (update) => {
    const toolName = String(update?.tool_name ?? update?.tool_info?.name ?? "");
    if (!isSpawnToolName(agentEvents, toolName)) return;
    if (String(update.state ?? "").toUpperCase() !== "ACTIVE") return;
    if (Number.isFinite(update.step_index)) {
      if (reportedSpawns.has(update.step_index)) return;
      reportedSpawns.add(update.step_index);
    }
    if (LOG_SPAWN_STEPS) console.error(`agy spawn step ${JSON.stringify(shapeOnly(update))}`);
    const children = spawnedChildren(update);
    console.error(`agy spawn tool=${toolName} children=${children.length} roles=${children.map(({ role }) => role ?? "unattributed").join(",")}`);
    openSpawns.set(Number.isFinite(update.step_index) ? update.step_index : children[ 0 ].id, { tool: toolName, children, startedAt: Date.now() });
    // Telemetry needs a reporter the router actually authorized; pending-child
    // tracking above does not, and must happen whether or not one exists.
    if (agentEvents) void agentEvents.reportSpawns({ tool: toolName, children });
    if (typeof agentEvents?.reportActivity === "function") {
      void agentEvents.reportActivity({ state: "subagent_wait", childIds: children.map((c) => c.id) });
    }
  };
  // Deleting the map entry is what makes a close idempotent: a key already
  // closed (by this or the flush path) has nothing left to delete, so a
  // second attempt to close the same spawn -- from a stray duplicate event,
  // or from flushSpawns running after an individual close already ran -- is a
  // no-op rather than a second telemetry post or a second decrement.
  const closeSpawn = (key, outcome) => {
    const open = openSpawns.get(key);
    if (!open) return;
    openSpawns.delete(key);
    if (agentEvents) void agentEvents.reportResults({ tool: open.tool, children: open.children, outcome, durationMs: Date.now() - open.startedAt });
    if (openSpawns.size === 0 && typeof agentEvents?.reportActivity === "function") {
      void agentEvents.reportActivity({ state: "resumed" });
    }
  };
  // A dispatch step reaching a terminal state settles the *dispatch*, not the
  // children. `DONE` means agy handed the work off successfully and the child
  // is now running, so the child stays open and is closed with the parent turn.
  // Any other terminal state means the hand-off itself failed, and a child that
  // was never dispatched has no runtime to bound -- that one closes here.
  const reportSpawnResults = (update) => {
    const toolName = String(update?.tool_name ?? update?.tool_info?.name ?? "");
    if (!isSpawnToolName(agentEvents, toolName)) return;
    const state = String(update.state ?? "").toUpperCase();
    if (!state || state === "ACTIVE" || state === "DONE" || !Number.isFinite(update.step_index)) return;
    closeSpawn(update.step_index, "failure");
  };
  // Every child still open when the turn ends closes with it. That is the
  // normal path for a successful dispatch, not an edge case.
  const flushSpawns = (outcome) => {
    for (const key of [ ...openSpawns.keys() ]) closeSpawn(key, outcome);
  };
  const observeSpawnStep = (update) => {
    reportSpawns(update);
    reportSpawnResults(update);
  };
  return { observeSpawnStep, flushSpawns, openSpawnCount: () => openSpawns.size };
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
function updateDelegationState(delegation, update, isSpawnTool) {
  if (!delegation || typeof delegation !== "object") return { kind: "unchanged" };
  // Without a spawn-tools callback we cannot classify the event, and a wrong
  // classification here would either miss the kill-on-close path or trigger
  // it falsely. Leave the tracker untouched; the bridge always passes a
  // callback in production but this keeps the helper safe under partial mocks.
  if (typeof isSpawnTool !== "function") return { kind: "unchanged" };
  const stepToolName = String(update?.tool_name ?? update?.tool_info?.name ?? "");
  const stepState = String(update?.state ?? "").toUpperCase();
  const stepIndex = Number.isFinite(update?.step_index) ? update.step_index : null;
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
  const isTerminal = stepState === "DONE" || stepState === "ERROR" || stepState === "FAILED" || stepState === "CANCELLED";
  if (isTerminal && delegation.activeStep === stepIndex) {
    const previous = delegation.activeTool;
    delegation.activeTool = null;
    delegation.activeStep = null;
    delegation.activatedAt = 0;
    return { kind: "exited", tool: previous };
  }
  return { kind: "unchanged" };
}

function isCommandStep(update) {
  const stepType = String(update?.step_type ?? "").toLowerCase();
  if (stepType === "command") return true;
  const tool = String(update?.tool_name ?? update?.tool_info?.name ?? "").toLowerCase();
  return tool === "run_command" || tool === "exec_command" || tool === "execute_command" || tool === "bash";
}

function isWaitStep(update) {
  const stepType = String(update?.step_type ?? "").toLowerCase();
  if (stepType === "wait") return true;
  const tool = String(update?.tool_name ?? update?.tool_info?.name ?? "").toLowerCase();
  return tool === "ask_question" || tool === "schedule";
}

/**
 * True while agy is either inside a delegator step, still has children the
 * spawn tracker has not closed, has active commands running, or has active waits.
 * `invoke_subagent` hands work to children and reports its own step `DONE`
 * immediately -- the dispatch finished, not the work -- so `activeTool` alone
 * goes false long before the children do. Active commands and waits keep the turn
 * live so disconnect protection and heartbeats protect in-flight execution.
 */
function isDelegationActive(delegation) {
  if (!delegation || typeof delegation !== "object") return false;
  if (delegation.activeTool) return true;
  if (Number(delegation.activeCommands) > 0 || Boolean(delegation.activeCommand)) return true;
  if (Number(delegation.activeWaits) > 0 || Boolean(delegation.activeWait)) return true;
  return Number(delegation.pendingChildren) > 0;
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
function decideCloseOnDelegation(delegation) {
  if (isDelegationActive(delegation)) {
    const activeCommands = Number(delegation?.activeCommands) || (delegation?.activeCommand ? 1 : 0);
    const activeWaits = Number(delegation?.activeWaits) || (delegation?.activeWait ? 1 : 0);
    return {
      kill: false,
      reason: "client_disconnected",
      tool: delegation?.activeTool ?? delegation?.activeCommand ?? null,
      pendingChildren: Number(delegation?.pendingChildren) || 0,
      activeCommands,
      activeWaits,
    };
  }
  return { kill: true, reason: "provider_interrupted", tool: null, pendingChildren: 0, activeCommands: 0, activeWaits: 0 };
}
function modelMetadata() {
  return {
    slug: DEFAULT_MODEL,
    apply_patch_tool_type: "freeform",
    base_instructions: "You are a bounded external-provider Codex agent.",
    display_name: "Antigravity CLI subscription",
    description: "Antigravity CLI subscription through the local Responses adapter.",
    default_reasoning_level: DEFAULT_EFFORT,
    default_reasoning_summary: "none",
    default_verbosity: "low",
    supported_reasoning_levels: [ "low", "medium", "high" ].map((effort) => ({ effort, description: `Antigravity ${effort} reasoning` })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: 1000000,
    max_context_window: 1000000,
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

function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => (typeof tool?.name === "string" ? tool.name : tool?.function?.name))
    .filter((name) => typeof name === "string");
}

/** Record what Codex offered and what the router said about this turn. */
function logInboundRequest(payload, headers) {
  if (!LOG_TOOLS) return;
  const routing = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([ key ]) => /^x-(autodev|codex)-/i.test(key)),
  );
  console.error(`[stage0] tool_names=${JSON.stringify(toolNames(payload?.tools).sort())}`);
  console.error(`[stage0] routing_headers=${JSON.stringify(routing)}`);
  for (const tool of Array.isArray(payload?.tools) ? payload.tools : []) {
    if (typeof tool?.name === "string" && tool.name.startsWith("multi_agent_v1")) {
      console.error(`[stage0] spawn_tool=${JSON.stringify(tool)}`);
    }
  }
  for (const item of Array.isArray(payload?.input) ? payload.input : []) {
    if (item?.type === "function_call" || item?.type === "function_call_output") {
      console.error(`[stage0] input_item=${JSON.stringify(item).slice(0, 2000)}`);
    }
  }
}

function resolveModel(value) {
  if (typeof value !== "string") return DEFAULT_MODEL;
  const model = value.trim();
  if (!model || model === "antigravity-subscription" || !MODEL_PATTERN.test(model)) return DEFAULT_MODEL;
  return model;
}

/** The effort a model id encodes, or null when it encodes none. */
function modelEffort(model) {
  return MODEL_EFFORT_SUFFIX.exec(model)?.[ 1 ] ?? null;
}

function resolveEffort(request) {
  const reasoning = request?.reasoning;
  const value = reasoning && typeof reasoning === "object" && "effort" in reasoning
    ? reasoning.effort
    : request?.model_reasoning_effort ?? request?.reasoning_effort;
  if (typeof value !== "string") return DEFAULT_EFFORT;
  const effort = value.trim().toLowerCase();
  if (EFFORTS.has(effort)) return effort;
  if (effort === "xhigh" || effort === "max") return "high";
  return DEFAULT_EFFORT;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map((part) => typeof part === "object" ? (part.text ?? JSON.stringify(part)) : String(part)).join("\n");
}

function promptFromInput(value, instructions) {
  if (typeof value === "string") return `${instructions}\n\n${value}`;
  if (!Array.isArray(value)) return `${instructions}\n\n${JSON.stringify(value)}`;
  const userItems = value.filter((item) => item && typeof item === "object" && (item.role === "user" || item.type === "message" && item.role === "user"));
  const items = userItems.length > 0 ? userItems : value.filter((item) => item && typeof item === "object" && ![ "developer", "system" ].includes(item.role));
  const task = items.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return JSON.stringify(item);
    return contentText(item.content ?? item.text ?? "");
  }).join("\n\n");
  return `${instructions}\n\n${task}`;
}

function responseMessageItem(text, itemId) {
  return {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [ { type: "output_text", text, annotations: [] } ]
  };
}

/**
 * Preserve the provider's terminal status and stderr when agy returns no
 * answer. A successful process with an empty `response` is not a successful
 * model turn, and reducing either case to "completed without a response
 * message" makes an intermittent provider failure impossible to diagnose.
 * Stderr is bounded because agy can echo verbose tool diagnostics.
 */
function agyPermissionFailure(stderr = "") {
  const text = String(stderr ?? "");
  const match = text.match(/tool required the ["']([^"']+)["'] permission[^\n]*auto-denied/i);
  if (!match) return {};
  return { failureCode: "AGY_PERMISSION_DENIED", failurePhase: "tool_permission", failureTool: match[ 1 ] };
}

function agyFailureMessage({ status = null, error = null, stderr = "", code = null, signal = null } = {}) {
  const details = [];
  if (status) details.push(`status ${status}`);
  if (error) details.push(String(error));
  if (signal) details.push(`signal ${signal}`);
  else if (code !== null && code !== undefined) details.push(`exit code ${code}`);
  const stderrTail = String(stderr ?? "").trim().slice(-2000);
  if (stderrTail) details.push(`stderr: ${stderrTail}`);
  return details.join("; ") || "agy returned no diagnostic details";
}

function responsePayload(model, text, result, responseId = `resp_${randomBytes(12).toString("hex")}`, itemId = `msg_${randomBytes(10).toString("hex")}`, output = null, status = "completed") {
  const usage = result?.usage ?? {};
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
      total_tokens: inputTokens + outputTokens
    }
  };
}

function sendJson(response, status, body, extraHeaders = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close", ...extraHeaders });
  response.end(encoded);
}

function sseLine(eventName, body, sequenceNumber) {
  const payload = sequenceNumber === undefined ? body : { ...body, sequence_number: sequenceNumber };
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const ANTIGRAVITY_WEB_RESEARCH_TOOLS = new Set([ "search_web", "read_url_content" ]);

function activityText(event) {
  if (event?.event !== "step_update" || !event.step_update) return "";
  const update = event.step_update;
  const state = String(update.state ?? "").toUpperCase();
  const stepType = String(update.step_type ?? "").toLowerCase();
  const toolName = String(update.tool_name ?? update.tool_info?.name ?? "tool");

  if (stepType === "tool") {
    if (toolName === "search_web") {
      if (state === "ACTIVE") return "Antigravity is searching the web.";
      if (state === "DONE") return "Antigravity finished searching the web.";
    }
    if (toolName === "read_url_content") {
      if (state === "ACTIVE") return "Antigravity is reading web URL content.";
      if (state === "DONE") return "Antigravity finished reading web URL content.";
    }
    if (state === "ACTIVE") return `Antigravity is using ${toolName}.`;
    if (state === "DONE") return `Antigravity finished ${toolName}.`;
    return `Antigravity tool ${toolName}: ${state.toLowerCase()}.`;
  }
  if (stepType === "agent_response") {
    if (state === "ACTIVE") return "Antigravity is processing the next step.";
    if (state === "DONE") return "Antigravity completed a processing step.";
  }
  if (stepType === "checkpoint" && state === "DONE") return "Antigravity reached a checkpoint.";
  return "";
}

// Delegation requests the shim collects while a turn is in flight. See
// scripts/codex/lib/bridge-spawn-session.mjs for why the session key matters.
const spawnSessions = new SpawnSessionRegistry();

/**
 * The environment an agy child runs in.
 *
 * agy has no per-invocation MCP flag -- its server list is the single global
 * `~/.gemini/config/mcp_config.json` -- so the shim cannot be told which turn
 * it belongs to through its arguments. It can be told through the environment:
 * agy spawns its MCP servers as its own children, and they inherit this. A leaf
 * turn passes an empty session, so the shim's handshake finds nothing to attach
 * to and simply does not offer the tool.
 */
function agyEnvironment(spawnSession) {
  return {
    ...process.env,
    AUTODEV_BRIDGE_URL: `http://${HOST}:${PORT}`,
    AUTODEV_BRIDGE_TOKEN: AUTH_TOKEN,
    AUTODEV_SPAWN_SESSION: spawnSession ?? "",
  };
}

function agyArgs(prompt, model, effort, agentRole = null) {
  const readOnly = roleContract(agentRole).readOnly;
  const permissionArgs = AGY_SKIP_PERMISSIONS === "true" && !readOnly ? [ "--dangerously-skip-permissions" ] : [];
  // A read-only role (validator, explorer, ...) never needs
  // --dangerously-skip-permissions -- its contract grants it no writes to
  // approve -- but leaving it on agy's interactive permission gate means a
  // headless run either hangs on a prompt nothing will ever answer, or has
  // to be started with command(*) / --dangerously-skip-permissions granted
  // anyway, which is exactly the write escalation the contract is trying to
  // keep it away from. `--sandbox` is agy's own terminal-restriction mode:
  // it runs the turn without asking, but inside restrictions instead of with
  // permissions bypassed, so a read-only role gets a headless run without
  // gaining anything a write-capable role has. Write-capable roles are
  // unaffected; they keep whatever AGY_SKIP_PERMISSIONS already decided.
  const sandboxArgs = readOnly ? [ "--sandbox" ] : [];
  // Only pass --effort when the model id does not already fix it; see
  // MODEL_EFFORT_SUFFIX.
  const effortArgs = modelEffort(model) ? [] : [ "--effort", effort ];
  return [ "-p", prompt, "--model", model, ...effortArgs, "--mode", AGY_MODE, ...permissionArgs, ...sandboxArgs, "--output-format", "stream-json", "--print-timeout", PRINT_TIMEOUT ];
}

function runAgy(prompt, model, effort, cwd, onEvent, spawnSession = null, agentRole = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, agyArgs(prompt, model, effort, agentRole), { cwd, env: agyEnvironment(spawnSession), stdio: [ "ignore", "pipe", "pipe" ] });
    let stderr = "";
    let terminalResult = null;
    let emitted = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      onEvent?.(event);
      if (event.event === "step_update") {
        const delta = String(event.step_update?.text_delta ?? "");
        if (delta) {
          emitted += delta;
          onEvent?.({ type: "text_delta", text: delta });
        }
      }
      if (event.event === "result") terminalResult = event.result ?? {};
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      const result = terminalResult ?? {};
      if (!terminalResult) {
        // The failure mode that ends long delegating turns: agy stops without
        // ever emitting a terminal result. Which of the three it was -- killed
        // because the client went away, exited on its own, or died on a signal
        // -- is only recoverable from the exit status and whatever it last
        // wrote to stderr, so all of it travels with the error instead of
        // being discarded into a bare sentence.
        const how = signal ? `on ${signal}` : `with code ${code}`;
        const tail = stderr.trim().slice(-2000);
        finish(reject, Object.assign(new Error(`agy exited ${how} without a terminal result event${tail ? `: ${tail}` : " and wrote nothing to stderr"}`), { exitCode: code, ...agyPermissionFailure(stderr) }));
        return;
      }
      if (result.status && result.status !== "SUCCESS") {
        finish(reject, Object.assign(new Error(agyFailureMessage({
          status: result.status,
          error: result.error,
          stderr,
          code,
        })), { exitCode: code, ...agyPermissionFailure(stderr) }));
        return;
      }
      if (code !== 0) {
        finish(reject, Object.assign(new Error(stderr.trim().slice(-4000) || `agy exited with code ${code}`), { exitCode: code, ...agyPermissionFailure(stderr) }));
        return;
      }
      const finalText = String(result.response ?? emitted);
      if (finalText && finalText !== emitted) {
        const suffix = finalText.startsWith(emitted) ? finalText.slice(emitted.length) : finalText;
        if (suffix) onEvent?.({ type: "text_delta", text: suffix });
      }
      if (!finalText.trim()) {
        finish(reject, Object.assign(new Error(agyFailureMessage({
          status: result.status ?? "SUCCESS",
          error: "empty response",
          stderr,
          code,
        })), agyPermissionFailure(stderr)));
        return;
      }
      finish(resolve, { text: finalText || emitted, result });
    });
    onEvent?.({ type: "process", child });
  });
}

/** Node lowercases inbound header names; intermediaries may not. */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[ key ];
  const single = Array.isArray(value) ? value[ 0 ] : value;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  try { return JSON.parse(body); } catch { return null; }
}

// The router already knows role/workspace for this request -- it chose both
// before routing here -- but has no way to correlate a failure this bridge
// reports back to the request it issued, short of diffing timestamps. The
// router-generated request id already travels on every router-issued request
// as a header (the same one AgentEventReporter authorizes telemetry from), so
// echoing it back costs nothing new to plumb and nothing that was not already
// there: no prompt text, just the identity the router itself assigned.
function agyErrorDetails(error, role, workspace, requestId = null) {
  const details = {
    type: error?.failureCode ?? "upstream_error",
    message: error?.message ?? String(error),
    provider: "antigravity",
    role: role ?? "default",
    workspace,
    requestId: requestId ?? null,
  };
  if (error?.failureCode) {
    details.code = error.failureCode;
    details.phase = error.failurePhase ?? null;
    details.tool = error.failureTool ?? null;
  }
  return details;
}

async function handle(request, response) {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", spawnSessions: spawnSessions.status() });
    return;
  }
  // The shim runs as a child of the agy process this bridge started and reaches
  // back over the same loopback port, behind the same bearer check.
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
    sendJson(response, 200, { object: "list", data: [ { id: DEFAULT_MODEL, object: "model", owned_by: "google-antigravity" } ], models: [ modelMetadata() ] });
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
  let payload;
  try { payload = JSON.parse(body); } catch { sendJson(response, 400, { error: { type: "invalid_request_error", message: "invalid JSON" } }); return; }
  const model = resolveModel(payload.model);
  const effort = resolveEffort(payload);
  // The router classifies the turn; only it can tell this bridge that it is
  // serving the root orchestrator rather than a delegated leaf.
  const agentRole = resolveAgentRole(request.headers);
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
  const spawnSession = SpawnSessionRegistry.canHold(sessionHeader, sessionScope) ? sessionHeader : null;
  // The router's own correlation id for this request. It already travels on
  // every router-issued call (AgentEventReporter is authorized from the same
  // header) so a failure this bridge reports back can be matched to the
  // router request that produced it without carrying any prompt content.
  const requestId = headerValue(request.headers, REQUEST_ID_HEADER);
  const { observeSpawnStep, flushSpawns, openSpawnCount } = createSpawnTracker(agentEvents);
  // The other half of what agy does inside its own runtime: the tools it
  // reaches for. Like delegation, none of it reaches the router as a request.
  const { observeToolStep, reportPermissionDenial } = createToolObserver(agentEvents);
  let cwd;
  try {
    cwd = resolveCwd(payload, request.headers, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    console.error(`agy workspace resolution failed: ${error.message}`);
    sendJson(response, 400, { error: { type: "invalid_request_error", message: error.message } });
    return;
  }
  if (agentRole === "browser-tester") {
    sendJson(response, 400, { error: { type: "invalid_request_error", message: "Antigravity global MCP does not support browser-tester isolation; Playwright registration and browser-tester routing are removed for agy" } });
    return;
  }
  const prompt = promptFromInput(payload.input ?? "", composeProviderPrompt(agentRole, cwd));
  // Only hold delegation state once all pre-flight validation has succeeded.
  // An invalid workspace must not leave an orphaned entry that a later shim
  // process could attach to.
  if (spawnSession) spawnSessions.open(spawnSession, { orchestrator: isOrchestratorRole(agentRole) });
  const bootstrapContract = roleContract(agentRole);
  const home = process.env.HOME ?? "";
  console.error(`agy bootstrap provider=antigravity model=${model} role=${agentRole ?? "default"} cwd=${cwd} skills=${JSON.stringify(bootstrapContract.skills ?? [])} mcp=${JSON.stringify(bootstrapContract.mcp ?? [])} permission_settings=${home}/.gemini/antigravity-cli/settings.json skill_registry=${cwd}/.agents/skills.json mcp_registry=${home}/.gemini/config/mcp_config.json`);
  console.error(`agy request model=${model} effort=${effort} role=${isOrchestratorRole(agentRole) ? "orchestrator" : "leaf"} cwd=${cwd}`);
  // Exposure, not invocation: the role contract decides which skills this turn
  // can reach before agy starts, and that decision is the fact the router
  // needs. Deriving it from what the model happened to invoke would report
  // nothing for a turn that was given skills and never reached for one --
  // exactly the case per-workspace skill attribution has to be able to show.
  if (agentEvents) {
    for (const skill of bootstrapContract.skills ?? []) {
      void agentEvents.reportSkillExposed({ skill, source: ANTIGRAVITY_SKILL_EXPOSURE_SOURCE });
    }
  }
  // A turn logged its start and nothing else, so a failed one left only the
  // step lines that happened to precede it -- the reason it died reached the
  // router as an HTTP status and was never written down anywhere. Every exit
  // from here on names itself and how long it took. The request id rides
  // along so this line can be matched to the router's own log of the same
  // request without exposing anything the router did not already assign.
  const turnStartedAt = Date.now();
  const elapsed = () => `${((Date.now() - turnStartedAt) / 1000).toFixed(1)}s`;
  const logTurnEnd = (outcome, detail = "") => console.error(`agy turn ${outcome} after ${elapsed()} request=${requestId ?? "none"}${detail ? `: ${detail}` : ""}`);

  if (!payload.stream) {
    try {
      const nonStreamHeartbeat = setInterval(() => {
        if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
          void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
        }
      }, 5000);
      let result;
      try {
        result = await runAgy(prompt, model, effort, cwd, (event) => {
          if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
            void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
          }
          if (event.event === "step_update") {
            observeSpawnStep(event.step_update ?? {});
            observeToolStep(event.step_update ?? {});
          }
        }, spawnSession, agentRole);
      } finally {
        clearInterval(nonStreamHeartbeat);
      }
      const spawnChildren = spawnSession ? spawnSessions.close(spawnSession) : [];
      const output = [ responseMessageItem(result.text, `msg_${randomBytes(10).toString("hex")}`) ];
      if (spawnChildren.length > 0) {
        const spawnEvents = execToolCallSseEvents({
          itemId: mintCallItemId(),
          callId: mintCallId(spawnSession, output.length),
          source: buildSpawnScript(spawnChildren, { recoverParentId: spawnSession }),
          outputIndex: output.length,
        });
        output.push(spawnEvents.at(-1)[ 1 ].item);
        console.error(`agy delegating ${spawnChildren.length} subagent(s) through Codex`);
      }
      logTurnEnd("succeeded");
      if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
      sendJson(response, 200, responsePayload(payload.model ?? model, result.text, result.result, undefined, undefined, output));
    } catch (error) {
      if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "failed" });
      flushSpawns("failure");
      reportPermissionDenial(error);
      if (spawnSession) spawnSessions.close(spawnSession);
      logTurnEnd("failed", error.message ?? String(error));
      sendJson(response, 502, { error: agyErrorDetails(error, agentRole, cwd, requestId) });
    }
    return;
  }

  const responseId = `resp_${randomBytes(12).toString("hex")}`;
  const reasoningId = `rs_${randomBytes(12).toString("hex")}`;
  const itemId = `msg_${randomBytes(10).toString("hex")}`;
  const activityParts = [];
  const seenActivities = new Set();
  // Exactly what this client already received, so flushing it on a failure is
  // truthful by construction rather than a second guess at the turn's output.
  let partialText = "";
  let sequenceNumber = 0;
  let streamStarted = false;
  const pendingEvents = [];
  let clientClosed = false;
  const isWritable = () => !clientClosed && !response.writableEnded && !response.destroyed && !response.closed;
  const emit = (eventName, body) => {
    const event = sseLine(eventName, { ...body, sequence_number: ++sequenceNumber });
    if (!isWritable()) return;
    if (streamStarted) {
      try { response.write(event); } catch { }
    } else {
      pendingEvents.push(event);
    }
  };
  const startStream = () => {
    if (streamStarted || !isWritable()) return;
    streamStarted = true;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    response.flushHeaders();
    response.shouldKeepAlive = false;
    for (const event of pendingEvents.splice(0)) {
      if (!isWritable()) break;
      try { response.write(event); } catch { }
    }
  };
  const emitActivity = (text, key = text) => {
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
  emit("response.created", { type: "response.created", response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: payload.model ?? model, status: "in_progress", output: [] } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: reasoningId, type: "reasoning", status: "in_progress", summary: [], content: [] } });
  emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
  emit("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  emitActivity("Antigravity started processing.", "initial");

  // Set once the turn has produced its final event, so the close that always
  // follows a completed stream is not reported as the client hanging up.
  let turnSettled = false;
  // Tracks the most recent spawn-step tool the bridge saw from agy, and how
  // many of the children it dispatched the spawn tracker still has open.
  // Active spawn steps and open children are both the dangerous case: the
  // parent agy process is waiting on work the bridge's SSE stream cannot see
  // (only keep-alives), and any of the upstream idle / wall-clock ceilings
  // will close the connection. `activeTool` alone is not enough to detect
  // this: `invoke_subagent` reports its own step `DONE` as soon as the
  // hand-off succeeds, long before the children it dispatched finish, so
  // `pendingChildren` -- kept in sync with the spawn tracker's
  // `openSpawnCount()` below -- is what keeps this true for the rest of the
  // children's run. Killing agy in that window also kills the children and
  // strands any work they had buffered, so we let agy run to its
  // PRINT_TIMEOUT instead and surface the cause as
  // INCOMPLETE_REASON_CLIENT_DISCONNECTED. The launchd log distinguishes the
  // two cases by name. An ordinary disconnected turn -- no delegator ever
  // ran, or every dispatched child has already closed -- is still killed.
  const delegation = {
    activeTool: null,
    activeStep: null,
    activatedAt: 0,
    pendingChildren: 0,
    activeCommands: 0,
    activeWaits: 0,
  };
  const activeCommands = new Set();
  const activeWaits = new Set();
  let clientDisconnectMidDelegation = false;
  let clientDisconnectDetail = "";
  // Synthetic activity the bridge emits while agy is mid-delegation, so the
  // Codex-side idle / wall-clock timers see real Responses traffic rather
  // than only SSE comment keep-alives. The 2-second keep-alive above is not
  // counted as data by every fetch client; emitting a real event every 30 s
  // gives the upstream something it cannot strip.
  let delegationHeartbeat = null;
  const startDelegationHeartbeat = () => {
    if (delegationHeartbeat) return;
    let tick = 0;
    delegationHeartbeat = setInterval(() => {
      if (typeof agentEvents?.reportHeartbeat === "function") {
        void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
      }
      if (!isDelegationActive(delegation) || !streamStarted || !isWritable()) return;
      tick += 1;
      try {
        emit("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoningId,
          output_index: 0,
          summary_index: 0,
          delta: ` (delegation heartbeat ${tick}; agy still working)\n`,
        });
      } catch { }
    }, 30_000);
  };
  const stopDelegationHeartbeat = () => {
    if (!delegationHeartbeat) return;
    clearInterval(delegationHeartbeat);
    delegationHeartbeat = null;
  };
  const delegationDetail = (decision) => decision.tool
    ? `during ${decision.tool}`
    : decision.pendingChildren > 0
    ? `while ${decision.pendingChildren} delegated child(ren) were still running`
    : decision.activeCommands > 0
    ? `while ${decision.activeCommands} active command(s) were still running`
    : decision.activeWaits > 0
    ? `while ${decision.activeWaits} active wait(s) were pending`
    : "while active commands or waits were still running";
  const onResponseError = () => {
    clientClosed = true;
    clearInterval(keepAlive);
    stopDelegationHeartbeat();
    const errorDecision = decideCloseOnDelegation(delegation);
    if (!errorDecision.kill) {
      clientDisconnectMidDelegation = true;
      clientDisconnectDetail = `the client connection errored ${delegationDetail(errorDecision)}; agy will continue to print-timeout`;
      if (!turnSettled) logTurnEnd("aborted-delegation", clientDisconnectDetail);
      // Do NOT kill agy: the cause was the upstream going away while agy was
      // delegating, and killing agy here strands the children it had spawned.
      // runAgy will keep awaiting agy's natural completion; whatever it
      // produces is discarded because the upstream is already gone.
      return;
    }
    if (!turnSettled) logTurnEnd("aborted", "the client connection errored; agy was killed mid-turn");
    if (child && !child.killed) child.kill("SIGTERM");
  };
  response.on("error", onResponseError);

  const keepAlive = setInterval(() => {
    if (typeof agentEvents?.reportHeartbeat === "function") {
      void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }
    if (streamStarted && isWritable()) {
      try { response.write(": agy-bridge keep-alive\n\n"); } catch { }
    }
  }, 2000);
  let child;
  response.on("close", () => {
    clientClosed = true;
    clearInterval(keepAlive);
    stopDelegationHeartbeat();
    response.removeListener("error", onResponseError);
    // The router aborting its upstream fetch -- its 15-minute timeout, or its
    // own client going away -- reaches this bridge as nothing but a closed
    // socket. Naming it is the difference between "agy died", "agy was
    // killed because nobody was listening any more", and "agy was delegating
    // when nobody was listening any more" -- the third case is the one that
    // was killing long-running orchestrator turns in the antigravity path
    // before this branch was added.
    const closeDecision = decideCloseOnDelegation(delegation);
    if (!closeDecision.kill) {
      clientDisconnectMidDelegation = true;
      clientDisconnectDetail = `the client disconnected ${delegationDetail(closeDecision)}; agy will continue to print-timeout`;
      if (!turnSettled) logTurnEnd("aborted-delegation", clientDisconnectDetail);
      // Do NOT kill agy for the same reason as onResponseError above.
      return;
    }
    if (!turnSettled) logTurnEnd("aborted", "the client disconnected; agy was killed mid-turn");
    if (child && !child.killed) child.kill("SIGTERM");
  });
  try {
    const result = await runAgy(prompt, model, effort, cwd, (event) => {
      if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
        void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
      }
      if (event.type === "process") { child = event.child; return; }
      if (event.type === "text_delta") {
        startStream();
        partialText += event.text;
        emit("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, delta: event.text, content_index: 0, output_index: 1 });
      }
      if (event.event === "step_update") {
        const update = event.step_update ?? {};
        const stepToolName = String(update?.tool_name ?? update?.tool_info?.name ?? "");
        const stepState = String(update?.state ?? "").toUpperCase();
        const stepIndex = Number.isFinite(update?.step_index) ? update.step_index : (stepToolName || "unknown");

        if (isCommandStep(update)) {
          if (stepState === "ACTIVE") activeCommands.add(stepIndex);
          else if (stepState === "DONE" || stepState === "ERROR" || stepState === "FAILED" || stepState === "CANCELLED") activeCommands.delete(stepIndex);
        }
        if (isWaitStep(update)) {
          if (stepState === "ACTIVE") activeWaits.add(stepIndex);
          else if (stepState === "DONE" || stepState === "ERROR" || stepState === "FAILED" || stepState === "CANCELLED") activeWaits.delete(stepIndex);
        }
        delegation.activeCommands = activeCommands.size;
        delegation.activeWaits = activeWaits.size;

        observeSpawnStep(update);
        observeToolStep(update);
        // Kept in sync on every step so a dispatch step's own DONE -- which
        // clears activeTool below -- does not read as "delegation over" while
        // the spawn tracker still has children it dispatched open.
        delegation.pendingChildren = openSpawnCount();
        const activity = activityText(event);
        const key = `${update.step_index ?? "?"}:${update.state ?? "?"}:${update.step_type ?? "?"}:${update.tool_name ?? ""}`;
        if (activity) {
          // A step_update is provider-produced work, so the turn is genuinely
          // under way: commit to the SSE stream and let the parent watch the
          // activity live. Synthetic pre-run activity stays buffered so a
          // provider that fails before doing anything can still be reported
          // as an HTTP status the router can fall back on.
          startStream();
          emitActivity(activity, key);
        }
        // Track the most recent delegator step so response.on("close") and
        // response.on("error") can tell a turn that aborted during delegation
        // apart from one that aborted before delegation started. The
        // synthetic heartbeat rides on the same flag. isSpawnToolName falls
        // back to agy's own tool name when the router sent no reporter, so
        // this classification -- and therefore the kill decision -- still
        // works when the telemetry headers are absent.
        const transition = updateDelegationState(delegation, update, (name) => isSpawnToolName(agentEvents, name));
        if (transition.kind === "entered" || isDelegationActive(delegation)) startDelegationHeartbeat();
        // The dispatch step closing does not by itself mean delegation is
        // over: only stop the heartbeat once the spawn tracker agrees no
        // dispatched children are still open.
        if (transition.kind === "exited" && !isDelegationActive(delegation)) stopDelegationHeartbeat();
        if (update.step_type === "tool") console.error(`agy tool=${update.tool_name ?? "unknown"}`);
      }
    }, spawnSession, agentRole);
    clearInterval(keepAlive);
    stopDelegationHeartbeat();
    flushSpawns("success");
    delegation.pendingChildren = openSpawnCount();
    activeCommands.clear();
    activeWaits.clear();
    delegation.activeCommands = 0;
    delegation.activeWaits = 0;
    // If the upstream closed mid-delegation, the run still completes here --
    // agy got its full PRINT_TIMEOUT -- but the parent is gone. Emit an
    // incomplete event carrying the cause so any future re-attach can replay
    // the work; for now the bytes go nowhere because isWritable() is false.
    if (clientDisconnectMidDelegation) {
      turnSettled = true;
      logTurnEnd("succeeded-mid-delegation", `agy finished after upstream close: ${clientDisconnectDetail}`);
      if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
      for (const [ eventName, body ] of terminalIncompleteEvents({
        responseId,
        itemId,
        reasoningId,
        text: result.text ?? partialText,
        reasoningText: activityParts.join("\n"),
        reason: INCOMPLETE_REASON_CLIENT_DISCONNECTED,
        limit: null,
        provider: "antigravity",
        response: responsePayload(payload.model ?? model, result.text ?? partialText, null, responseId, itemId, [], "incomplete"),
      })) {
        if (isWritable()) emit(eventName, body);
      }
      if (isWritable()) {
        try { response.end("data: [DONE]\n\n"); } catch { }
      }
      return;
    }
    startStream();
    const reasoningText = activityParts.join("\n");
    const completedReasoning = { id: reasoningId, type: "reasoning", status: "completed", summary: [ { type: "summary_text", text: reasoningText } ], content: [] };
    const completedMessage = responseMessageItem(result.text, itemId);
    const completed = responsePayload(payload.model ?? model, result.text, result.result, responseId, itemId, [ completedReasoning, completedMessage ]);
    emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: 0, summary_index: 0, text: reasoningText });
    emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: reasoningText } });
    emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: completedReasoning });
    emit("response.output_text.done", { type: "response.output_text.done", item_id: itemId, text: result.text, content_index: 0, output_index: 1 });
    emit("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: result.text, annotations: [] } });
    emit("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: completedMessage });
    // Delegation this turn asked for, collected out-of-band by the shim while
    // agy ran. Emitted as one `exec` call after the message so Codex creates
    // the children itself and they become sessions the app can show.
    const spawnChildren = spawnSession ? spawnSessions.close(spawnSession) : [];
    if (spawnChildren.length > 0) {
      const source = buildSpawnScript(spawnChildren, { recoverParentId: spawnSession });
      const spawnEvents = execToolCallSseEvents({
        itemId: mintCallItemId(),
        callId: mintCallId(spawnSession, completed.output.length),
        source,
        outputIndex: completed.output.length,
      });
      for (const [ name, event ] of spawnEvents) emit(name, event);
      completed.output.push(spawnEvents.at(-1)[ 1 ].item);
      console.error(`agy delegating ${spawnChildren.length} subagent(s) through Codex`);
    }
    emit("response.completed", { type: "response.completed", response: completed });
    turnSettled = true;
    if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
    logTurnEnd("succeeded");
    if (isWritable()) {
      try { response.end("data: [DONE]\n\n"); } catch { }
    }
  } catch (error) {
    clearInterval(keepAlive);
    stopDelegationHeartbeat();
    flushSpawns("failure");
    activeCommands.clear();
    activeWaits.clear();
    delegation.activeCommands = 0;
    delegation.activeWaits = 0;
    if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "failed" });
    // Reported before the writability check below returns: a permission gap is
    // a fact about the workspace, not about whether the parent is still
    // listening, and it is the only unavailability agy ever states out loud.
    reportPermissionDenial(error);
    delegation.pendingChildren = openSpawnCount();
    const message = error.message ?? String(error);
    // Logged before the writability check: a turn that failed *because* the
    // client had already gone is exactly the case worth seeing, and it used to
    // return here without a word.
    if (!turnSettled) logTurnEnd("failed", `${message}${isWritable() ? "" : " (client already gone)"}`);
    turnSettled = true;
    if (!isWritable()) return;
    // agy reports a usage limit as nothing but an error string, so this is the
    // one place the difference between "out of quota" and "the CLI crashed" can
    // be recovered. It is only ever `inferred`, never enough on its own to take
    // the provider out for a long cooldown, but it is enough to pick a status
    // the router can act on and a retry hint it can size a wait against.
    const limit = classifyCliLimit(message, error.exitCode);
    if (!streamStarted) {
      const status = limit && [ "throttled", "session_limit", "quota_exhausted" ].includes(limit.limitClass) ? 429 : 503;
      const headers = limitResponseHeaders(limit);
      const retryAfter = retryAfterSecondsFromLimit(limit);
      if (retryAfter !== null) headers[ "retry-after" ] = String(retryAfter);
      const body = { error: agyErrorDetails(error, agentRole, cwd, requestId) };
      const declaredLimit = limitPayload(limit);
      if (declaredLimit) body.error.limit = declaredLimit;
      sendJson(response, status, body, headers);
      return;
    }
    // A failure after the stream opened cannot be replayed on another provider,
    // so the work already sent is all the parent will ever get for this turn --
    // and it used to be discarded with a bare `response.failed`. Close the turn
    // as incomplete instead, carrying that work and saying why it stopped. The
    // turn is still not completed, so the router still counts it as a failure.
    for (const [ eventName, body ] of terminalIncompleteEvents({
      responseId,
      itemId,
      reasoningId,
      text: partialText,
      reasoningText: activityParts.join("\n"),
      reason: limit ? INCOMPLETE_REASON_PROVIDER_LIMIT : INCOMPLETE_REASON_INTERRUPTED,
      limit,
      provider: "antigravity",
      response: responsePayload(payload.model ?? model, partialText, null, responseId, itemId, [], "incomplete"),
    })) emit(eventName, body);
    if (isWritable()) {
      try { response.end("data: [DONE]\n\n"); } catch { }
    }
  } finally {
    clearInterval(keepAlive);
    response.removeListener("error", onResponseError);
    // The registry must not outlive the turn on any path. A stale entry would
    // accept a delegation from a CLI that outlived its request and attach it to
    // nothing, or -- on a reused session key -- to the next turn. Closing twice
    // is harmless; the success path has already drained it.
    if (spawnSession) spawnSessions.close(spawnSession);
  }
}

if (IS_MAIN) {
  createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
    console.error(`Antigravity Responses proxy listening at http://${HOST}:${PORT}`);
  });
}

export { ANTIGRAVITY_SKILL_EXPOSURE_SOURCE, ANTIGRAVITY_WEB_RESEARCH_TOOLS, agyArgs, agyErrorDetails, agyFailureMessage, agyPermissionFailure, antigravityToolServer, createSpawnTracker, createToolObserver, decideCloseOnDelegation, extractSkillReadPath, isCommandStep, isDelegationActive, isWaitStep, matchSkillReadPath, modelEffort, promptFromInput, resolveEffort, resolveModel, spawnedChildren, subagentModel, toolStepEvidence, updateDelegationState };
