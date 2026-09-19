#!/usr/bin/env node

/**
 * Local OpenAI Responses adapter that serves Claude, through the authenticated
 * Claude CLI, as the model behind a Codex agent turn.
 *
 * Claude is a model here, not a second agent runtime. The CLI runs with its
 * built-in tools disabled; the only tools it has are Codex's own, mirrored
 * from the request (src/providers/claude-codex-tools.ts). Every call Claude
 * makes is emitted to Codex, which executes it in the turn's sandbox, runs its
 * hooks, and shows it in the app, while the CLI stays parked on the call until
 * Codex returns the output (src/providers/claude-turn.ts). The one exception is
 * web research: Codex's hosted web search is not something a tool script can
 * perform, so when Codex offers it the CLI keeps its own WebSearch/WebFetch and
 * each use is recorded in the thread as a finished step.
 *
 * The adapter keeps the CLI's OAuth-only environment. It mirrors the
 * Antigravity and Copilot bridges' transport, telemetry, and boundary
 * conventions; pure helpers stay importable for tests without taking the port
 * out from under the running bridge.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveCwd, WorkspaceResolutionError } from "../shared/resolve-workspace.ts";
import { resolveAgentRole } from "../agents/bridge-role.ts";
import { roleContract } from "../shared/execution-contract.ts";
import { classifyCliLimit, INCOMPLETE_REASON_INTERRUPTED, INCOMPLETE_REASON_PROVIDER_LIMIT, INCOMPLETE_REASON_TIMEOUT, limitPayload, limitResponseHeaders, retryAfterSecondsFromLimit } from "../shared/provider-limits.ts";
import type { LimitSource, ProviderLimit } from "../shared/provider-limits.ts";
import { resolveAgentEventReporter } from "../telemetry/agent-events.ts";
import type { AgentEventReporter } from "../telemetry/agent-events.ts";
import { CODEX_TOOLS_SERVER, codexToolReference, codexToolSurface, renderCodexTranscript } from "./claude-codex-tools.ts";
import { awaitedToolResults } from "../shared/responses-continuation.ts";
import type { CodexToolSurface } from "./claude-codex-tools.ts";
import { ClaudeTurn, ClaudeTurnRegistry, ResponseStream } from "./claude-turn.ts";
import type { ClaudeCliEvent, TurnFailure, TurnReporter } from "./claude-turn.ts";

// Bind the port only when run as a program, so this file can be imported for
// its pure helpers without taking the port out from under the running bridge.
// Mirrors the Antigravity, MiniMax, and Copilot adapters.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const HOST = process.env.CLAUDE_BRIDGE_HOST ?? "127.0.0.1";
// Overridable so a second instance can be exercised without taking the port out
// from under the running service, matching the MiniMax and Antigravity proxies.
// The launchd service sets neither and keeps the default.
const PORT = Number.parseInt(process.env.CLAUDE_BRIDGE_PORT ?? "4000", 10);
const MODEL = "claude-subscription";
const AUTH_TOKEN = process.env.LITELLM_API_KEY ?? "";
const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT ?? null;
// How long the CLI may go silent while it is generating. Time the turn spends
// waiting on Codex to run a tool does not count: that is Codex's work, not a
// stalled CLI.
const CLAUDE_TIMEOUT_SECONDS = Number.parseFloat(process.env.CLAUDE_CODE_BRIDGE_TIMEOUT_SECONDS ?? "900");
// How long a parked turn waits for Codex to return a tool's output before its
// CLI is reclaimed. Generous, because the output may be a question put to the
// user; a turn that outlives it resumes from the transcript on a fresh CLI.
const CLAUDE_PARK_SECONDS = Number.parseFloat(process.env.CLAUDE_CODE_BRIDGE_PARK_SECONDS ?? "1800");
const CLI = process.env.CLAUDE_BIN ?? join(process.env.HOME ?? homedir(), ".local/bin/claude");
const DEFAULT_CLAUDE_MODEL = "sonnet";
const DEFAULT_CLAUDE_EFFORT = "medium";
// The only built-in tools the CLI ever keeps, and only when Codex offered its
// hosted web search on the turn. Anything else built in would act inside this
// process, where neither Codex nor the user can see it.
const CLAUDE_WEB_TOOLS = [ "WebSearch", "WebFetch" ];
export const CLAUDE_MCP_EXPOSURE_SOURCE = "role_contract";

// Provider payloads are JSON-shaped but intentionally retain fields this
// bridge does not own (the Claude CLI's event stream is not a formally
// specified schema). Keep that dynamic edge explicit while the transport,
// telemetry, and boundary operations around it stay typed. Mirrors the
// Antigravity, MiniMax, and Copilot adapters.
type JsonRecord = Record<string, unknown>;

const _CLAUDE_MODEL_PATTERN = /^claude-[A-Za-z0-9][A-Za-z0-9.-]*$/;
const _CLAUDE_FAMILY_NAMES = new Set([ "sonnet", "opus", "haiku" ]);
const _CLAUDE_EFFORT_LEVELS = new Set([ "low", "medium", "high", "xhigh", "max" ]);

/**
 * Claude rejected the request because an account/session limit applies.
 *
 * Carries the limit structurally as well as in the message: the router needs
 * the class and the real reset time to decide how long to stop routing here,
 * and re-deriving either by matching this message's prose is exactly the
 * guessing this field set exists to end.
 */
