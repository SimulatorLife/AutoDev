/**
 * One Claude-served Codex turn, across the several requests it spans.
 *
 * Codex drives a turn as a loop of requests: the model answers, Codex runs the
 * tool calls in that answer, and sends the outputs back on the next request.
 * The Claude CLI instead runs a whole turn in one process. The bridge
 * reconciles the two by keeping the CLI alive between requests: when Claude
 * calls one of Codex's tools (through `src/mcp/codex-tools-shim.ts`) the call
 * is emitted to Codex, the current response completes, and the CLI stays
 * parked on that call until Codex's next request carries its output.
 *
 * Output items are emitted as they finish -- each thinking block, each text
 * block, each tool call -- rather than as one reasoning blob finalised when
 * the CLI exits. Codex records an item when it is done, so an interrupted
 * turn keeps everything that happened before the interruption.
 */

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

import { INCOMPLETE_REASON_INTERRUPTED, incompleteDetails, truncationNotice } from "../shared/provider-limits.ts";
import type { ProviderLimit } from "../shared/provider-limits.ts";
import { codexOutputFailed, codexToolCallEvents, codexToolCallItem, mcpResultFromCodexOutput, mcpToolDefinition, renderCodexTranscript } from "./claude-codex-tools.ts";
import type { CodexTool } from "./claude-codex-tools.ts";
import type { AwaitedToolResults } from "../shared/responses-continuation.ts";

type JsonRecord = Record<string, unknown>;

/** What the CLI driver reports, stripped of the CLI's own wire format. */
export type ClaudeCliEvent =
  | { kind: "message_start" }
  | { kind: "message_stop" }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "block_stop" }
  | { kind: "native_tool"; name: string; input: JsonRecord }
  | { kind: "complete"; text: string; usage: { input_tokens: number; output_tokens: number } };

/** How a failed turn ends its response. */
export interface TurnFailure {
  error: unknown;
  reason: string;
  limit: ProviderLimit | null;
}

/** The request-scoped side of the bridge a turn reports through. */
export interface TurnReporter {
  toolRequested(tool: string, callId: string): void;
  toolExecuted(tool: string, callId: string, durationMs: number, status: "ok" | "error"): void;
  finished(): void;
  failed(): void;
  heartbeat(): void;
}

export interface ResponseStreamOptions {
  response: ServerResponse;
  streaming: boolean;
  model: string;
  /** Answers with an HTTP error when nothing has been streamed yet. */
  sendError: (response: ServerResponse, failure: TurnFailure) => void;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * The Responses stream for one HTTP request.
 *
 * Nothing is written until the first real content arrives, so a failure
 * before that point can still answer with a proper HTTP status (a 429 the
 * router can cool down on) instead of a 200 stream that says it failed.
 */
export class ResponseStream {
  readonly id = `resp_${hex(12)}`;
  private sequence = 0;
  private started = false;
  private ended = false;
  private readonly pending: string[] = [];
  private readonly output: JsonRecord[] = [];
  private reasoning: { index: number; id: string; text: string } | null = null;
  private message: { index: number; id: string; text: string } | null = null;
  private readonly closeListeners: Array<() => void> = [];
  private readonly options: ResponseStreamOptions;

  constructor(options: ResponseStreamOptions) {
    this.options = options;
    this.emit("response.created", { type: "response.created", response: this.snapshot("in_progress") });
    options.response.on("close", () => {
      if (this.ended) return;
      this.ended = true;
      for (const listener of this.closeListeners) listener();
    });
  }

  /** Called once if the client goes away before this stream ended. */
  onClientClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private writable(): boolean {
    const { response } = this.options;
    return !this.ended && !response.writableEnded && !response.destroyed;
  }

  private emit(eventName: string, body: JsonRecord): void {
    if (!this.options.streaming || !this.writable()) return;
    const line = `event: ${eventName}\ndata: ${JSON.stringify({ ...body, sequence_number: ++this.sequence })}\n\n`;
    if (!this.started) { this.pending.push(line); return; }
    try { this.options.response.write(line); } catch { /* the close listener handles a gone client */ }
  }

  private start(): void {
    if (this.started || !this.options.streaming || !this.writable()) return;
    this.started = true;
    const { response } = this.options;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    response.flushHeaders();
    response.shouldKeepAlive = false;
    for (const line of this.pending.splice(0)) {
      try { response.write(line); } catch { break; }
    }
  }

