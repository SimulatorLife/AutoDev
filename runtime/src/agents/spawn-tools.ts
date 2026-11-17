/**
 * Driving Codex's own subagent spawner from a provider bridge.
 *
 * A child spawned inside a CLI bridge's runtime is invisible to Codex: no child
 * thread exists, so the app has nothing to render and the router only ever
 * learns about it through the `/v1/agent-events` side channel. The only way to
 * get a real, clickable, nested session is to make Codex core do the spawning
 * -- which means the bridge has to issue Codex's own spawn call.
 *
 * That call is not a `function_call`. Codex runs these models in *code mode*:
 * the request carries no `tools` array at all, and the entire tool surface
 * arrives as one `exec` custom tool whose input is raw JavaScript, evaluated in
 * a V8 isolate where the real tools hang off a `tools` global. `spawn_agent`
 * is one of those globals and is never named in the request, so there is
 * nothing to discover from the payload and nothing to un-flatten on the way
 * back -- the bridge emits an `exec` call and writes the JavaScript itself.
 *
 * Everything here was verified against a live Codex (0.153.1) and against
 * recorded rollouts of GPT-served orchestrator turns that spawned successfully:
 *
 *   - the spawn argument is `{ agent_type, message }`. Passing `agent` instead
 *     is silently ignored and yields a generic agent, which is why that
 *     spelling is not accepted here.
 *   - one `exec` call can spawn many agents by awaiting `Promise.allSettled`
 *     over the batch, so fan-out does not need parallel tool calls and one
 *     rejected child does not erase siblings that were already created. This
 *     matters because Codex sends `parallel_tool_calls: false` on the wire
 *     regardless of what the model catalog advertises.
 *   - each spawn resolves to `{ agent_id, nickname }`, and `agent_id` is the
 *     thread id the app links to.
 */

import { createHash, randomBytes } from "node:crypto";

import { readOpenChildThreads } from "@simulatorlife/autodev-runtime/router/codex-state-collector";
import { getDefaultConcurrencyManager } from "@simulatorlife/autodev-runtime/router/concurrency";
import {
  EXEC_TOOL,
  MULTI_AGENT_CLOSE_TOOL,
  MULTI_AGENT_SEND_INPUT_TOOL,
  MULTI_AGENT_SPAWN_TOOL,
  MULTI_AGENT_WAIT_TOOL
} from "@simulatorlife/autodev-runtime/shared/tool-names";

// How long `exec` may run before Codex yields the script back. Spawning is
// effectively instantaneous -- the observed wall time for a three-agent batch
// was 0.8s -- so this only has to cover a slow batch, not a child's lifetime.
// The children keep running after the script returns.
const DEFAULT_YIELD_MS = 60_000;

// `wait_agent` rejects a timeout below 10s. A completed or errored child
// answers at once, so this only bounds how long a running child is probed;
// the probes run in parallel, so it bounds the whole preflight too.
const WAIT_PROBE_MS = 10_000;

export interface SpawnChild {
  agentType?: string | null;
  message: string;
  target?: string | null;
}

export interface SpawnScriptOptions {
  yieldTimeMs?: number;
  /** This parent's open child handles, oldest first. */
  ownedChildIds?: readonly string[];
  maxCapacity?: number | null;
}

export interface RecoveryScriptOptions {
  /** This parent's open child handles, oldest first. */
  ownedChildIds: readonly string[];
  maxCapacity: number | null;
  newSlotsNeeded: number;
  reusedTargets?: readonly string[];
}

/**
 * One Codex `exec` call.
 *
 * It carries an index signature because the item crosses into the SSE
 * payload shapes the provider bridges serialize, and those are plain JSON
 * records.
 */
export interface CustomToolCallItem extends Record<string, unknown> {
  id: string;
  type: "custom_tool_call";
  call_id: string;
  name: typeof EXEC_TOOL;
  input: string;
  status: "in_progress" | "completed";
}

interface AddedToolCallPayload {
  type: "response.output_item.added";
  output_index: number;
  item: Omit<CustomToolCallItem, "input" | "status"> & {
    input: "";
    status: "in_progress";
  };
}

