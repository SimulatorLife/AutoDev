/**
 * Codex's own tools, offered to the Claude CLI so that Codex runs them.
 *
 * The Claude bridge serves Claude as a model, not as a second agent runtime.
 * Every action a Claude-served turn takes is a Codex tool call: the bridge
 * emits it as a `custom_tool_call`/`function_call` item, Codex executes it in
 * the turn's sandbox with the turn's approvals and hooks, and the app renders
 * it like any other model's call. A tool the Claude CLI ran inside its own
 * process would be invisible to Codex, to its hooks, and to the thread
 * history -- which is exactly the failure this module exists to prevent.
 *
 * The CLI cannot reach Codex itself, so the bridge mirrors the request's tool
 * surface into an MCP server (`src/mcp/codex-tools-shim.ts`). A call the
 * model makes through that server parks inside the bridge until Codex returns
 * the call's output on its next request.
 *
 * Codex runs these models in code mode: the tool surface arrives as an
 * `additional_tools` input item holding a `functions` namespace with the
 * `exec` custom tool (raw JavaScript evaluated against a `tools` global that
 * carries `exec_command`, `apply_patch`, the role's MCP servers, and the
 * orchestrator's `multi_agent_v1__*` functions) plus plain function tools such
 * as `wait`. Captured from Codex 0.154.0 with the request-capture skill.
 */

type JsonRecord = Record<string, unknown>;

/** One tool Codex offered on this request, flattened out of any namespace. */
export interface CodexTool {
  kind: "custom" | "function";
  name: string;
  description: string;
  /** JSON schema of a function tool's arguments. */
  parameters: JsonRecord | null;
  /** The namespace Codex grouped the tool under, when it was not `functions`. */
  namespace: string | null;
}

export interface CodexToolSurface {
  tools: CodexTool[];
  /** Codex offered its hosted web search, which only the provider can perform. */
  webSearch: boolean;
}

/** The MCP server name the bridge registers; Claude names its tools `mcp__codex__<tool>`. */
export const CODEX_TOOLS_SERVER = "codex";

// Codex's default namespace. Its members are called by their bare names, as
// recorded rollouts of Codex-served turns show (`exec`, `wait`).
const DEFAULT_NAMESPACE = "functions";
const HOSTED_WEB_SEARCH_TYPES = new Set(["web_search", "web_search_preview"]);
// MCP tool names must match this; a Codex tool that cannot be named in MCP
// cannot be offered, and is skipped rather than renamed into something Codex
// would not recognise on the way back.
const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collect(
  entries: unknown,
  namespace: string | null,
  surface: CodexToolSurface,
  seen: Set<string>
): void {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry)) continue;
    const type = entry.type;
    if (typeof type === "string" && HOSTED_WEB_SEARCH_TYPES.has(type)) {
      surface.webSearch = true;
      continue;
    }
    if (type === "namespace") {
      const name =
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : null;
      collect(entry.tools, name, surface, seen);
      continue;
    }
    if (type !== "custom" && type !== "function") continue;
    // Chat-completions style function tools nest their definition one level down.
    const definition =
      type === "function" && isRecord(entry.function) ? entry.function : entry;
    const name =
      typeof definition.name === "string" ? definition.name.trim() : "";
    if (!MCP_TOOL_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    surface.tools.push({
      kind: type,
      name,
      description:
        typeof definition.description === "string"
          ? definition.description
          : "",
      parameters:
        type === "function" && isRecord(definition.parameters)
          ? definition.parameters
          : null,
      namespace: namespace && namespace !== DEFAULT_NAMESPACE ? namespace : null
    });
  }
}

/** Every tool Codex offered this turn: top-level `tools` and `additional_tools` items. */
export function codexToolSurface(payload: unknown): CodexToolSurface {
  const surface: CodexToolSurface = { tools: [], webSearch: false };
  if (!isRecord(payload)) return surface;
  const seen = new Set<string>();
  collect(payload.tools, null, surface, seen);
  for (const item of Array.isArray(payload.input) ? payload.input : []) {
    if (isRecord(item) && item.type === "additional_tools")
      collect(item.tools, null, surface, seen);
  }
  return surface;
}

/**
 * The full reference for every mirrored tool, for the system prompt.
 *
 * Codex's tool descriptions are long -- `exec`'s carries the TypeScript
 * declaration of every nested tool, around 10 KB -- and the Claude CLI
 * truncates MCP tool descriptions, which left the model guessing at argument
 * names (`command` for `exec_command`'s `cmd`) until a call failed. The
 * system prompt is not truncated, so the reference lives there and the MCP
 * entries point to it.
 */
export function codexToolReference(tools: readonly CodexTool[]): string {
  return tools
    .map((tool) => {
      const input =
        tool.kind === "custom"
          ? "Input: the tool's raw text, passed as the `input` string (for `exec`, JavaScript source with no markdown fences)."
          : `Arguments (JSON schema): ${JSON.stringify(tool.parameters ?? { type: "object", properties: {} })}`;
      return `### \`${tool.name}\`\n\n${tool.description.trim()}\n\n${input}`;
    })
    .join("\n\n");
}

/** The MCP `tools/list` entry that stands in for one Codex tool. */
export function mcpToolDefinition(tool: CodexTool): JsonRecord {
  const summary = tool.description.trim().split("\n", 1)[0] ?? "";
  const description = `${summary}\n\nFull reference: the "${tool.name}" section under "Codex tools" in your instructions.`;
  if (tool.kind === "custom") {
    // A custom tool takes free-form text -- for `exec`, raw JavaScript source.
    // MCP only carries JSON arguments, so the text travels as one string and
    // is handed to Codex verbatim as the call's `input`.
    return {
      name: tool.name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "The tool's raw input text." }
        },
        required: ["input"]
      }
    };
  }
  return {
    name: tool.name,
    description,
    inputSchema: tool.parameters ?? { type: "object", properties: {} }
  };
}

