/**
 * Which tool results a Responses request is handing back to the model.
 *
 * Codex answers a model's tool calls on its next request: the call items, then
 * their outputs. It also appends its own messages after those outputs before
 * sending -- a `<subagent_notification>` when a child finishes, a user's steer
 * typed while the call ran, a `<turn_aborted>` notice -- so the outputs are not
 * always the last items. Treating only a strictly trailing run as the awaited
 * results misreads every such request as a new turn (observed with Codex
 * 0.154.0: a `wait_agent` output followed by the child's notification).
 *
 * The awaited results are therefore the tool outputs in the tail of the input,
 * where the tail may also hold user and developer messages. Anything the model
 * itself produced -- a call, a reply, reasoning -- ends the tail: an output
 * before that point answered an earlier step. The router uses this for
 * provider affinity and the Claude bridge to resume a parked turn.
 */

type ResponsesItem = Record<string, unknown>;

export interface AwaitedToolResults {
  /** Output per call id, for the calls the model is waiting on. */
  outputs: Map<string, unknown>;
  /** Messages Codex added after those outputs, oldest first. */
  messages: ResponsesItem[];
}

const TOOL_OUTPUT_TYPES = new Set([ "function_call_output", "custom_tool_call_output" ]);
const INJECTED_ROLES = new Set([ "user", "developer" ]);

function isRecord(value: unknown): value is ResponsesItem {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function awaitedToolResults(input: unknown): AwaitedToolResults {
  const outputs = new Map<string, unknown>();
  const tail: Array<{ item: ResponsesItem; output: boolean }> = [];
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (!isRecord(item)) break;
      if (TOOL_OUTPUT_TYPES.has(String(item.type))) {
        tail.unshift({ item, output: true });
        continue;
      }
      if ((item.type === undefined || item.type === "message") && INJECTED_ROLES.has(String(item.role))) {
        tail.unshift({ item, output: false });
        continue;
      }
      break;
    }
  }
  const firstOutput = tail.findIndex((entry) => entry.output);
  if (firstOutput < 0) return { outputs, messages: [] };
  const messages: ResponsesItem[] = [];
  for (const { item, output } of tail.slice(firstOutput)) {
    if (!output) messages.push(item);
    else if (typeof item.call_id === "string" && item.call_id) outputs.set(item.call_id, item.output);
  }
  return { outputs, messages };
}
