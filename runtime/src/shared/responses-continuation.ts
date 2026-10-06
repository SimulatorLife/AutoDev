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

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output"
]);
const INJECTED_ROLES = new Set(["user", "developer"]);

function isRecord(value: unknown): value is ResponsesItem {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when `item` may sit in the trailing run of a Responses request. */
function isTailItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (TOOL_OUTPUT_TYPES.has(String(item.type))) return true;
  return (
    (item.type === undefined || item.type === "message") &&
    INJECTED_ROLES.has(String(item.role))
  );
}

function isTailOutput(item: unknown): boolean {
  return isRecord(item) && TOOL_OUTPUT_TYPES.has(String(item.type));
}

/**
 * Index of the first item in the trailing run, or `input.length` when there is
 * no tail. Scanning back for a bound is cheaper than materialising the run.
 */
function tailStart(input: readonly unknown[]): number {
  let start = input.length;
  while (start > 0 && isTailItem(input[start - 1])) start -= 1;
  return start;
}

export function awaitedToolResults(input: unknown): AwaitedToolResults {
  const outputs = new Map<string, unknown>();
  if (!Array.isArray(input)) return { outputs, messages: [] };

  // Walk the tail by index over `input` itself. Collecting it into an array of
  // `{ item, output }` wrappers meant unshifting every entry into the front --
  // quadratic in the tail length -- and then copying the remainder a second
  // time with `slice`. This runs for every routed request, and the tail is as
  // long as the run of tool results a turn with many parallel calls produces.
  const start = tailStart(input);

  // Injected messages ahead of the first output answer no call, so they are
  // dropped rather than returned.
  let firstOutput = start;
  while (firstOutput < input.length && !isTailOutput(input[firstOutput])) {
    firstOutput += 1;
  }
  if (firstOutput === input.length) return { outputs, messages: [] };

  const messages: ResponsesItem[] = [];
  for (let index = firstOutput; index < input.length; index += 1) {
    const item = input[index] as ResponsesItem;
    if (isTailOutput(item)) {
      if (typeof item.call_id === "string" && item.call_id) {
        outputs.set(item.call_id, item.output);
      }
    } else {
      messages.push(item);
    }
  }
  return { outputs, messages };
}