export class ClaudeRateLimitError extends Error {
  readonly limitClass: string;
  readonly limitType: string | null;
  readonly resetsAt: string | null;
  readonly source: string;
  constructor(message: string, limitClass = "session_limit", limitType: string | null = null, resetsAt: string | null = null, source: string) {
    super(message);
    this.name = "ClaudeRateLimitError";
    this.limitClass = limitClass;
    this.limitType = limitType;
    this.resetsAt = resetsAt;
    this.source = source;
  }
  /** The wire shape the router reads from `error.limit` or `incomplete_details.provider_limit`. */
  toLimit(): ProviderLimit {
    const limit: ProviderLimit = { limitClass: this.limitClass as ProviderLimit["limitClass"], limitType: this.limitType, source: this.source as LimitSource };
    if (this.resetsAt !== null) limit.resetsAt = this.resetsAt;
    return limit;
  }
}

/** Claude temporarily reported capacity pressure. */
export class ClaudeOverloadedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeOverloadedError";
  }
}

export function resolvedModel(requested: unknown): string {
  if (typeof requested !== "string") return DEFAULT_CLAUDE_MODEL;
  const candidate = requested.trim();
  if (!candidate) return DEFAULT_CLAUDE_MODEL;
  const lowered = candidate.toLowerCase();
  if (lowered.startsWith("claude-subscription") || lowered.startsWith("anthropic.")) return DEFAULT_CLAUDE_MODEL;
  if (_CLAUDE_FAMILY_NAMES.has(lowered)) return lowered;
  if (_CLAUDE_MODEL_PATTERN.test(candidate)) return candidate;
  return DEFAULT_CLAUDE_MODEL;
}

export function resolveClaudeEffort(requested: unknown): string {
  if (typeof requested !== "string") return DEFAULT_CLAUDE_EFFORT;
  const candidate = requested.trim().toLowerCase();
  return _CLAUDE_EFFORT_LEVELS.has(candidate) ? candidate : DEFAULT_CLAUDE_EFFORT;
}

function requestedEffort(request: JsonRecord): unknown {
  const reasoning = request.reasoning;
  if (reasoning && typeof reasoning === "object" && "effort" in reasoning) return (reasoning as JsonRecord).effort;
  for (const key of [ "model_reasoning_effort", "reasoning_effort" ]) {
    if (key in request) return request[key];
  }
  return null;
}

