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
 *   - one `exec` call can spawn many agents by awaiting `Promise.all` over the
 *     batch, so fan-out does not need parallel tool calls. This matters because
 *     Codex sends `parallel_tool_calls: false` on the wire regardless of what
 *     the model catalog advertises.
 *   - each spawn resolves to `{ agent_id, nickname }`, and `agent_id` is the
 *     thread id the app links to.
 */

import { randomBytes, createHash } from "node:crypto";

/** Codex's spawn function, as exposed on the isolate's `tools` global. */
export const SPAWN_TOOL = "multi_agent_v1__spawn_agent";

/** The code-mode tool a bridge drives. Codex names it plainly, with no namespace. */
export const EXEC_TOOL = "exec";

// How long `exec` may run before Codex yields the script back. Spawning is
// effectively instantaneous -- the observed wall time for a three-agent batch
// was 0.8s -- so this only has to cover a slow batch, not a child's lifetime.
// The children keep running after the script returns.
const DEFAULT_YIELD_MS = 60_000;

/**
 * The JavaScript body for one spawn batch.
 *
 * Emitting the batch as a single `Promise.all` rather than a call per child is
 * what keeps a wide fan-out to one tool call, and it mirrors the shape Codex's
 * own GPT-served turns produce, so it exercises a path Codex already handles.
 * Each result is passed to `text()` so it comes back in the tool output, one
 * JSON object per line, which `parseSpawnResults` reads.
 */
export function buildSpawnScript(children, { yieldTimeMs = DEFAULT_YIELD_MS } = {}) {
  const tasks = children.map((child) => {
    const agentType = typeof child?.agentType === "string" && child.agentType.trim() ? child.agentType.trim() : null;
    const message = typeof child?.message === "string" ? child.message : "";
    // JSON.stringify is the escaping here: the script is source text, and a
    // prompt containing quotes, newlines or a `*/` would otherwise end the
    // string or the script.
    return agentType
      ? `{ agent_type: ${JSON.stringify(agentType)}, message: ${JSON.stringify(message)} }`
      : `{ message: ${JSON.stringify(message)} }`;
  });
  if (tasks.length === 0) throw new Error("buildSpawnScript requires at least one child");
  return [
    `// @exec: ${JSON.stringify({ yield_time_ms: yieldTimeMs })}`,
    `const tasks = [${tasks.join(", ")}];`,
    `const out = await Promise.all(tasks.map((t) => tools.${SPAWN_TOOL}(t)));`,
    `out.forEach(text);`,
    "",
  ].join("\n");
}

/**
 * The `{ agent_id, nickname }` objects a spawn batch returned.
 *
 * Codex wraps the script's output in a `custom_tool_call_output` whose `output`
 * is a list of `input_text` parts: a "Script completed ..." preamble, then one
 * part per `text()` call. Anything that does not parse as an object carrying an
 * `agent_id` is skipped rather than treated as an error, so the preamble and any
 * stray diagnostic line cost nothing.
 */
export function parseSpawnResults(output) {
  const parts = Array.isArray(output)
    ? output.map((part) => (typeof part === "string" ? part : part?.text)).filter((t) => typeof t === "string")
    : [typeof output === "string" ? output : ""];
  const results = [];
  for (const part of parts) {
    for (const line of part.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.agent_id === "string" && parsed.agent_id.trim()) {
          results.push({ agentId: parsed.agent_id, nickname: typeof parsed.nickname === "string" ? parsed.nickname : null });
        }
      } catch {
        // Not a result line; the script may legitimately text() other things.
      }
    }
  }
  return results;
}

/**
 * A call id unique within a held session, and stable enough to recognise.
 *
 * The session key is hashed rather than embedded because it can be a raw Codex
 * session id, and a call id travels back through the model's own context.
 */
export function mintCallId(sessionKey, sequence) {
  const digest = createHash("sha256").update(String(sessionKey)).digest("hex").slice(0, 8);
  return `call_${digest}_${sequence}`;
}

export function mintCallItemId() {
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
export function execToolCallSseEvents({ itemId, callId, source, outputIndex = 0 }) {
  const base = { id: itemId, type: "custom_tool_call", call_id: callId, name: EXEC_TOOL };
  const completed = { ...base, input: source, status: "completed" };
  return [
    ["response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: { ...base, input: "", status: "in_progress" } }],
    ["response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", item_id: itemId, output_index: outputIndex, delta: source }],
    ["response.custom_tool_call_input.done", { type: "response.custom_tool_call_input.done", item_id: itemId, output_index: outputIndex, input: source }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item: completed }],
  ];
}

/**
 * Tool results Codex is handing back on this request, by call id.
 *
 * `custom_tool_call_output` is what an `exec` call returns. `function_call_output`
 * is accepted too: it costs one line, and it means a bridge that later drives a
 * plain function tool needs no change here.
 */
export function pendingToolCallOutputs(input) {
  const outputs = new Map();
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type !== "custom_tool_call_output" && item?.type !== "function_call_output") continue;
    if (typeof item.call_id !== "string" || !item.call_id) continue;
    outputs.set(item.call_id, item.output);
  }
  return outputs;
}

/** True when this request is Codex returning the result of a call we made. */
export function carriesPendingSpawnResult(payload) {
  return pendingToolCallOutputs(payload?.input).size > 0;
}