interface ToolCallInputDeltaPayload {
  type: "response.custom_tool_call_input.delta";
  item_id: string;
  output_index: number;
  delta: string;
}

interface ToolCallInputDonePayload {
  type: "response.custom_tool_call_input.done";
  item_id: string;
  output_index: number;
  input: string;
}

interface CompletedToolCallPayload {
  type: "response.output_item.done";
  output_index: number;
  item: CustomToolCallItem;
}

export type ExecToolCallSseEvent = readonly [
  ["response.output_item.added", AddedToolCallPayload],
  ["response.custom_tool_call_input.delta", ToolCallInputDeltaPayload],
  ["response.custom_tool_call_input.done", ToolCallInputDonePayload],
  ["response.output_item.done", CompletedToolCallPayload]
];

export interface SpawnToolCallOutput {
  childCount: number;
  /** The completed `exec` item, for a bridge that emits items itself. */
  item: CustomToolCallItem;
  events: ExecToolCallSseEvent;
}

export function resolveAuthoritativeCapacity(): number | null {
  try {
    return getDefaultConcurrencyManager().effectivePerSessionLimit();
  } catch {
    return null;
  }
}

/**
 * The parent's open child handles, oldest first, from Codex's own state.
 *
 * Codex keeps a `thread_spawn_edges` row `open` until `close_agent`, so these
 * are exactly the handles holding the parent's concurrency slots -- whichever
 * bridge process, compaction or restart the parent has been through.
 */
export function resolveOwnedChildIds(parentId: string): string[] {
  return readOpenChildThreads(parentId).map((child) => child.childId);
}

/**
 * JavaScript preflight that frees concurrency slots for a spawn batch.
 *
 * It is emitted only when the batch would not fit: this parent's open handles
 * plus the new children exceed the session limit. Every owned child is probed
 * in parallel (`wait_agent`'s minimum timeout bounds the whole preflight);
 * errored or shut-down handles are closed, then the oldest completed (parked)
 * handles are evicted until the batch fits. A running child is never closed,
 * and a handle the batch is reusing is neither probed nor evicted. When the
 * batch still cannot fit, the spawn calls are refused up front rather than
 * left to fail one by one.
 *
 * The ids come from Codex's spawn edges for this parent only, so a foreign
 * parent's child can never be touched. Returns an empty string when there is
 * no pressure to relieve.
 */
export function buildRecoveryScript({
  ownedChildIds,
  maxCapacity,
  newSlotsNeeded,
  reusedTargets = []
}: RecoveryScriptOptions): string {
  const owned = [...new Set(ownedChildIds.map((id) => id.trim()))].filter(
    Boolean
  );
  if (
    maxCapacity === null ||
    newSlotsNeeded <= 0 ||
    owned.length + newSlotsNeeded <= maxCapacity
  ) {
    return "";
  }
  const reused = new Set(reusedTargets);
  const probed = owned.filter((id) => !reused.has(id));
  const reusedCount = owned.length - probed.length;

  return [
    `const recoveryOwned = ${JSON.stringify(probed)};`,
    `const recoveryFree = ${maxCapacity} - ${reusedCount} - ${newSlotsNeeded};`,
    "const recoveryProbes = await Promise.all(recoveryOwned.map(async (childId) => {",
    `  try { const waited = await tools.${MULTI_AGENT_WAIT_TOOL}({ targets: [childId], timeout_ms: ${WAIT_PROBE_MS} }); return { childId, status: waited?.status?.[childId] }; }`,
    '  catch { return { childId, status: "running" }; }',
    "}));",
    'const recoveryState = (status) => typeof status === "string" ? status : (status && typeof status === "object" ? Object.keys(status)[0] : "running");',
    "const recoveryRunning = [];",
    "const recoveryParked = [];",
    "for (const probe of recoveryProbes) {",
    "  const state = recoveryState(probe.status);",
    '  if (state === "completed") recoveryParked.push(probe);',
    '  else if (state === "errored" || state === "interrupted" || state === "shutdown") {',
    `    try { await tools.${MULTI_AGENT_CLOSE_TOOL}({ target: probe.childId }); text(JSON.stringify({ recovery_status: "closed", child_id: probe.childId, previous_status: probe.status })); } catch { recoveryRunning.push(probe); }`,
    "  }",
    '  else if (state !== "not_found") recoveryRunning.push(probe);',
    "}",
    "let recoveryHeld = recoveryRunning.length + recoveryParked.length;",
    "while (recoveryHeld > recoveryFree && recoveryParked.length > 0) {",
    "  const oldest = recoveryParked.shift();",
    "  const result = oldest.status?.completed;",
    '  if (typeof result === "string" && result) text(JSON.stringify({ recovery_status: "partial_result", child_id: oldest.childId, result }));',
    `  try { await tools.${MULTI_AGENT_CLOSE_TOOL}({ target: oldest.childId }); recoveryHeld -= 1; text(JSON.stringify({ recovery_status: "evicted", child_id: oldest.childId })); } catch { }`,
    "}",
    'for (const parked of recoveryParked) text(JSON.stringify({ recovery_status: "parked", child_id: parked.childId }));',
    "if (recoveryHeld > recoveryFree) globalThis.__autodev_capacity_refusal = true;",
    ""
  ].join("\n");
}