/** The model shape expected by current Codex model discovery. */
export function claudeModelMetadata(): JsonRecord {
  return {
    slug: MODEL,
    apply_patch_tool_type: "freeform",
    base_instructions: "You are a bounded external-provider Codex agent.",
    display_name: "Claude Code subscription",
    description: "Claude Code OAuth subscription through the local bridge.",
    default_reasoning_level: DEFAULT_CLAUDE_EFFORT,
    default_reasoning_summary: "none",
    default_verbosity: "low",
    supported_reasoning_levels: [ "low", "medium", "high" ].map((effort) => ({ effort, description: `Claude Code ${effort} reasoning` })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: 200000,
    max_context_window: 200000,
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
    comp_hash: "local-claude-bridge",
    effective_context_window_percent: 95,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as JsonRecord[]).map((block) => {
    if (typeof block === "string") return block;
    if (typeof block === "object" && block) {
      const text = (block as JsonRecord).text;
      if (typeof text === "string") return text;
    }
    return "";
  }).join("");
}

// Build Claude's own structural error from its `rate_limit_event`.
//
// This is the one place a Claude limit is *reported* rather than inferred, so
// it is the only path that hands the router a reset time it will trust.
export function rateLimitEventError(event: JsonRecord): ClaudeRateLimitError | null {
  const rateInfo = event.rate_limit_info;
  if (!rateInfo || typeof rateInfo !== "object") return null;
  const info = rateInfo as JsonRecord;
  const status = info.status;
  if (!status || status === "allowed") return null;
  const limitType = info.rateLimitType ?? "session";
  const resetsAt = normalizeResetsAt(info.resetsAt);
  // A rejected weekly or billing window is exhaustion until it resets; a
  // rejected session window is a session limit; anything else is throttling
  // that clears on its own.
  let limitClass = "throttled";
  if (/week|month|quota|billing|credit/i.test(String(limitType))) limitClass = "quota_exhausted";
  else if (status === "rejected") limitClass = "session_limit";
  let message = `Claude rate limit (${limitType}): status is ${status}`;
  if (resetsAt) message += ` (resets at ${resetsAt})`;
  return new ClaudeRateLimitError(message, limitClass, String(limitType), resetsAt, "reported");
}

export function classifyClaudeError(message: unknown, errorCode: unknown): typeof ClaudeRateLimitError | typeof ClaudeOverloadedError | null {
  const text = String(message ?? "");
  if (errorCode === "rate_limit" || /rate.?limit|weekly.?limit|quota|credit|session.?limit|too many requests/i.test(text)) {
    return ClaudeRateLimitError;
  }
  if (errorCode === "overloaded_error" || /overload|high.?demand|capacity/i.test(text)) {
    return ClaudeOverloadedError;
  }
  return null;
}

export function raiseClassifiedClaudeError(message: unknown, errorCode: unknown): void {
  const errorType = classifyClaudeError(message, errorCode);
  if (!errorType) return;
  if (errorType === ClaudeRateLimitError) {
    // An error message is free text, so whatever it yields stays `inferred`
    // and cannot trigger a long hard cooldown downstream.
    const limit = classifyCliLimit(message);
    throw new ClaudeRateLimitError(
      String(message),
      limit?.limitClass ?? "throttled",
      limit?.limitType ?? null,
      limit?.resetsAt ?? null,
      "inferred",
    );
  }
  throw new ClaudeOverloadedError(String(message));
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord | null> {
  let body = "";
  for await (const chunk of request) body += chunk;
  try { return JSON.parse(body) as JsonRecord; } catch { return null; }
}

export function claudeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    // These authenticate only the local router-to-bridge hop; never pass
    // them through to the OAuth-authenticated Claude CLI subprocess.
    "LITELLM_API_KEY",
    "LITELLM_MASTER_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    delete environment[key];
  }
  // Claude Code ships its own skill catalogue, none of which is AutoDev
  // policy. A bridge turn is governed by the role prompts and the target
  // repository's own skills, so the bundled set is dead weight in the context
  // window and a second, unversioned source of instructions.
  environment.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1";
  if (!environment.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not available to the Claude bridge");
  }
  return environment;
}

