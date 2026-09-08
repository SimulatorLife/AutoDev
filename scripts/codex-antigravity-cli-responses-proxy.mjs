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
import { bridgeInstructions, isOrchestratorRole, resolveAgentRole } from "./codex/lib/bridge-role.mjs";
import { roleContract } from "./codex/lib/execution-contract.mjs";
import { classifyCliLimit, INCOMPLETE_REASON_CLIENT_DISCONNECTED, INCOMPLETE_REASON_INTERRUPTED, INCOMPLETE_REASON_PROVIDER_LIMIT, limitPayload, limitResponseHeaders, retryAfterSecondsFromLimit, terminalIncompleteEvents } from "./codex/lib/provider-limits.mjs";
import { resolveAgentEventReporter } from "./codex/lib/agent-events.mjs";
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

/**
 * Tracks the subagents one agy turn dispatches, so each is reported once when it
 * starts and once when it ends.
 *
 * Extracted from the request handler because the lifecycle below is subtle and
 * was wrong: it treated the dispatch step's completion as the child's, which is
 * exactly the kind of mistake that needs a test able to reach it.
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
    if (!agentEvents?.isSpawnTool(toolName)) return;
    if (String(update.state ?? "").toUpperCase() !== "ACTIVE") return;
    if (Number.isFinite(update.step_index)) {
      if (reportedSpawns.has(update.step_index)) return;
      reportedSpawns.add(update.step_index);
    }
    if (LOG_SPAWN_STEPS) console.error(`agy spawn step ${JSON.stringify(shapeOnly(update))}`);
    const children = spawnedChildren(update);
    console.error(`agy spawn tool=${toolName} children=${children.length} roles=${children.map(({ role }) => role ?? "unattributed").join(",")}`);
    openSpawns.set(Number.isFinite(update.step_index) ? update.step_index : children[ 0 ].id, { tool: toolName, children, startedAt: Date.now() });
    void agentEvents.reportSpawns({ tool: toolName, children });
  };
  const closeSpawn = (key, outcome) => {
    const open = openSpawns.get(key);
    if (!open) return;
    openSpawns.delete(key);
    void agentEvents.reportResults({ tool: open.tool, children: open.children, outcome, durationMs: Date.now() - open.startedAt });
  };
  // A dispatch step reaching a terminal state settles the *dispatch*, not the
  // children. `DONE` means agy handed the work off successfully and the child
  // is now running, so the child stays open and is closed with the parent turn.
  // Any other terminal state means the hand-off itself failed, and a child that
  // was never dispatched has no runtime to bound -- that one closes here.
  const reportSpawnResults = (update) => {
    const toolName = String(update?.tool_name ?? update?.tool_info?.name ?? "");
    if (!agentEvents?.isSpawnTool(toolName)) return;
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

/**
 * Decide what a response.on("close") / response.on("error") handler should
 * do given the current delegation tracker. Pure helper so the close handler
 * and tests share one decision point.
 */