export function buildSpawnScript(
  children: readonly SpawnChild[],
  {
    yieldTimeMs = DEFAULT_YIELD_MS,
    ownedChildIds = [],
    maxCapacity = resolveAuthoritativeCapacity()
  }: SpawnScriptOptions = {}
): string {
  const taskPayloads = children.map((child) => {
    const target =
      typeof child.target === "string" && child.target.trim()
        ? child.target.trim()
        : null;
    const message = typeof child.message === "string" ? child.message : "";
    if (target) {
      return { target, message };
    }
    const agentType =
      typeof child.agentType === "string" && child.agentType.trim()
        ? child.agentType.trim()
        : null;
    return agentType ? { agent_type: agentType, message } : { message };
  });
  if (taskPayloads.length === 0) {
    throw new Error("buildSpawnScript requires at least one child");
  }
  const hasReused = children.some(
    (c) => typeof c.target === "string" && Boolean(c.target.trim())
  );
  const newSlotsNeeded = children.filter(
    (c) => typeof c.target !== "string" || !c.target.trim()
  ).length;
  const reusedTargets = children
    .map((c) => c.target)
    .filter((t): t is string => typeof t === "string" && Boolean(t.trim()));

  const recovery = buildRecoveryScript({
    ownedChildIds,
    maxCapacity,
    newSlotsNeeded,
    reusedTargets
  });

  const lines = [
    `// @exec: ${JSON.stringify({ yield_time_ms: yieldTimeMs })}`,
    ...(recovery ? [recovery] : []),
    `const tasks = ${JSON.stringify(taskPayloads)};`
  ];

  if (!hasReused && !recovery) {
    lines.push(
      `const out = await Promise.allSettled(tasks.map((t) => tools.${MULTI_AGENT_SPAWN_TOOL}(t)));`,
      `out.forEach((result) => text(JSON.stringify(result.status === "fulfilled" ? { spawn_status: "created", ...(result.value && typeof result.value === "object" ? result.value : {}) } : { spawn_status: "rejected", agent_id: null, error: String(result.reason?.message ?? result.reason) })));`,
      ""
    );
  } else {
    lines.push(
      "const out = await Promise.allSettled(tasks.map((t) => {",
      `  if (t.target) return tools.${MULTI_AGENT_SEND_INPUT_TOOL}(t);`,
      '  if (globalThis.__autodev_capacity_refusal) return Promise.reject(new Error("Concurrency limit reached: no safely evictable capacity exists"));',
      `  return tools.${MULTI_AGENT_SPAWN_TOOL}(t);`,
      "}));",
      "out.forEach((result, i) => {",
      "  const task = tasks[i];",
      '  if (result.status === "fulfilled") {',
      "    if (task?.target) {",
      '      text(JSON.stringify({ spawn_status: "reused", agent_id: task.target, ...(result.value && typeof result.value === "object" ? result.value : {}) }));',
      "    } else {",
      '      text(JSON.stringify({ spawn_status: "created", ...(result.value && typeof result.value === "object" ? result.value : {}) }));',
      "    }",
      "  } else {",
      '    text(JSON.stringify({ spawn_status: "rejected", agent_id: task?.target ?? null, error: String(result.reason?.message ?? result.reason) }));',
      "  }",
      "});",
      ""
    );
  }

  return lines.join("\n");
}