  /** A comment line that keeps idle intermediaries from closing the stream. */
  keepAlive(): void {
    if (!this.started || !this.writable()) return;
    try { this.options.response.write(": claude-bridge keep-alive\n\n"); } catch { /* ignore */ }
  }

  private snapshot(status: string): JsonRecord {
    return { id: this.id, object: "response", created_at: Math.floor(Date.now() / 1000), model: this.options.model, status, output: [ ...this.output ] };
  }

  private outputText(): string {
    return this.output
      .filter((item) => item.type === "message")
      .map((item) => ((item.content as JsonRecord[] | undefined)?.[0]?.text as string | undefined) ?? "")
      .join("");
  }

  thinking(text: string): void {
    if (!text) return;
    this.start();
    this.closeMessage();
    if (!this.reasoning) {
      this.reasoning = { index: this.output.length, id: `rs_${hex(12)}`, text: "" };
      this.output.push({ id: this.reasoning.id, type: "reasoning", status: "in_progress", summary: [], content: [] });
      this.emit("response.output_item.added", { type: "response.output_item.added", output_index: this.reasoning.index, item: { id: this.reasoning.id, type: "reasoning", status: "in_progress", summary: [], content: [] } });
      this.emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: this.reasoning.id, output_index: this.reasoning.index, summary_index: 0, part: { type: "summary_text", text: "" } });
    }
    this.reasoning.text += text;
    this.emit("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: this.reasoning.id, output_index: this.reasoning.index, summary_index: 0, delta: text });
  }

  text(text: string): void {
    if (!text) return;
    this.start();
    this.closeReasoning();
    if (!this.message) {
      this.message = { index: this.output.length, id: `msg_${hex(10)}`, text: "" };
      this.output.push({ id: this.message.id, type: "message", role: "assistant", status: "in_progress", content: [] });
      this.emit("response.output_item.added", { type: "response.output_item.added", output_index: this.message.index, item: { id: this.message.id, type: "message", role: "assistant", status: "in_progress", content: [] } });
      this.emit("response.content_part.added", { type: "response.content_part.added", item_id: this.message.id, output_index: this.message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
    this.message.text += text;
    this.emit("response.output_text.delta", { type: "response.output_text.delta", item_id: this.message.id, output_index: this.message.index, content_index: 0, delta: text });
  }

  private closeReasoning(status = "completed"): void {
    const open = this.reasoning;
    if (!open) return;
    this.reasoning = null;
    const item = { id: open.id, type: "reasoning", status, summary: [ { type: "summary_text", text: open.text } ], content: [] };
    this.output[open.index] = item;
    this.emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: open.id, output_index: open.index, summary_index: 0, text: open.text });
    this.emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: open.id, output_index: open.index, summary_index: 0, part: { type: "summary_text", text: open.text } });
    this.emit("response.output_item.done", { type: "response.output_item.done", output_index: open.index, item });
  }

  private closeMessage(status = "completed"): void {
    const open = this.message;
    if (!open) return;
    this.message = null;
    const item = { id: open.id, type: "message", role: "assistant", status, content: [ { type: "output_text", text: open.text, annotations: [] } ] };
    this.output[open.index] = item;
    this.emit("response.output_text.done", { type: "response.output_text.done", item_id: open.id, output_index: open.index, content_index: 0, text: open.text });
    this.emit("response.content_part.done", { type: "response.content_part.done", item_id: open.id, output_index: open.index, content_index: 0, part: { type: "output_text", text: open.text, annotations: [] } });
    this.emit("response.output_item.done", { type: "response.output_item.done", output_index: open.index, item });
  }

  /** End whichever block is open; the next delta starts a new item. */
  closeBlocks(): void {
    this.closeReasoning();
    this.closeMessage();
  }

  /** A step the provider took itself, recorded as a finished reasoning item. */
  progress(summary: string): void {
    this.closeBlocks();
    this.thinking(summary);
    this.closeReasoning();
  }

  toolCall(item: JsonRecord): void {
    this.start();
    this.closeBlocks();
    const index = this.output.length;
    this.output.push(item);
    for (const [ eventName, body ] of codexToolCallEvents(item, index)) this.emit(eventName, body);
  }

  private end(payload: JsonRecord): void {
    if (this.ended) return;
    const { response } = this.options;
    if (!this.options.streaming) {
      this.ended = true;
      const encoded = Buffer.from(JSON.stringify(payload));
      if (!response.headersSent) response.writeHead(200, { "content-type": "application/json", "content-length": encoded.length, connection: "close" });
      response.end(encoded);
      return;
    }
    this.start();
    this.emit("response.completed", { type: "response.completed", response: payload });
    this.ended = true;
    if (!response.writableEnded && !response.destroyed) {
      try { response.end("data: [DONE]\n\n"); } catch { /* ignore */ }
    }
  }

  complete(usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 }): void {
    this.closeBlocks();
    this.end({
      ...this.snapshot("completed"),
      output_text: this.outputText(),
      usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
    });
  }

  fail(failure: TurnFailure, provider: string): void {
    if (this.ended) return;
    if (!this.started && this.output.length === 0) {
      // Nothing streamed yet: a real HTTP error lets the router react to it.
      this.ended = true;
      this.options.sendError(this.options.response, failure);
      return;
    }
    this.closeReasoning("incomplete");
    const notice = truncationNotice({ provider, limit: failure.limit, reason: failure.reason });
    this.text(notice);
    this.closeMessage("incomplete");
    this.end({ ...this.snapshot("incomplete"), incomplete_details: incompleteDetails(failure.reason, failure.limit), output_text: this.outputText() });
  }
}