function decideCloseOnDelegation(delegation) {
  if (delegation?.activeTool) {
    return { kill: false, reason: "client_disconnected", tool: delegation.activeTool };
  }
  return { kill: true, reason: "provider_interrupted", tool: null };
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
    experimental_supported_tools: [],
    support_verbosity: false,
    supports_parallel_tool_calls: false,
    supports_search_tool: false,
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

function activityText(event) {
  if (event?.event !== "step_update" || !event.step_update) return "";
  const update = event.step_update;
  const state = String(update.state ?? "").toUpperCase();
  const stepType = String(update.step_type ?? "").toLowerCase();
  const toolName = String(update.tool_name ?? update.tool_info?.name ?? "tool");

  if (stepType === "tool") {
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
  const permissionArgs = AGY_SKIP_PERMISSIONS === "true" && !roleContract(agentRole).readOnly ? [ "--dangerously-skip-permissions" ] : [];
  // Only pass --effort when the model id does not already fix it; see
  // MODEL_EFFORT_SUFFIX.
  const effortArgs = modelEffort(model) ? [] : [ "--effort", effort ];
  return [ "-p", prompt, "--model", model, ...effortArgs, "--mode", AGY_MODE, ...permissionArgs, "--output-format", "stream-json", "--print-timeout", PRINT_TIMEOUT ];
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
        finish(reject, Object.assign(new Error(`agy exited ${how} without a terminal result event${tail ? `: ${tail}` : " and wrote nothing to stderr"}`), { exitCode: code }));
        return;
      }
      if (result.status && result.status !== "SUCCESS") {
        const tail = stderr.trim().slice(-2000);
        finish(reject, new Error(result.error ?? `agy ended with status ${result.status}${tail ? `: ${tail}` : ""}`));
        return;
      }
      if (code !== 0) {
        finish(reject, Object.assign(new Error(stderr.trim().slice(-4000) || `agy exited with code ${code}`), { exitCode: code }));
        return;
      }
      const finalText = String(result.response ?? emitted);
      if (finalText && finalText !== emitted) {
        const suffix = finalText.startsWith(emitted) ? finalText.slice(emitted.length) : finalText;
        if (suffix) onEvent?.({ type: "text_delta", text: suffix });
      }
      if (!finalText.trim()) {
        finish(reject, new Error("agy completed without a response message"));
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
  if (spawnSession) spawnSessions.open(spawnSession, { orchestrator: isOrchestratorRole(agentRole) });
  const { observeSpawnStep, flushSpawns } = createSpawnTracker(agentEvents);
  const prompt = promptFromInput(payload.input ?? "", bridgeInstructions(agentRole));
  let cwd;
  try {
    cwd = resolveCwd(payload, request.headers, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    console.error(`agy workspace resolution failed: ${error.message}`);
    sendJson(response, 400, { error: { type: "invalid_request_error", message: error.message } });
    return;
  }
  console.error(`agy request model=${model} effort=${effort} role=${isOrchestratorRole(agentRole) ? "orchestrator" : "leaf"} cwd=${cwd}`);
  // A turn logged its start and nothing else, so a failed one left only the
  // step lines that happened to precede it -- the reason it died reached the
  // router as an HTTP status and was never written down anywhere. Every exit
  // from here on names itself and how long it took.
  const turnStartedAt = Date.now();
  const elapsed = () => `${((Date.now() - turnStartedAt) / 1000).toFixed(1)}s`;
  const logTurnEnd = (outcome, detail = "") => console.error(`agy turn ${outcome} after ${elapsed()}${detail ? `: ${detail}` : ""}`);

  if (!payload.stream) {
    try {
      const result = await runAgy(prompt, model, effort, cwd, (event) => {
        if (event.event === "step_update") observeSpawnStep(event.step_update ?? {});
      }, spawnSession, agentRole);
      const spawnChildren = spawnSession ? spawnSessions.close(spawnSession) : [];
      const output = [ responseMessageItem(result.text, `msg_${randomBytes(10).toString("hex")}`) ];
      if (spawnChildren.length > 0) {
        const spawnEvents = execToolCallSseEvents({
          itemId: mintCallItemId(),
          callId: mintCallId(spawnSession, output.length),
          source: buildSpawnScript(spawnChildren),
          outputIndex: output.length,
        });
        output.push(spawnEvents.at(-1)[ 1 ].item);
        console.error(`agy delegating ${spawnChildren.length} subagent(s) through Codex`);
      }
      logTurnEnd("succeeded");
      sendJson(response, 200, responsePayload(payload.model ?? model, result.text, result.result, undefined, undefined, output));
    } catch (error) {
      flushSpawns("failure");
      logTurnEnd("failed", error.message ?? String(error));
      sendJson(response, 502, { error: { type: "upstream_error", message: error.message ?? String(error) } });
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
  // Tracks the most recent spawn-step tool the bridge saw from agy. Active
  // spawn steps are the dangerous case: the parent agy process is waiting for
  // its children, the bridge's SSE stream is idle (only keep-alives), and any
  // of the upstream idle / wall-clock ceilings will close the connection.
  // Killing agy in that window also kills the children and strands any work
  // they had buffered, so we let agy run to its PRINT_TIMEOUT instead and
  // surface the cause as INCOMPLETE_REASON_CLIENT_DISCONNECTED. The launchd
  // log distinguishes the two cases by name.
  const delegation = {
    activeTool: null,
    activeStep: null,
    activatedAt: 0,
  };
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
      if (!delegation.activeTool || !streamStarted || !isWritable()) return;
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
  const onResponseError = () => {
    clientClosed = true;
    clearInterval(keepAlive);
    stopDelegationHeartbeat();
    const errorDecision = decideCloseOnDelegation(delegation);
    if (!errorDecision.kill) {
      clientDisconnectMidDelegation = true;
      clientDisconnectDetail = `the client connection errored during ${errorDecision.tool}; agy will continue to print-timeout`;
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
      clientDisconnectDetail = `the client disconnected during ${closeDecision.tool}; agy will continue to print-timeout`;
      if (!turnSettled) logTurnEnd("aborted-delegation", clientDisconnectDetail);
      // Do NOT kill agy for the same reason as onResponseError above.
      return;
    }
    if (!turnSettled) logTurnEnd("aborted", "the client disconnected; agy was killed mid-turn");
    if (child && !child.killed) child.kill("SIGTERM");
  });
  try {
    const result = await runAgy(prompt, model, effort, cwd, (event) => {
      if (event.type === "process") { child = event.child; return; }
      if (event.type === "text_delta") {
        startStream();
        partialText += event.text;
        emit("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, delta: event.text, content_index: 0, output_index: 1 });
      }
      if (event.event === "step_update") {
        const update = event.step_update ?? {};
        observeSpawnStep(update);
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
        // synthetic heartbeat rides on the same flag.
        const transition = updateDelegationState(delegation, update, (name) => agentEvents?.isSpawnTool(name) ?? false);
        if (transition.kind === "entered") startDelegationHeartbeat();
        if (transition.kind === "exited") stopDelegationHeartbeat();
        if (update.step_type === "tool") console.error(`agy tool=${update.tool_name ?? "unknown"}`);
      }
    }, spawnSession, agentRole);
    clearInterval(keepAlive);
    stopDelegationHeartbeat();
    flushSpawns("success");
    // If the upstream closed mid-delegation, the run still completes here --
    // agy got its full PRINT_TIMEOUT -- but the parent is gone. Emit an
    // incomplete event carrying the cause so any future re-attach can replay
    // the work; for now the bytes go nowhere because isWritable() is false.
    if (clientDisconnectMidDelegation) {
      turnSettled = true;
      logTurnEnd("succeeded-mid-delegation", `agy finished after upstream close: ${clientDisconnectDetail}`);
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
      const source = buildSpawnScript(spawnChildren);
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
    logTurnEnd("succeeded");
    if (isWritable()) {
      try { response.end("data: [DONE]\n\n"); } catch { }
    }
  } catch (error) {
    clearInterval(keepAlive);
    stopDelegationHeartbeat();
    flushSpawns("failure");
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
      const body = { error: { type: "upstream_error", message } };
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

export { agyArgs, createSpawnTracker, decideCloseOnDelegation, modelEffort, resolveEffort, resolveModel, spawnedChildren, subagentModel, updateDelegationState };