export interface ToolCallIds {
  itemId: string;
  callId: string;
}

/** The completed Responses output item for one call Claude made. */
export function codexToolCallItem(
  tool: CodexTool,
  args: unknown,
  ids: ToolCallIds
): JsonRecord {
  if (tool.kind === "custom") {
    const input =
      isRecord(args) && typeof args.input === "string" ? args.input : "";
    return {
      id: ids.itemId,
      type: "custom_tool_call",
      status: "completed",
      call_id: ids.callId,
      name: tool.name,
      input
    };
  }
  return {
    id: ids.itemId,
    type: "function_call",
    status: "completed",
    call_id: ids.callId,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(isRecord(args) ? args : {})
  };
}

/** The SSE events that stream one call item, emitted whole once the call is known. */
export function codexToolCallEvents(
  item: JsonRecord,
  outputIndex: number
): Array<[string, JsonRecord]> {
  const itemId = String(item.id);
  if (item.type === "custom_tool_call") {
    const input = String(item.input ?? "");
    return [
      [
        "response.output_item.added",
        {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { ...item, input: "", status: "in_progress" }
        }
      ],
      [
        "response.custom_tool_call_input.delta",
        {
          type: "response.custom_tool_call_input.delta",
          item_id: itemId,
          output_index: outputIndex,
          delta: input
        }
      ],
      [
        "response.custom_tool_call_input.done",
        {
          type: "response.custom_tool_call_input.done",
          item_id: itemId,
          output_index: outputIndex,
          input
        }
      ],
      [
        "response.output_item.done",
        { type: "response.output_item.done", output_index: outputIndex, item }
      ]
    ];
  }
  const argumentsText = String(item.arguments ?? "");
  return [
    [
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, arguments: "", status: "in_progress" }
      }
    ],
    [
      "response.function_call_arguments.delta",
      {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: argumentsText
      }
    ],
    [
      "response.function_call_arguments.done",
      {
        type: "response.function_call_arguments.done",
        item_id: itemId,
        output_index: outputIndex,
        arguments: argumentsText
      }
    ],
    [
      "response.output_item.done",
      { type: "response.output_item.done", output_index: outputIndex, item }
    ]
  ];
}

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output"
]);

/** An MCP `tools/call` result carrying what Codex returned for the call. */
export function mcpResultFromCodexOutput(output: unknown): JsonRecord {
  const content: JsonRecord[] = [];
  const addText = (text: string) => {
    if (text) content.push({ type: "text", text });
  };
  if (typeof output === "string") addText(output);
  else if (Array.isArray(output)) {
    for (const part of output) {
      if (typeof part === "string") {
        addText(part);
        continue;
      }
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") {
        addText(part.text);
        continue;
      }
      const url = typeof part.image_url === "string" ? part.image_url : null;
      const match = url ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : null;
      if (match)
        content.push({ type: "image", mimeType: match[1], data: match[2] });
    }
  } else if (isRecord(output) && typeof output.content === "string")
    addText(output.content);
  else if (output !== undefined && output !== null)
    addText(JSON.stringify(output));
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });
  return { content };
}

/**
 * Whether Codex reported the call as failed rather than run.
 *
 * `exec` results open with Codex's own status line ("Script completed", or a
 * failure line), and a call Codex cut short comes back as "aborted".
 */
export function codexOutputFailed(output: unknown): boolean {
  const first = outputText(output).trimStart().split("\n", 1)[0] ?? "";
  return /^(aborted|script (failed|error|timed out)|error\b)/i.test(first);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.image_url === "string" || part.type === "input_image")
        return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return textOf(output);
  if (isRecord(output) && typeof output.content === "string")
    return output.content;
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

/**
 * Codex's conversation for this agent, as the text a fresh Claude CLI starts from.
 *
 * Everything a Codex-native model would see is kept: developer instructions,
 * user turns, the agent's own earlier answers, and every tool call with its
 * output. A turn that resumes after the bridge lost its CLI therefore carries
 * forward what already happened instead of starting over blind. Tool
 * definitions are not repeated here; they arrive as the session's tools.
 */
export function renderCodexTranscript(input: unknown): string {
  if (typeof input === "string") return `<user>\n${input}\n</user>`;
  if (!Array.isArray(input))
    return `<user>\n${JSON.stringify(input ?? "")}\n</user>`;
  const parts: string[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      parts.push(`<user>\n${item}\n</user>`);
      continue;
    }
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type : "message";
    if (type === "message") {
      const role =
        item.role === "assistant" ||
        item.role === "developer" ||
        item.role === "system"
          ? item.role
          : "user";
      const text = textOf(item.content ?? item.text);
      if (text) parts.push(`<${role}>\n${text}\n</${role}>`);
    } else if (type === "custom_tool_call") {
      parts.push(
        `<tool_call name="${String(item.name)}" call_id="${String(item.call_id)}">\n${String(item.input ?? "")}\n</tool_call>`
      );
    } else if (type === "function_call") {
      parts.push(
        `<tool_call name="${String(item.name)}" call_id="${String(item.call_id)}">\n${String(item.arguments ?? "")}\n</tool_call>`
      );
    } else if (TOOL_OUTPUT_TYPES.has(type)) {
      parts.push(
        `<tool_output call_id="${String(item.call_id)}">\n${outputText(item.output)}\n</tool_output>`
      );
    }
    // Reasoning items are opaque references to another provider's state, and
    // `additional_tools` is the tool surface itself; neither is conversation.
  }
  return parts.join("\n\n");
}