interface QueuedCall { tool: CodexTool; args: unknown; resolve: (result: JsonRecord) => void }
interface AwaitingCall { tool: CodexTool; emittedAt: number; resolve: (result: JsonRecord) => void }

export interface ClaudeTurnOptions {
  tools: CodexTool[];
  registry: ClaudeTurnRegistry;
  /** How long a turn may wait for Codex to return a tool's output. */
  parkMs: number;
  /** How long to gather tool calls the CLI issues together before emitting them. */
  gatherMs?: number;
  describeFailure: (error: unknown) => TurnFailure;
}

function toolErrorResult(text: string): JsonRecord {
  return { content: [ { type: "text", text } ], isError: true };
}

export class ClaudeTurn {
  readonly id = hex(12);
  private readonly abortController = new AbortController();
  private stream: ResponseStream | null = null;
  private reporter: TurnReporter | null = null;
  private readonly queued: QueuedCall[] = [];
  private readonly awaiting = new Map<string, AwaitingCall>();
  private sequence = 0;
  private messageOpen = false;
  private gatherTimer: NodeJS.Timeout | null = null;
  private parkTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private finished = false;
  private stashedFailure: TurnFailure | null = null;
  private lastText = "";
  private readonly options: ClaudeTurnOptions;

  constructor(options: ClaudeTurnOptions) {
    this.options = options;
    options.registry.add(this);
  }

  /** Aborted when the turn is cancelled; the CLI driver kills the process on it. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get tools(): CodexTool[] {
    return this.options.tools;
  }

  /** The MCP tool list the shim offers the CLI. */
  toolDefinitions(): JsonRecord[] {
    return this.options.tools.map(mcpToolDefinition);
  }

  /** True while Codex holds tool calls this turn is blocked on. */
  get waitingOnCodex(): boolean {
    return this.awaiting.size > 0 || this.queued.length > 0;
  }

