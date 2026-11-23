/**
 * What every bridge that parks Codex tool calls shares.
 *
 * A bridged provider cannot run Codex's tools itself: the CLI or CLI-like
 * process has no sandbox, no approvals, and no place in the thread history. So
 * a provider calls a tool through the MCP shim
 * (`runtime/src/mcp/codex-tools-shim.ts`), the shim blocks on a loopback call
 * into the bridge, the bridge emits the call as a Responses output item, and
 * Codex executes it. The response ends there; the call's output comes back on
 * Codex's next request and releases the parked call.
 *
 * This module owns the parts of that which are not specific to one provider:
 * the live-turn registry that maps a shim call back to the turn holding it, and
 * the two shapes both sides need to agree on. The Claude and Antigravity
 * bridges each keep their own turn class, because their streams and process
 * lifecycles differ.
 */

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

import {
  mcpResultFromCodexOutput,
  renderCodexTranscript
} from "@simulatorlife/autodev-runtime/shared/codex-transcript";
import type { AwaitedToolResults } from "@simulatorlife/autodev-runtime/shared/responses-continuation";

type JsonRecord = Record<string, unknown>;

/** Formats one Responses SSE event line pair. */
export function formatSseEvent(eventName: string, body: object): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`;
}

/** Sends standard non-buffered SSE response headers for parked/streamed bridges. */
export function writeSseStreamHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close"
  });
  response.flushHeaders();
  response.shouldKeepAlive = false;
}

/** The minimum a parked turn must offer to live in the registry. */
export interface ParkableTurn {
  readonly id: string;
  cancel(): void;
}

/** A short random id, for turn ids and output-item ids alike. */
export function turnId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * A turn run by a provider that never reached part of its tool surface.
 *
 * Every provider runs with Codex's whole tool surface, offered the same way:
 * Codex's tools through the shim, and file work through the `filesystem` MCP
 * server. When either server cannot start -- a broken import, a missing
 * dependency -- the provider CLI drops it and carries on without it, so the
 * model answers "I am blocked" or writes tool calls as text, and the bridge
 * would report that as a successful turn. Each bridge raises this instead, so
 * the turn fails where the router can see it rather than completing without
 * the tools it was routed with.
 */
export class CodexToolsUnreachableError extends Error {
  readonly code = "codex_tools_unreachable";

  constructor(provider: string, detail: string, server = "codex") {
    super(
      `${provider} ran without its tools: the ${server} MCP server ${detail}. The turn was not run with the tool surface it was routed with.`
    );
    this.name = "CodexToolsUnreachableError";
  }
}

/** The MCP `tools/call` result for a call that could not be made. */
export function toolErrorResult(text: string): JsonRecord {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The live turns a bridge is holding, and which turn owns each parked call.
 *
 * The shim names its turn in every loopback call, and the router names a call's
 * owner only through the `call_id` Codex returns the output against, so the
 * registry is what joins the two halves of a parked turn back together.
 */
export class CodexToolTurnRegistry<T extends ParkableTurn> {
  private readonly turns = new Map<string, T>();
  private readonly calls = new Map<string, T>();
  private readonly maxTurns: number;

  constructor(maxTurns = 32) {
    this.maxTurns = maxTurns;
  }

  add(turn: T): void {
    // Bounded: an abandoned turn is reclaimed by its park timer, and this cap
    // keeps a burst of them from holding unbounded provider processes meanwhile.
    while (this.turns.size >= this.maxTurns) {
      const oldest = this.turns.values().next().value;
      if (!oldest) break;
      oldest.cancel();
    }
    this.turns.set(turn.id, turn);
  }

  bindCall(callId: string, turn: T): void {
    this.calls.set(callId, turn);
  }

  byId(id: string): T | null {
    return this.turns.get(id) ?? null;
  }

  /** The turn waiting on any of these call outputs, if one is still alive. */
  forOutputs(outputs: Map<string, unknown>): T | null {
    for (const callId of outputs.keys()) {
      const turn = this.calls.get(callId);
      if (turn) return turn;
    }
    return null;
  }

  /** Cancel every live turn, killing its process. Returns how many there were. */
  cancelAll(): number {
    const live = [...this.turns.values()];
    for (const turn of live) turn.cancel();
    return live.length;
  }

  remove(turn: T): void {
    this.turns.delete(turn.id);
    for (const [callId, owner] of this.calls)
      if (owner === turn) this.calls.delete(callId);
  }

  status(): { turns: number; maxTurns: number } {
    return { turns: this.turns.size, maxTurns: this.maxTurns };
  }
}

export interface AwaitingBridgeCall {
  resolve(result: JsonRecord): void;
}

/**
 * Shared continuation handler for parked CLI bridges (`antigravity`, `claude`):
 * resolves awaiting MCP tool calls against Codex's `outputs`, appends any
 * mid-turn `messages` (steers / `<subagent_notification>`) onto the trailing
 * tool result, and fails any un-answered awaiting calls cleanly.
 */
export function resolveAwaitedBridgeTools<T extends AwaitingBridgeCall>(args: {
  readonly awaiting: Map<string, T>;
  readonly outputs: AwaitedToolResults["outputs"];
  readonly messages: AwaitedToolResults["messages"];
  readonly fallbackErrorText: string;
  readonly extraMessageContent?: (
    messages: AwaitedToolResults["messages"]
  ) => JsonRecord[];
  readonly onResolved?: (
    callId: string,
    call: T,
    result: JsonRecord,
    rawOutput: unknown
  ) => void;
}): void {
  const resolved: Array<{
    callId: string;
    call: T;
    result: JsonRecord;
    rawOutput: unknown;
  }> = [];
  for (const [callId, output] of args.outputs) {
    const call = args.awaiting.get(callId);
    if (!call) continue;
    args.awaiting.delete(callId);
    resolved.push({
      callId,
      call,
      result: mcpResultFromCodexOutput(output),
      rawOutput: output
    });
  }
  const last = resolved.at(-1)?.result;
  if (last && args.messages.length > 0 && Array.isArray(last.content)) {
    const content = last.content as JsonRecord[];
    content.push({
      type: "text",
      text: `Codex added to the conversation while this ran:\n\n${renderCodexTranscript(args.messages)}`
    });
    if (args.extraMessageContent) {
      content.push(...args.extraMessageContent(args.messages));
    }
  }
  for (const { callId, call, result, rawOutput } of resolved) {
    call.resolve(result);
    args.onResolved?.(callId, call, result, rawOutput);
  }
  for (const call of args.awaiting.values()) {
    call.resolve(toolErrorResult(args.fallbackErrorText));
  }
  args.awaiting.clear();
}