/**
 * A call id unique within a held session, and stable enough to recognise.
 *
 * The session key is hashed rather than embedded because it can be a raw Codex
 * session id, and a call id travels back through the model's own context.
 */
export function mintCallId(sessionKey: string, sequence: number): string {
  const digest = createHash("sha256")
    .update(sessionKey)
    .digest("hex")
    .slice(0, 8);
  return `call_${digest}_${sequence}`;
}

export function mintCallItemId(): string {
  return `ctc_${randomBytes(12).toString("hex")}`;
}

/**
 * The SSE events that make up one `exec` tool call.
 *
 * Emitted atomically: the whole script is known before the first event is
 * written. A partially written call is worse than none, because the router's
 * mid-stream backstop reconstructs `output` from the items it saw and would
 * ship a call with truncated source for Codex to execute.
 */
export function execToolCallSseEvents({
  itemId,
  callId,
  source,
  outputIndex = 0
}: {
  itemId: string;
  callId: string;
  source: string;
  outputIndex?: number;
}): ExecToolCallSseEvent {
  const base = {
    id: itemId,
    type: "custom_tool_call" as const,
    call_id: callId,
    name: EXEC_TOOL
  };
  const completed: CustomToolCallItem = {
    ...base,
    input: source,
    status: "completed"
  };
  return [
    [
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...base, input: "", status: "in_progress" }
      }
    ],
    [
      "response.custom_tool_call_input.delta",
      {
        type: "response.custom_tool_call_input.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: source
      }
    ],
    [
      "response.custom_tool_call_input.done",
      {
        type: "response.custom_tool_call_input.done",
        item_id: itemId,
        output_index: outputIndex,
        input: source
      }
    ],
    [
      "response.output_item.done",
      {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: completed
      }
    ]
  ];
}

/**
 * The one Codex `exec` call that dispatches a collected child batch.
 *
 * `callId` is the call's identity on the wire: Codex pairs the item with the
 * output it returns, so it has to be unique within the turn that carries it.
 * A bridge that owns several turns over one conversation mints its own.
 */
export function buildSpawnToolCallItem(
  children: readonly SpawnChild[],
  parentId: string,
  callId: string
): CustomToolCallItem | null {
  if (children.length === 0) return null;
  return {
    id: mintCallItemId(),
    type: "custom_tool_call",
    call_id: callId,
    name: EXEC_TOOL,
    input: buildSpawnScript(children, {
      ownedChildIds: resolveOwnedChildIds(parentId),
      maxCapacity: resolveAuthoritativeCapacity()
    }),
    status: "completed"
  };
}

/** Build the one Codex exec call that dispatches a collected child batch. */
export function buildSpawnToolCallOutput(
  children: readonly SpawnChild[],
  parentId: string,
  outputIndex: number
): SpawnToolCallOutput | null {
  const item = buildSpawnToolCallItem(
    children,
    parentId,
    mintCallId(parentId, outputIndex)
  );
  if (!item) return null;
  return {
    childCount: children.length,
    item,
    events: execToolCallSseEvents({
      itemId: item.id,
      callId: item.call_id,
      source: item.input,
      outputIndex
    })
  };
}

/**
 * Tool results Codex is handing back on this request, by call id.
 *
 * `custom_tool_call_output` is what an `exec` call returns. `function_call_output`
 * is accepted too: it costs one line, and it means a bridge that later drives
 * a plain function tool needs no change here.
 */
export function pendingToolCallOutputs(input: unknown): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const item of Array.isArray(input) ? input : []) {
    if (
      !isRecord(item) ||
      (item.type !== "custom_tool_call_output" &&
        item.type !== "function_call_output")
    )
      continue;
    if (typeof item.call_id !== "string" || !item.call_id) continue;
    outputs.set(item.call_id, item.output);
  }
  return outputs;
}

/** True when this request is Codex returning the result of a call we made. */
export function carriesPendingSpawnResult(payload: unknown): boolean {
  return isRecord(payload) && pendingToolCallOutputs(payload.input).size > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