  /**
   * Take over a request's response: the first request of the turn, or a
   * continuation carrying the outputs of calls this turn emitted.
   */
  attach(stream: ResponseStream, reporter: TurnReporter, awaited: AwaitedToolResults = { outputs: new Map(), messages: [] }): void {
    this.clearParkTimer();
    this.stream = stream;
    this.reporter = reporter;
    stream.onClientClose(() => {
      if (this.stream === stream) this.cancel();
    });
    this.keepAliveTimer ??= setInterval(() => {
      this.stream?.keepAlive();
      this.reporter?.heartbeat();
    }, 2000);
    if (this.stashedFailure) {
      const failure = this.stashedFailure;
      this.stashedFailure = null;
      this.endStream(failure);
      this.options.registry.remove(this);
      return;
    }
    const results: Array<[ AwaitingCall, JsonRecord ]> = [];
    for (const [ callId, output ] of awaited.outputs) {
      const call = this.awaiting.get(callId);
      if (!call) continue;
      this.awaiting.delete(callId);
      reporter.toolExecuted(call.tool.name, callId, Date.now() - call.emittedAt, codexOutputFailed(output) ? "error" : "ok");
      results.push([ call, mcpResultFromCodexOutput(output) ]);
    }
    // What Codex added while the calls ran -- a subagent's notification, the
    // user steering the turn -- reaches the model with the results, in order,
    // instead of being lost to a CLI that only ever sees tool output.
    const last = results.at(-1)?.[1];
    if (last && awaited.messages.length > 0) {
      (last.content as JsonRecord[]).push({ type: "text", text: `Codex added to the conversation while this ran:\n\n${renderCodexTranscript(awaited.messages)}` });
    }
    for (const [ call, result ] of results) call.resolve(result);
    // Codex moved on without answering these: the model must not wait on them.
    for (const [ callId, call ] of this.awaiting) {
      this.awaiting.delete(callId);
      call.resolve(toolErrorResult(`Codex returned no result for ${call.tool.name}; the call may not have run.`));
    }
    this.scheduleGather();
  }

  /** A tool call the CLI made through the shim; resolves with Codex's output. */
  requestTool(name: string, args: unknown): Promise<JsonRecord> {
    const tool = this.options.tools.find((candidate) => candidate.name === name);
    if (!tool) return Promise.resolve(toolErrorResult(`Codex did not offer a tool named ${name} on this turn.`));
    if (this.finished) return Promise.resolve(toolErrorResult("This turn has ended; the call was not run."));
    return new Promise((resolveCall) => {
      this.queued.push({ tool, args, resolve: resolveCall });
      this.scheduleGather();
    });
  }

  /** Drive the turn from the CLI's events until it completes or fails. */
  async run(events: AsyncIterable<ClaudeCliEvent>): Promise<void> {
    try {
      for await (const event of events) this.handle(event);
      if (!this.finished) throw new Error("Claude CLI ended the turn without a result");
    } catch (error) {
      if (!this.finished) this.fail(this.options.describeFailure(error));
    }
  }