/** Normalize a provider-supplied reset time to an ISO-8601 UTC string. */
export function normalizeResetsAt(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let ms: number | null = null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds and epoch milliseconds are told apart by magnitude: a
    // seconds value large enough to be ambiguous would be in the year 33658.
    ms = value > 1e11 ? value : value * 1000;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      ms = numeric > 1e11 ? numeric : numeric * 1000;
    } else {
      const parsed = Date.parse(trimmed);
      ms = Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Reassembles streamed `tool_use` blocks into completed calls.
 *
 * Claude opens a tool_use block with an empty `input` and streams the
 * arguments as `input_json_delta` fragments, so `content_block_start` carries
 * the tool name but never the arguments. Blocks are emitted on
 * `content_block_stop`, with the accumulated arguments parsed back into
 * `input`.
 */
export class ToolUseAccumulator {
  private readonly open = new Map<number, [ JsonRecord, string[] ]>();
  /** Returns a completed block on `content_block_stop`, else null. */
  feed(inner: JsonRecord): JsonRecord | null {
    const index = inner.index;
    if (inner.type === "content_block_start") {
      const block = inner.content_block;
      if (block && typeof block === "object" && (block as JsonRecord).type === "tool_use") {
        this.open.set(Number(index), [ block as JsonRecord, [] ]);
      }
      return null;
    }
    if (inner.type === "content_block_delta") {
      const delta = inner.delta;
      if (delta && typeof delta === "object" && (delta as JsonRecord).type === "input_json_delta" && typeof index === "number") {
        this.open.get(index)?.[1].push(String((delta as JsonRecord).partial_json ?? ""));
      }
      return null;
    }
    if (inner.type !== "content_block_stop" || typeof index !== "number") return null;
    const entry = this.open.get(index);
    if (!entry) return null;
    this.open.delete(index);
    const [ block, fragments ] = entry;
    let input: JsonRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(fragments.join(""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as JsonRecord;
    } catch {
      input = null;
    }
    return { ...block, input: input ?? block.input };
  }
}

/**
 * How a bridged turn is to act. Deliberately not the role policy: that is in
 * Codex's own developer instructions, which open the conversation Claude
 * receives, exactly as they would for a Codex-native model.
 */
export function systemPrompt(cwd: string, surface: CodexToolSurface): string {
  const names = new Set(surface.tools.map((tool) => tool.name));
  const tools = surface.tools.length === 0
    ? "No tools are available on this turn; answer from the conversation alone."
    : [
      "You act only through the tools in this session. They are the agent's Codex tools: Codex runs each call in the workspace under the turn's sandbox, approval policy, and hooks, shows it to the user, and returns its output to you.",
      ...(names.has("exec") ? [ "`exec` runs JavaScript whose `tools` global carries the agent's full tool set -- shell commands, file patches, MCP servers, and, for an orchestrator, subagent management. Its description lists them. Read files and skills through these tools, as the instructions describe." ] : []),
    ].join(" ");
  const web = surface.webSearch ? "\n\nWeb research uses your own WebSearch and WebFetch tools." : "";
  return [
    "You are the model behind a Codex agent. The conversation that follows is that agent's own context, exactly as Codex keeps it: its developer instructions, which govern you; the user's messages; the agent's earlier replies; and every tool call with its output. Continue it from where it ends.",
    `${tools}${web}`,
    "Your final message is the agent's reply for this turn.",
    `## Workspace\n\nWorking directory: ${cwd}\nPlatform: ${process.platform}`,
    ...(surface.tools.length > 0 ? [ `## Codex tools\n\n${codexToolReference(surface.tools)}` ] : []),
  ].join("\n\n");
}

/** The MCP server that offers this turn Codex's tools. */
export function codexToolsMcpConfig(turnId: string): string {
  const shim = resolve(join(import.meta.dirname, "..", "mcp", "codex-tools-shim.ts"));
  return JSON.stringify({
    mcpServers: {
      [CODEX_TOOLS_SERVER]: {
        command: process.env.AUTODEV_NODE_BIN ?? "node",
        args: [ shim ],
        env: { AUTODEV_BRIDGE_URL: `http://${HOST}:${PORT}`, AUTODEV_BRIDGE_TOKEN: AUTH_TOKEN, AUTODEV_CLAUDE_TURN: turnId },
      },
    },
  });
}

export interface ClaudeCliOptions {
  systemPrompt: string;
  /** The turn whose Codex tools the CLI is offered; null when Codex offered none. */
  turnId: string | null;
  webSearch: boolean;
}

/** Build the CLI argv for one Claude turn. The prompt itself goes in on stdin. */
export function claudeCliArgs(model: string, effort: string, options: ClaudeCliOptions): string[] {
  const builtIns = options.webSearch ? CLAUDE_WEB_TOOLS : [];
  const allowed = [ ...builtIns, ...(options.turnId ? [ `mcp__${CODEX_TOOLS_SERVER}` ] : []) ];
  return [
    CLI,
    "-p",
    "--model", model,
    "--effort", effort,
    // An empty list disables every built-in tool, Agent/Task and the shell
    // included: those would act inside this process, invisible to Codex.
    "--tools", builtIns.join(","),
    // Only the servers named here: user-level ~/.claude.json servers and a
    // workspace's .mcp.json never add tools that bypass Codex.
    "--strict-mcp-config",
    ...(options.turnId ? [ "--mcp-config", codexToolsMcpConfig(options.turnId) ] : []),
    ...(allowed.length > 0 ? [ "--allowed-tools", allowed.join(",") ] : []),
    "--permission-mode",
    // Codex, not the CLI, owns approvals: its tools run under the turn's own
    // approval policy, so the CLI must not stop to ask about calling them.
    process.env.CLAUDE_CODE_PERMISSION_MODE ?? "bypassPermissions",
    // Replace rather than append: the CLI's default prompt carries harness
    // guidance for tools this turn does not have.
    "--system-prompt", options.systemPrompt,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
    "--no-chrome",
  ];
}

interface ClaudeStreamOptions extends ClaudeCliOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Aborting kills the CLI: the turn was cancelled or its client went away. */
  signal: AbortSignal;
  /** True while the CLI is blocked on a tool Codex is running. */
  waitingOnCodex: () => boolean;
}

/**
 * Run the CLI for one turn and translate its stream-json into turn events.
 *
 * The prompt is written to stdin rather than passed as an argument: it is the
 * whole Codex transcript, which can exceed the platform's argument limit.
 */
export async function* runClaudeStream(prompt: string, model: string, effort: string, options: ClaudeStreamOptions): AsyncGenerator<ClaudeCliEvent, void, void> {
  const argv = claudeCliArgs(model, effort, options);
  const child = spawn(CLI, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: [ "pipe", "pipe", "pipe" ] });
  // A CLI that exits before reading its prompt must not take the bridge down.
  child.stdin.on("error", () => undefined);
  child.stdin.end(prompt);
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  options.signal.addEventListener("abort", kill, { once: true });

  let stderr = "";
  let terminalResult: JsonRecord | null = null;
  let sawStreamText = false;
  let assistantSnapshot = "";
  const toolUses = new ToolUseAccumulator();

  const lines = createInterface({ input: child.stdout });
  const lineQueue: string[] = [];
  let resolveNext: (() => void) | null = null;
  lines.on("line", (line: string) => {
    lineQueue.push(line);
    if (resolveNext) resolveNext();
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const childClosed = new Promise<void>((resolveClose) => { child.once("close", () => resolveClose()); });

  try {
    for (;;) {
      while (lineQueue.length > 0) {
        const line = lineQueue.shift()!;
        let event: JsonRecord;
        try {
          event = JSON.parse(line) as JsonRecord;
        } catch {
          // Stderr that landed on stdout (it happens): skip but keep draining.
          continue;
        }
        const eventType = event.type;
        if (eventType === "rate_limit_event") {
          const rateError = rateLimitEventError(event);
          if (rateError !== null) throw rateError;
          continue;
        }
        if (event.is_api_error_message || event.error === "rate_limit" || event.error === "overloaded_error") {
          const errMsg = textFromContent((event.message as JsonRecord | undefined)?.content) || String(event.error ?? "Claude API error");
          raiseClassifiedClaudeError(errMsg, event.error);
          continue;
        }
        if (eventType === "stream_event" && event.event && typeof event.event === "object") {
          const inner = event.event as JsonRecord;
          const completedTool = toolUses.feed(inner);
          if (inner.type === "message_start") yield { kind: "message_start" };
          else if (inner.type === "message_stop") yield { kind: "message_stop" };
          else if (inner.type === "content_block_delta") {
            const delta = inner.delta as JsonRecord | undefined;
            if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") yield { kind: "thinking", text: delta.thinking };
            else if (delta?.type === "text_delta" && typeof delta.text === "string") {
              sawStreamText = true;
              yield { kind: "text", text: delta.text };
            }
          } else if (inner.type === "content_block_stop") {
            // A Codex tool call is carried by the shim, which has its
            // arguments; only the CLI's own web tools are recorded from here.
            // Any other name is a tool the CLI does not have, which it
            // rejects without running.
            const name = typeof completedTool?.name === "string" ? completedTool.name : "";
            if (completedTool && options.webSearch && CLAUDE_WEB_TOOLS.includes(name)) {
              const input = completedTool.input && typeof completedTool.input === "object" ? completedTool.input as JsonRecord : {};
              yield { kind: "native_tool", name, input };
            }
            yield { kind: "block_stop" };
          }
        } else if (eventType === "assistant") {
          // The CLI's snapshot of a finished message. Its text is streamed
          // already unless this CLI emitted no partial messages at all.
          if (!sawStreamText) {
            const fullText = textFromContent((event.message as JsonRecord | undefined)?.content);
            const delta = fullText.startsWith(assistantSnapshot) ? fullText.slice(assistantSnapshot.length) : fullText;
            assistantSnapshot = fullText;
            if (delta) yield { kind: "text", text: delta };
          }
          yield { kind: "message_stop" };
        } else if (eventType === "result") {
          terminalResult = event;
          if (event.is_error) {
            const message = String(event.result ?? "Claude CLI returned an error");
            raiseClassifiedClaudeError(message, undefined);
            throw new Error(message);
          }
        }
      }
      if (terminalResult !== null) break;
      if (options.signal.aborted) throw new Error("Claude turn cancelled");
      const next = new Promise<void>((resolveLine) => { resolveNext = () => resolveLine(); });
      const raced = await Promise.race([
        next,
        childClosed.then(() => "close" as const),
        new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), CLAUDE_TIMEOUT_SECONDS * 1000)),
      ]);
      resolveNext = null;
      if (raced === "close") {
        // Lines the CLI wrote just before exiting are still queued.
        if (lineQueue.length > 0) continue;
        break;
      }
      if (raced === "timeout" && !options.waitingOnCodex()) {
        kill();
        await childClosed.catch(() => undefined);
        throw new Error(`Claude CLI timed out after ${CLAUDE_TIMEOUT_SECONDS}s`);
      }
    }
    if (terminalResult === null) {
      if (options.signal.aborted) throw new Error("Claude turn cancelled");
      throw new Error(`Claude CLI exited without a terminal result event: ${stderr.slice(-4000)}`);
    }
    const usage = (terminalResult.usage as JsonRecord | undefined) ?? {};
    yield {
      kind: "complete",
      text: String(terminalResult.result ?? ""),
      usage: { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0) },
    };
  } finally {
    options.signal.removeEventListener("abort", kill);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      kill();
      await childClosed.catch(() => undefined);
    }
  }
}