  /**
   * Stop the CLI. Idempotent. A response still attached (the registry evicting
   * a live turn) ends as interrupted; one whose client already left is gone.
   */
  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.abortController.abort();
    this.release("This turn was cancelled; the call was not run.");
    if (this.stream) this.endStream({ error: new Error("turn cancelled"), reason: INCOMPLETE_REASON_INTERRUPTED, limit: null });
    this.options.registry.remove(this);
  }

  private handle(event: ClaudeCliEvent): void {
    this.reporter?.heartbeat();
    const stream = this.stream;
    switch (event.kind) {
      case "message_start":
        this.messageOpen = true;
        return;
      case "message_stop":
        this.messageOpen = false;
        this.scheduleGather();
        return;
      case "block_stop":
        stream?.closeBlocks();
        return;
      case "thinking":
        stream?.thinking(event.text);
        return;
      case "text":
        this.lastText += event.text;
        stream?.text(event.text);
        return;
      case "native_tool":
        stream?.progress(nativeToolSummary(event.name, event.input));
        return;
      case "complete":
        this.complete(event);
        return;
    }
  }

  private complete(event: Extract<ClaudeCliEvent, { kind: "complete" }>): void {
    // The CLI's final result is authoritative; stream only what it adds.
    if (event.text && event.text !== this.lastText && !this.lastText.endsWith(event.text)) {
      this.stream?.text(event.text.startsWith(this.lastText) ? event.text.slice(this.lastText.length) : event.text);
    }
    this.finished = true;
    this.release("This turn has ended; the call was not run.");
    const stream = this.stream;
    this.detach();
    stream?.complete(event.usage);
    this.reporter?.finished();
    this.options.registry.remove(this);
  }

  private fail(failure: TurnFailure): void {
    this.finished = true;
    this.release("This turn failed; the call was not run.");
    if (this.stream) {
      this.endStream(failure);
      this.options.registry.remove(this);
      return;
    }
    // Parked: the next continuation request is the one that reports it.
    this.stashedFailure = failure;
    this.startParkTimer();
  }

  private endStream(failure: TurnFailure): void {
    const stream = this.stream;
    this.detach();
    stream?.fail(failure, "claude");
    this.reporter?.failed();
  }

  private scheduleGather(): void {
    if (this.gatherTimer || this.queued.length === 0) return;
    this.gatherTimer = setTimeout(() => {
      this.gatherTimer = null;
      this.emitQueuedCalls();
    }, this.options.gatherMs ?? 25);
  }

  /**
   * Hand every gathered call to Codex and end this response.
   *
   * Waits for the CLI's current message to finish, so parallel calls from one
   * assistant message go out together as one step, the way Codex expects a
   * model's tool calls to arrive.
   */
  private emitQueuedCalls(): void {
    const stream = this.stream;
    if (this.finished || !stream || this.messageOpen || this.queued.length === 0) return;
    for (const call of this.queued.splice(0)) {
      const callId = `call_${this.id}_${++this.sequence}`;
      const item = codexToolCallItem(call.tool, call.args, { itemId: `${call.tool.kind === "custom" ? "ctc" : "fc"}_${hex(12)}`, callId });
      this.awaiting.set(callId, { tool: call.tool, emittedAt: Date.now(), resolve: call.resolve });
      this.options.registry.bindCall(callId, this);
      stream.toolCall(item);
      this.reporter?.toolRequested(call.tool.name, callId);
    }
    this.detach();
    stream.complete();
    this.reporter?.finished();
    this.startParkTimer();
  }

  private detach(): void {
    this.stream = null;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private release(message: string): void {
    if (this.gatherTimer) clearTimeout(this.gatherTimer);
    this.gatherTimer = null;
    this.clearParkTimer();
    for (const call of this.queued.splice(0)) call.resolve(toolErrorResult(message));
    for (const call of this.awaiting.values()) call.resolve(toolErrorResult(message));
    this.awaiting.clear();
  }

  private startParkTimer(): void {
    this.clearParkTimer();
    this.parkTimer = setTimeout(() => {
      this.parkTimer = null;
      if (this.stashedFailure) {
        this.options.registry.remove(this);
        return;
      }
      this.cancel();
    }, this.options.parkMs);
    this.parkTimer.unref?.();
  }

  private clearParkTimer(): void {
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = null;
  }
}

/** The one-line record of a web-research step Claude took with its own tools. */
export function nativeToolSummary(name: string, input: JsonRecord): string {
  if (name === "WebSearch") return typeof input.query === "string" ? `Searched the web: ${input.query}` : "Searched the web";
  return typeof input.url === "string" ? `Fetched ${input.url}` : "Fetched a web page";
}

/**
 * Live turns, reachable by id (from the shim) and by the call ids they
 * emitted (from Codex's continuation requests).
 */
export class ClaudeTurnRegistry {
  private readonly turns = new Map<string, ClaudeTurn>();
  private readonly calls = new Map<string, ClaudeTurn>();
  private readonly maxTurns: number;

  constructor(maxTurns = 32) {
    this.maxTurns = maxTurns;
  }

  add(turn: ClaudeTurn): void {
    // Bounded: an abandoned turn is reclaimed by its park timer, and this cap
    // keeps a burst of them from holding unbounded CLI processes meanwhile.
    while (this.turns.size >= this.maxTurns) {
      const oldest = this.turns.values().next().value;
      if (!oldest) break;
      oldest.cancel();
    }
    this.turns.set(turn.id, turn);
  }

  bindCall(callId: string, turn: ClaudeTurn): void {
    this.calls.set(callId, turn);
  }

  byId(id: string): ClaudeTurn | null {
    return this.turns.get(id) ?? null;
  }

  /** The turn waiting on any of these call outputs, if one is still alive. */
  forOutputs(outputs: Map<string, unknown>): ClaudeTurn | null {
    for (const callId of outputs.keys()) {
      const turn = this.calls.get(callId);
      if (turn) return turn;
    }
    return null;
  }

  remove(turn: ClaudeTurn): void {
    this.turns.delete(turn.id);
    for (const [ callId, owner ] of this.calls) if (owner === turn) this.calls.delete(callId);
  }

  status(): { turns: number; maxTurns: number } {
    return { turns: this.turns.size, maxTurns: this.maxTurns };
  }
}