function sendJson(response: ServerResponse, status: number, body: JsonRecord, extraHeaders: Record<string, string | number> = {}): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close", ...extraHeaders });
  response.end(encoded);
}

// Live turns, parked or streaming. See src/providers/claude-turn.ts.
const turns = new ClaudeTurnRegistry();

/** How an error ends a turn: a provider limit, a timeout, or an interruption. */
export function describeFailure(error: unknown): TurnFailure {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Claude upstream failure: ${message}`);
  const limit = error instanceof ClaudeRateLimitError ? error.toLimit() : (message ? classifyCliLimit(message) : null);
  const reason = limit
    ? INCOMPLETE_REASON_PROVIDER_LIMIT
    : error instanceof ClaudeOverloadedError || /timed out/i.test(message) ? INCOMPLETE_REASON_TIMEOUT : INCOMPLETE_REASON_INTERRUPTED;
  return { error, reason, limit };
}

/**
 * Router telemetry for one request. A tool call is reported as requested on
 * the request that emits it and as executed on the request that returns its
 * output -- the same attribution the MiniMax adapter uses, with the duration
 * measured exactly because the bridge holds both ends.
 */
function turnReporter(agentEvents: AgentEventReporter | null): TurnReporter {
  return {
    toolRequested(tool, callId) {
      if (!agentEvents) return;
      void agentEvents.reportToolRequested({ tool, callId, server: null });
      void agentEvents.reportActivity({ state: tool === "request_user_input" ? "user_wait" : "tool_wait" });
    },
    toolExecuted(tool, callId, durationMs, status) {
      if (!agentEvents) return;
      void agentEvents.reportToolExecuted({ tool, callId, status, server: null, durationMs });
      void agentEvents.reportActivity({ state: "resumed" });
    },
    finished() { if (agentEvents) void agentEvents.reportActivity({ state: "finished" }); },
    failed() { if (agentEvents) void agentEvents.reportActivity({ state: "failed" }); },
    heartbeat() { if (agentEvents) void agentEvents.reportHeartbeat({ minIntervalMs: 5000 }); },
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", turns: turns.status() });
    return;
  }
  // The tools shim runs as a grandchild of this bridge and reaches back over
  // the same loopback port, behind the same bearer check.
  if (pathname === "/v1/bridge-tools/list" || pathname === "/v1/bridge-tools/call") {
    if (AUTH_TOKEN && request.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      sendJson(response, 401, { error: "invalid local gateway key" });
      return;
    }
    const body = await readJsonBody(request);
    const turn = turns.byId(typeof body?.turn === "string" ? body.turn : "");
    if (pathname.endsWith("/list")) {
      sendJson(response, 200, { tools: turn ? turn.toolDefinitions() : [] });
      return;
    }
    if (!turn) {
      sendJson(response, 409, { error: "This Claude turn is no longer active; the call was not run." });
      return;
    }
    const result = await turn.requestTool(typeof body?.name === "string" ? body.name : "", body?.arguments ?? {});
    if (!response.destroyed) sendJson(response, 200, result);
    return;
  }
  if (pathname === "/v1/models") {
    sendJson(response, 200, { object: "list", data: [ { id: MODEL, object: "model", owned_by: "anthropic" } ], models: [ claudeModelMetadata() ] });
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

  const payload = await readJsonBody(request);
  if (!payload) {
    sendJson(response, 400, { error: { type: "invalid_request_error", message: "invalid JSON" } });
    return;
  }
  const model = resolvedModel(payload.model);
  const effort = resolveClaudeEffort(requestedEffort(payload));
  // The router classifies the turn; only it can tell this bridge which role
  // it is serving.
  const agentRole = resolveAgentRole(request.headers as Record<string, unknown>);
  const agentEvents = resolveAgentEventReporter(request.headers as Record<string, unknown>);
  let cwd: string;
  try {
    cwd = resolveCwd(payload, request.headers as Record<string, string | string[] | undefined>, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    console.error(`claude workspace resolution failed: ${error.message}`);
    sendJson(response, 400, { error: { type: "invalid_request_error", message: error.message } });
    return;
  }
  if (agentEvents) {
    for (const server of roleContract(agentRole).mcp ?? []) {
      void agentEvents.reportMcpExposed({ server, source: CLAUDE_MCP_EXPOSURE_SOURCE });
    }
  }

  const stream = new ResponseStream({ response, streaming: Boolean(payload.stream), model: String(payload.model ?? model), sendError: handleNonStreamingError });
  const reporter = turnReporter(agentEvents);
  const awaited = awaitedToolResults(payload.input);
  const parked = awaited.outputs.size > 0 ? turns.forOutputs(awaited.outputs) : null;
  if (parked) {
    console.error(`claude continuing turn=${parked.id} results=${awaited.outputs.size} messages=${awaited.messages.length}`);
    parked.attach(stream, reporter, awaited);
    return;
  }

  let environment: NodeJS.ProcessEnv;
  try {
    environment = claudeEnvironment();
  } catch (error) {
    handleNonStreamingError(response, describeFailure(error));
    reporter.failed();
    return;
  }
  const surface = codexToolSurface(payload);
  const turn = new ClaudeTurn({ tools: surface.tools, registry: turns, parkMs: CLAUDE_PARK_SECONDS * 1000, describeFailure });
  console.error(`claude request model=${model} effort=${effort} role=${agentRole ?? "default"} cwd=${cwd} turn=${turn.id} tools=${JSON.stringify(surface.tools.map((tool) => tool.name))} web_search=${surface.webSearch}`);
  turn.attach(stream, reporter);
  void turn.run(runClaudeStream(renderCodexTranscript(payload.input ?? ""), model, effort, {
    cwd,
    // A parked call must not time out inside the CLI before the turn does.
    env: { ...environment, MCP_TOOL_TIMEOUT: String(Math.ceil(CLAUDE_PARK_SECONDS * 1000)) },
    signal: turn.signal,
    waitingOnCodex: () => turn.waitingOnCodex,
    systemPrompt: systemPrompt(cwd, surface),
    turnId: surface.tools.length > 0 ? turn.id : null,
    webSearch: surface.webSearch,
  }));
}

function handleNonStreamingError(response: ServerResponse, failure: TurnFailure): void {
  const { error, limit } = failure;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ClaudeRateLimitError) {
    const retryAfter = retryAfterSecondsFromLimit(limit);
    const extra: Record<string, string | number> = { ...limitResponseHeaders(limit) };
    if (retryAfter !== null) extra["retry-after"] = String(retryAfter);
    sendJson(response, 429, { error: { message, type: "rate_limit_error", limit: limitPayload(limit) } }, extra);
    return;
  }
  if (error instanceof ClaudeOverloadedError) {
    const capacity: ProviderLimit = { limitClass: "capacity", limitType: "capacity", resetsAt: null, source: "inferred" };
    const retryAfter = retryAfterSecondsFromLimit(capacity);
    const extra: Record<string, string | number> = { ...limitResponseHeaders(capacity) };
    if (retryAfter !== null) extra["retry-after"] = String(retryAfter);
    sendJson(response, 503, { error: { message, type: "overloaded_error", limit: limitPayload(capacity) } }, extra);
    return;
  }
  if (message && /timed out/i.test(message)) {
    sendJson(response, 504, { error: { message: "Claude CLI timed out", type: "timeout_error" } });
    return;
  }
  sendJson(response, 502, { error: { message, type: "upstream_error" } });
}

if (IS_MAIN) {
  const server = createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
    console.error(`Claude Responses proxy listening at http://${HOST}:${PORT}`);
  });
  // A turn's CLI is this process's child, and a child outlives a parent that
  // is merely signalled: every launchd restart or reinstall would leave parked
  // CLIs running, orphaned, still able to act on the workspace.
  for (const signal of [ "SIGTERM", "SIGINT" ] as const) {
    process.once(signal, () => {
      const cancelled = turns.cancelAll();
      if (cancelled > 0) console.error(`claude bridge stopping: cancelled ${cancelled} live turn(s)`);
      server.close();
      process.exit(0);
    });
  }
}
