/**
 * The opencli Responses bridge: Codex turns served by web chat sites.
 *
 * Codex -> Router -> this bridge (`127.0.0.1:4004`) -> `opencli <site> ...` ->
 * the user's signed-in browser tab on chatgpt.com or gemini.google.com.
 *
 * Each `opencli-<site>` model is one site. A turn is one opencli command: the
 * bridge renders the Codex conversation into a prompt (see `opencli-turn.ts`),
 * waits for the site's reply, and returns it as Responses output items. Tool
 * calls in the reply become `custom_tool_call`/`function_call` items that
 * Codex executes; nothing runs inside the site or this bridge.
 *
 * A site is one browser tab, so turns for the same site run one at a time.
 * Different sites run in parallel.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  isOrchestratorRole,
  resolveAgentRole,
  roleInstructions
} from "@simulatorlife/autodev-runtime/agents";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import {
  type OpencliCommand,
  resolveOpencliCommand
} from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  PROVIDER_REQUEST_UNSUPPORTED_TYPE,
  sendJson,
  sendUnsupportedRequestFailure
} from "@simulatorlife/autodev-runtime/shared/provider-http";
import {
  classifyCliLimit,
  limitPayload,
  limitResponseHeaders,
  retryAfterSecondsFromLimit,
  terminalIncompleteEvents
} from "@simulatorlife/autodev-runtime/shared/provider-limits";
import {
  OPENCLI_PROVIDER_SITES,
  OPENCLI_PROVIDERS,
  OPENCLI_SITES,
  opencliModel,
  opencliModelId,
  type OpencliProvider,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import { requestCarriesImageContent } from "@simulatorlife/autodev-runtime/shared/request-content";

import {
  type CodexTool,
  codexToolCallEvents,
  codexToolSurface
} from "./claude-codex-tools.ts";
import { turnId } from "./codex-tool-turns.ts";
import {
  attachedPromptFileName,
  CHATGPT_MODELS,
  compactCodexTools,
  OPENCLI_SITE_SPECS,
  type OpencliChatScope,
  OpencliCommandError,
  OpencliConversationLedger,
  type OpencliExec,
  type OpencliReply,
  type OpencliSiteSpec,
  opencliToolCallItem,
  parseOpencliOutput,
  parseOpencliReply,
  prefixDigests,
  renderOpencliContinuation,
  renderOpencliPrompt,
  transcriptSegments
} from "./opencli-turn.ts";

type JsonRecord = Record<string, unknown>;

export const PROVIDER = "opencli";
export const OPENCLI_ROUTER_AUTH_VARIABLE = "CODEX_ROUTER_OPENCLI_API_KEY";
const DEFAULT_PORT = 4004;
const DEFAULT_TURN_TIMEOUT_SECONDS = 600;
/**
 * The largest prompt a site that takes it on the command line is given.
 *
 * The bound is Gemini's composer, not the platform's argument limit (1 MiB):
 * the largest Gemini prompt that ever succeeded was 61 KB, a 150 KB prompt
 * lost its tab's debugger after 223 s, and a 300 KB one was still not taken
 * after 270 s. A first prompt over it is rendered again with MCP tools named
 * rather than documented; one still over it is refused, so the router moves
 * on to a route that can serve it.
 */
const MAX_ARGV_PROMPT_BYTES = 100_000;
/**
 * The largest prompt a site is given as an attachment.
 *
 * A site's page takes an attachment of any size, so this bound is not the
 * page's: it is the model's. A root orchestrator's tool reference carries
 * every MCP tool's declaration, and the prompt that carried 280 KB of it
 * took the model 85 seconds to say anything at all. The reference is
 * compressed rather than the conversation: the conversation is what the turn
 * is, and the reference is a listing the model can read the rest of from
 * inside `exec`.
 */
const MAX_ATTACHED_PROMPT_BYTES = 120_000;
/** opencli's own exit code for a timed-out command. */
const OPENCLI_TIMEOUT_EXIT_CODE = 75;
const LIMIT_STATUS_CLASSES = new Set([
  "throttled",
  "session_limit",
  "quota_exhausted"
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface OpencliRunRequest {
  readonly args: readonly string[];
  readonly signal: AbortSignal;
}

/** Runs one opencli command to completion and returns its result rows. */
export type OpencliRunner = (
  request: OpencliRunRequest
) => Promise<Record<string, unknown>[]>;

export interface OpencliBridgeOptions {
  readonly run: OpencliRunner;
  readonly authToken: string;
  readonly turnTimeoutSeconds: number;
  readonly ledger?: OpencliConversationLedger;
  /** Where per-turn prompt files are written; the OS temp dir by default. */
  readonly tempRoot?: string;
  /** How long to wait before re-trying a site session opencli reports busy. */
  readonly sessionBusyRetryMs?: number;
  /** How long to wait before re-trying a command the site was not ready for. */
  readonly unsentRetryMs?: number;
  /** Keep-alive cadence on a streamed turn. */
  readonly keepAliveMs?: number;
  /**
   * How old a site's model list may be before it is read again.
   *
   * The list is a background refresh: the bridge keeps the last good one and
   * asks again when it is this old. A test sets it to zero to exercise the
   * refresh on every read.
   */
  readonly modelListTtlMs?: number;
  /** How long a turn may run before the site is reported wedged (turnTimeoutSeconds + 30s by default). */
  readonly wedgedTimeoutMs?: number;
}

/** opencli's code for a site session another command still holds. */
const SESSION_BUSY = "SESSION_BUSY";
/**
 * The bridge's own code for a turn the site's single tab never became free for.
 *
 * The site is serving somebody else and opencli is working, so this is a
 * refusal of this request rather than an outage of the provider.
 */
const SITE_BUSY = "SITE_BUSY";
const DEFAULT_SESSION_BUSY_RETRY_MS = 5000;
const OUTPUT_ITEM_ADDED = "response.output_item.added";
/** opencli's code for a read that found nothing, e.g. a chat with no visible turns. */
const EMPTY_RESULT = "EMPTY_RESULT";
const DEFAULT_UNSENT_RETRY_MS = 3000;
const UNSENT_RETRIES = 2;

/**
 * Failures opencli reports before the prompt reached the site: the tab had no
 * composer yet, or an attachment never became ready. Nothing was sent, so the
 * command is safe to run again -- unlike a failure after sending, where a retry
 * would put the prompt in the chat twice. A ChatGPT turn failed this way when
 * its tab was still loading the conversation it had been asked to continue.
 *
 * The attachment failures are here for the same reason. opencli refuses to
 * attach a file when the ChatGPT page does not show exactly one file input it
 * can use -- the page carries several, and which ones are there depends on
 * what the page is showing at that moment. That refusal was the largest single
 * cause of failed opencli turns, and it was a terminal failure: the turn died
 * even though nothing had been sent. Each attempt of a turn navigates the tab
 * and rebuilds the composer, so the next attempt sees a different page and can
 * find the input the last one could not.
 */
const FAILED_BEFORE_SENDING =
  /requires an authenticated session with an active composer|requires a logged-in ChatGPT session with a visible composer|prompt was not sent|Could not find (?:Gemini|ChatGPT) composer|file input is missing|file input not found|active composer form not found/u;

const THREAD_ID_PATTERN = /^[\w.-]{1,128}$/u;

/**
 * The Codex thread a request belongs to: one agent -- a root or one subagent.
 * Codex names it in its turn metadata, which the router forwards, and in the
 * body's `client_metadata`; a root and its subagents share a session but never
 * a thread.
 */
function codexThread(
  request: IncomingMessage,
  payload: JsonRecord
): string | null {
  const header = request.headers["x-codex-turn-metadata"];
  const raw = Array.isArray(header) ? header[0] : header;
  let fromHeader: unknown;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    fromHeader = isRecord(parsed) ? parsed.thread_id : null;
  } catch {
    fromHeader = null;
  }
  const metadata = isRecord(payload.client_metadata)
    ? payload.client_metadata
    : {};
  for (const candidate of [fromHeader, metadata.thread_id]) {
    if (typeof candidate === "string" && THREAD_ID_PATTERN.test(candidate))
      return candidate;
  }
  return null;
}

function failedBeforeSending(error: OpencliCommandError): boolean {
  return FAILED_BEFORE_SENDING.test(error.message);
}

/**
 * The opencli daemon another version left running.
 *
 * opencli's daemon is shared machine-wide on one port, so a CLI of a
 * different version finds a daemon it cannot talk to and refuses the
 * command: the stale daemon was not replaced and the turn died before it
 * started. The CLI's own answer is to stop the daemon by hand; the bridge
 * owns the CLI it runs, so it stops the daemon itself and runs the command
 * again.
 */
const STALE_DAEMON = /stale daemon/iu;

/**
 * How a failed turn failed, as the router has to hear it.
 *
 * - `limit`: the site said the account is out of usage. The router cools the
 *   provider down for as long as the site says.
 * - `timeout`: the site did not answer in time. The request is not replayed
 *   against the same route.
 * - `not_sent`: the site never received the prompt -- the tab was not ready,
 *   the page had no composer, the attachment could not be made. The provider
 *   is healthy and nothing it holds was disturbed, so the turn is reported as
 *   a refusal: the router moves on to a route that can serve it and the
 *   provider is left serving the traffic it can serve. Cooling it down would
 *   push every other agent away from a working route because one browser tab
 *   was not ready yet.
 * - `failed`: the site took the prompt and the turn failed. The provider
 *   failed the request.
 */
type OpencliFailureKind = "limit" | "timeout" | "not_sent" | "failed";

function failureKind(error: unknown): OpencliFailureKind {
  const message = errorMessage(error);
  const exitCode = error instanceof OpencliCommandError ? error.exitCode : null;
  const limit = classifyCliLimit(message, exitCode);
  if (limit && LIMIT_STATUS_CLASSES.has(limit.limitClass)) return "limit";
  const code = error instanceof OpencliCommandError ? error.code : null;
  if (code === "TIMEOUT" || exitCode === OPENCLI_TIMEOUT_EXIT_CODE)
    return "timeout";
  if (
    error instanceof OpencliCommandError &&
    (failedBeforeSending(error) || code === SITE_BUSY)
  )
    return "not_sent";
  return "failed";
}

/**
 * The error type a failed turn is reported under.
 *
 * The router reads the type to tell a refusal from a provider failure: a
 * refusal moves the request to a route that can serve it and leaves the
 * provider alone, a provider failure cools it down.
 */
function failureErrorType(kind: OpencliFailureKind): string {
  if (kind === "not_sent") return PROVIDER_REQUEST_UNSUPPORTED_TYPE;
  if (kind === "timeout") return "timeout_error";
  return "opencli_proxy_error";
}
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
/** Keep-alive cadence on a streamed turn, well inside every idle timeout. */
const KEEP_ALIVE_MS = 15_000;
const MODEL_LIST_TIMEOUT_MS = 60_000;
/** How long a first listing waits for the site before answering unavailable. */
const FIRST_MODEL_LIST_WAIT_MS = 5000;

/**
 * Spawns opencli and collects its JSON result; aborting kills the process.
 *
 * opencli is resolved per turn rather than once at startup: a checkout whose
 * dependencies are missing then fails each turn with a 503 the router routes
 * around, instead of a bridge that crash-loops under launchd's KeepAlive.
 */
export function processRunner(
  resolveCommand: () => OpencliCommand,
  live: Set<ChildProcess> = new Set()
): OpencliRunner {
  return ({ args, signal }) =>
    new Promise((resolve, reject) => {
      const command = resolveCommand();
      const child = spawn(command.command, [...command.args, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
      live.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      const onAbort = () => {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          if (!child.killed) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* the process is already gone */
            }
          }
        }, 2000);
        if (typeof killTimer.unref === "function") killTimer.unref();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        live.delete(child);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (code) => {
        live.delete(child);
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new OpencliCommandError("turn cancelled", "CANCELLED", code));
          return;
        }
        try {
          resolve(parseOpencliOutput(stdout, code));
        } catch (error) {
          if (error instanceof OpencliCommandError && stderr.trim())
            error.message = `${error.message}; stderr: ${stderr.trim().slice(-800)}`;
          reject(error);
        }
      });
    });
}

/**
 * One queue per site. A site is one browser tab: two commands on it at once
 * would type into the same composer and read each other's replies.
 */
class SiteQueues {
  private readonly tails = new Map<OpencliSite, Promise<unknown>>();
  private readonly depth = new Map<OpencliSite, number>();
  private readonly activeSince = new Map<OpencliSite, number>();

  run<T>(site: OpencliSite, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(site) ?? Promise.resolve();
    this.depth.set(site, (this.depth.get(site) ?? 0) + 1);
    const next = previous
      .catch(() => {})
      .then(() => {
        this.activeSince.set(site, Date.now());
        return task();
      })
      .finally(() => {
        this.activeSince.delete(site);
        this.depth.set(site, (this.depth.get(site) ?? 1) - 1);
      });
    this.tails.set(site, next);
    return next;
  }

  activeSinceFor(site: OpencliSite): number | null {
    return this.activeSince.get(site) ?? null;
  }

  /**
   * Run a background task on the site's tab, but only while the tab is free.
   *
   * A background task is a refresh of what the site can answer, not a request:
   * it may be dropped and asked for again. One that queued behind a turn would
   * hold the tab away from the turns that arrive after it, and one that cannot
   * read the site's models holds it for its whole timeout. So a background task
   * takes the tab only when nothing else wants it, and is dropped otherwise.
   */
  runInBackground<T>(
    site: OpencliSite,
    task: () => Promise<T>
  ): Promise<T | null> {
    if ((this.depth.get(site) ?? 0) > 0) return Promise.resolve(null);
    return this.run(site, task);
  }

  depthFor(site: OpencliSite): number {
    return this.depth.get(site) ?? 0;
  }

  status(): Record<string, number> {
    return Object.fromEntries(
      OPENCLI_SITES.map((site) => [site, this.depth.get(site) ?? 0])
    );
  }
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function messageItem(text: string, itemId: string): JsonRecord {
  return {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  };
}

function messageEvents(
  item: JsonRecord,
  outputIndex: number
): Array<[string, JsonRecord]> {
  const itemId = String(item.id);
  const content = (item.content as JsonRecord[])[0] ?? {
    type: "output_text",
    text: "",
    annotations: []
  };
  const text = String(content.text ?? "");
  const part = { type: "output_text", text: "", annotations: [] };
  return [
    [
      OUTPUT_ITEM_ADDED,
      {
        type: OUTPUT_ITEM_ADDED,
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] }
      }
    ],
    [
      "response.content_part.added",
      {
        type: "response.content_part.added",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part
      }
    ],
    [
      "response.output_text.delta",
      {
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta: text
      }
    ],
    [
      "response.output_text.done",
      {
        type: "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text
      }
    ],
    [
      "response.content_part.done",
      {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: content
      }
    ],
    [
      "response.output_item.done",
      {
        type: "response.output_item.done",
        output_index: outputIndex,
        item
      }
    ]
  ];
}

function responseObject(
  id: string,
  model: string,
  status: string,
  output: JsonRecord[]
): JsonRecord {
  const text = output
    .filter((item) => item.type === "message")
    .map((item) => String((item.content as JsonRecord[])[0]?.text ?? ""))
    .join("");
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output,
    output_text: text,
    // A web chat reports no token counts.
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}

function sseEvent(event: string, body: JsonRecord, sequence: number): string {
  return `event: ${event}\ndata: ${JSON.stringify({ ...body, sequence_number: sequence })}\n\n`;
}

/**
 * A streamed turn: headers and `response.created` at once, keep-alives while
 * the site answers, then the output -- or the failure -- in the stream.
 *
 * A site turn can take longer than five minutes (a slow model, or a queue
 * behind other turns on the same tab), and the router's HTTP client gives up
 * on a response whose headers have not arrived by then
 * (`UND_ERR_HEADERS_TIMEOUT`). The router retried such a turn, the retry
 * started a fresh chat with the whole transcript, and the model -- handed one
 * huge attachment -- told the user its delegation tools did not exist. A
 * response whose headers went out at once never hits that timeout.
 */
class TurnStream {
  private sequence = 0;
  private readonly keepAlive: NodeJS.Timeout;

  private readonly response: ServerResponse;
  private readonly responseId: string;
  private readonly model: string;

  constructor(
    response: ServerResponse,
    responseId: string,
    model: string,
    keepAliveMs: number
  ) {
    this.response = response;
    this.responseId = responseId;
    this.model = model;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close"
    });
    this.emit("response.created", {
      type: "response.created",
      response: responseObject(responseId, model, "in_progress", [])
    });
    // A keep-alive has to be an event, not an SSE comment: an SSE parser drops
    // comments, so Codex never saw the old `: keep-alive` lines and aborted
    // every site turn that ran past its 5-minute stream idle timeout -- a
    // ChatGPT turn queued behind another agent's turn on the same tab does.
    // `response.in_progress` is the Responses event for exactly this state.
    this.keepAlive = setInterval(() => {
      this.emit("response.in_progress", {
        type: "response.in_progress",
        response: responseObject(responseId, model, "in_progress", [])
      });
    }, keepAliveMs);
  }

  complete(output: JsonRecord[]): void {
    output.forEach((item, index) => {
      const events =
        item.type === "message"
          ? messageEvents(item, index)
          : codexToolCallEvents(item, index);
      for (const [event, body] of events) this.emit(event, body);
    });
    this.emit("response.completed", {
      type: "response.completed",
      response: responseObject(this.responseId, this.model, "completed", output)
    });
    this.end();
  }

  /**
   * A site limit ends the response incomplete with the declared limit, which
   * the router reads to cool the provider down; any other failure is a
   * `response.failed`, which Codex retries.
   *
   * The failure is typed the way the router reads a refusal: a turn whose
   * prompt never reached the site is reported as one, so the router leaves the
   * provider serving instead of cooling it down for a browser tab that was
   * not ready.
   */
  fail(error: unknown): void {
    const message = errorMessage(error);
    const exitCode =
      error instanceof OpencliCommandError ? error.exitCode : null;
    const limit = classifyCliLimit(message, exitCode);
    if (limit && LIMIT_STATUS_CLASSES.has(limit.limitClass)) {
      const reasoningId = `rs_${turnId(10)}`;
      const itemId = `msg_${turnId(10)}`;
      this.emit(OUTPUT_ITEM_ADDED, {
        type: OUTPUT_ITEM_ADDED,
        output_index: 0,
        item: { id: reasoningId, type: "reasoning", summary: [], content: [] }
      });
      this.emit(OUTPUT_ITEM_ADDED, {
        type: OUTPUT_ITEM_ADDED,
        output_index: 1,
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: []
        }
      });
      for (const [event, body] of terminalIncompleteEvents({
        responseId: this.responseId,
        itemId,
        reasoningId,
        limit,
        provider: PROVIDER
      }))
        this.emit(event, body);
    } else {
      const kind = failureKind(error);
      const code = error instanceof OpencliCommandError ? error.code : null;
      this.emit("response.failed", {
        type: "response.failed",
        response: {
          ...responseObject(this.responseId, this.model, "failed", []),
          error: {
            type: failureErrorType(kind),
            ...(code ? { code } : {}),
            message
          }
        }
      });
    }
    this.end();
  }

  /** Stop writing; the client went away. */
  dispose(): void {
    clearInterval(this.keepAlive);
  }

  private writable(): boolean {
    return !this.response.writableEnded && !this.response.destroyed;
  }

  private emit(event: string, body: JsonRecord): void {
    if (this.writable())
      this.response.write(sseEvent(event, body, ++this.sequence));
  }

  private end(): void {
    clearInterval(this.keepAlive);
    if (this.writable()) this.response.end();
  }
}

/**
 * Answer a failed turn before any output, so the router can fall back.
 *
 * A limit the site reported ("You've reached the limit...") is a 429 carrying
 * the limit headers. A timeout is a 408: the router falls back on it but,
 * unlike a 5xx, does not re-send the turn to this route, which would hold the
 * caller through a second full `--timeout` on a site that just failed to
 * answer. Any other failure -- a signed-out browser, a site whose page changed
 * under its adapter, a missing opencli -- is a 503, which the router treats as
 * this provider being unavailable for the turn.
 *
 * A turn the site's single tab never became free for is neither: the site is
 * serving somebody else, and opencli is working. That is the typed refusal the
 * router already knows -- "this route cannot serve this request" -- so the
 * chain moves on to a route that can serve it and opencli stays healthy
 * instead of being marked unavailable for being busy.
 *
 * A turn whose prompt never reached the site is the same kind of refusal. The
 * tab was not ready, the page had no composer, the attachment could not be
 * made: the site is working and holds nothing of this turn, and cooling it
 * down would push every other agent away from a healthy route because one
 * browser tab was not ready yet.
 */
function sendFailure(response: ServerResponse, error: unknown): void {
  const message = errorMessage(error);
  const exitCode = error instanceof OpencliCommandError ? error.exitCode : null;
  const code = error instanceof OpencliCommandError ? error.code : null;
  writeErrorLine(`opencli turn failed${code ? ` (${code})` : ""}: ${message}`);
  if (response.headersSent || response.destroyed) return;
  const kind = failureKind(error);
  if (kind === "not_sent") {
    sendUnsupportedRequestFailure(response, PROVIDER, message);
    return;
  }
  const limit = classifyCliLimit(message, exitCode);
  const timedOut = kind === "timeout";
  const status = kind === "limit" ? 429 : timedOut ? 408 : 503;
  const headers = limitResponseHeaders(limit);
  const retryAfter = retryAfterSecondsFromLimit(limit);
  if (retryAfter !== null) headers["retry-after"] = String(retryAfter);
  const declared = limitPayload(limit);
  sendJson(
    response,
    status,
    {
      error: {
        type: timedOut ? "timeout_error" : "opencli_proxy_error",
        ...(code ? { code } : {}),
        message,
        ...(declared ? { limit: declared } : {})
      }
    },
    headers
  );
}

interface PreparedTurn {
  readonly site: OpencliSite;
  readonly siteModel: string;
  readonly spec: OpencliSiteSpec;
  readonly model: string;
  readonly stream: boolean;
  readonly prompt: string;
  readonly conversationId: string | null;
  /** The ledger entry this turn continues, spent once the turn succeeds. */
  readonly resumedFrom: string | null;
  /** The site and Codex thread whose chats this turn may continue. */
  readonly scope: OpencliChatScope;
  /**
   * The whole-conversation prompt, for a continued turn whose chat can no
   * longer be opened; null for a fresh turn, or when it would not fit.
   */
  readonly freshPrompt: string | null;
  readonly segments: string[];
  readonly tools: ReturnType<typeof codexToolSurface>["tools"];
}

export interface OpencliBridge {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  readonly ledger: OpencliConversationLedger;
}

/** The milliseconds a turn has left of its budget. */
function budgetLeft(deadline: number): number {
  return deadline - Date.now();
}

/**
 * The seconds a command may still run for, within the turn's budget.
 *
 * opencli takes its timeout in whole seconds, so the command is given the
 * next second up: a turn with 995 ms left is given one second rather than
 * none. A turn with no time left at all is refused instead, in `attemptTurn`.
 */
function remainingSeconds(deadline: number): number {
  return Math.max(1, Math.ceil(budgetLeft(deadline) / 1000));
}

export function createOpencliBridge(
  options: OpencliBridgeOptions
): OpencliBridge {
  const ledger = options.ledger ?? new OpencliConversationLedger();
  const queues = new SiteQueues();
  // The site model each tab was last switched to by this bridge. A site whose
  // model is an account setting is switched only when a turn asks for another.
  const selectedModels = new Map<OpencliSite, string>();
  const modelLists = new Map<OpencliSite, { at: number; models: string[] }>();

  const modelRefreshes = new Map<OpencliSite, Promise<void>>();

  /**
   * Read a site's model list into the cache; an empty read keeps the last list.
   *
   * `background` is a refresh of what the site can answer, not a request: it
   * may be dropped and asked for again. A background listing that queued behind
   * a turn would hold the tab away from the turns that arrive after it, and a
   * listing that cannot read the site's models holds it for its whole timeout.
   * So a background listing takes the tab only while nothing else wants it.
   */
  function refreshSiteModels(
    site: OpencliSite,
    mode: { readonly background?: boolean } = {}
  ): Promise<void> {
    const inFlight = modelRefreshes.get(site);
    if (inFlight) return inFlight;
    const list = () => {
      // The listing's own budget starts when it takes the tab, so a listing
      // that waited for a turn does not then hold the tab for a second one.
      const deadline = Date.now() + MODEL_LIST_TIMEOUT_MS;
      return OPENCLI_SITE_SPECS[site].models(
        execFor(AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS), deadline)
      );
    };
    const refresh = (
      mode.background === true
        ? queues.runInBackground(site, list)
        : queues.run(site, list)
    )
      .then((models) => {
        if (models === null) return undefined;
        // An empty list is the site's picker failing to render (a hidden or
        // covered window), not an account with no models: the last good
        // list stays, and the next listing asks again.
        if (models.length > 0) modelLists.set(site, { at: Date.now(), models });
        else
          writeErrorLine(
            `opencli ${site} listed no models; keeping the last list`
          );
        return undefined;
      })
      .catch((error: unknown) => {
        writeErrorLine(
          `opencli ${site} model list failed: ${errorMessage(error)}`
        );
      })
      .finally(() => modelRefreshes.delete(site));
    modelRefreshes.set(site, refresh);
    return refresh;
  }

  /**
   * One provider's models, for discovery: the cached list at once, refreshed
   * in the background when it is old. Reading a site's list drives the
   * browser and waits behind any turn already using that tab, which outlasts
   * the Runtime's discovery timeout, so a listing never waits for it once a
   * list is known. Only the first listing waits, briefly.
   */
  async function listModels(provider: OpencliProvider): Promise<string[]> {
    const site = OPENCLI_PROVIDER_SITES[provider];
    const cached = modelLists.get(site);
    if (!cached) {
      await Promise.race([
        refreshSiteModels(site),
        sleep(FIRST_MODEL_LIST_WAIT_MS)
      ]);
    } else if (
      Date.now() - cached.at >
      (options.modelListTtlMs ?? MODEL_LIST_TTL_MS)
    ) {
      void refreshSiteModels(site, { background: true });
    }
    return (modelLists.get(site)?.models ?? []).map((siteModel) =>
      opencliModelId(provider, siteModel)
    );
  }

  function prepare(
    payload: JsonRecord,
    request: IncomingMessage,
    response: ServerResponse
  ): PreparedTurn | null {
    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    const named = opencliModel(model);
    const site = named?.site;
    if (
      !named ||
      !site ||
      (site === "chatgpt" && !CHATGPT_MODELS.includes(named.siteModel))
    ) {
      sendJson(response, 400, {
        error: {
          type: "invalid_request_error",
          code: "invalid_model",
          message: `opencli serves ${OPENCLI_PROVIDERS.map((provider) => `${provider}-<model>`).join(" and ")} (ChatGPT: ${CHATGPT_MODELS.join(", ")}); got ${model || "no model"}`
        }
      });
      return null;
    }
    if (requestCarriesImageContent(payload.input)) {
      sendUnsupportedRequestFailure(
        response,
        PROVIDER,
        "the opencli bridge sends a text prompt and cannot show the site an image"
      );
      return null;
    }
    const spec = OPENCLI_SITE_SPECS[site];
    const tools = codexToolSurface(payload).tools;
    const segments = transcriptSegments(payload.input);
    const scope: OpencliChatScope = {
      site,
      thread: codexThread(request, payload)
    };
    const resume = ledger.find(scope, prefixDigests(segments));
    // A root orchestrator's policy is the one role Codex does not carry whole
    // (see roleSection), so it is added from the router's role header, as the
    // CLI bridges do. A leaf's role instructions arrive intact in the input.
    const agentRole = resolveAgentRole(request.headers);
    const orchestrator = isOrchestratorRole(agentRole);
    const renderFirst = (reference: readonly CodexTool[]) =>
      renderOpencliPrompt(
        typeof payload.instructions === "string" ? payload.instructions : "",
        reference,
        segments.join("\n\n"),
        orchestrator ? roleInstructions(agentRole) : null
      );
    // A site that takes its prompt on the command line gets MCP tools named
    // rather than documented when the full reference would not fit; a site
    // that takes it as an attachment gets the same treatment when the model
    // would spend a minute reading the reference. Either way the model reads
    // the rest of a tool's description from `ALL_TOOLS` before calling it.
    let fullPrompt = renderFirst(tools);
    const promptLimit = spec.attachesPrompt
      ? MAX_ATTACHED_PROMPT_BYTES
      : MAX_ARGV_PROMPT_BYTES;
    for (const detail of ["summaries", "names"] as const) {
      if (Buffer.byteLength(fullPrompt) <= promptLimit) break;
      const compact = renderFirst(compactCodexTools(tools, detail));
      writeErrorLine(
        `opencli ${site} first prompt is ${Buffer.byteLength(fullPrompt)} bytes; MCP tools listed by ${detail === "names" ? "name only" : "name and summary"} (${Buffer.byteLength(compact)} bytes)`
      );
      fullPrompt = compact;
    }
    const prompt = resume
      ? renderOpencliContinuation(
          tools,
          segments.slice(resume.seen).join("\n\n"),
          orchestrator
        )
      : fullPrompt;
    if (
      !spec.attachesPrompt &&
      Buffer.byteLength(prompt) > MAX_ARGV_PROMPT_BYTES
    ) {
      sendUnsupportedRequestFailure(
        response,
        PROVIDER,
        `the ${site} prompt is ${Buffer.byteLength(prompt)} bytes; opencli ${site} takes at most ${MAX_ARGV_PROMPT_BYTES} on its command line`
      );
      return null;
    }
    return {
      site,
      siteModel: named.siteModel,
      spec,
      model,
      stream: payload.stream === true,
      prompt,
      conversationId: resume?.conversationId ?? null,
      scope,
      resumedFrom: resume?.digest ?? null,
      freshPrompt:
        resume &&
        (spec.attachesPrompt ||
          Buffer.byteLength(fullPrompt) <= MAX_ARGV_PROMPT_BYTES)
          ? fullPrompt
          : null,
      segments,
      tools
    };
  }

  /**
   * One opencli command for a turn, waiting out a busy site session.
   *
   * A command the bridge cancelled (its client went away) ends here at once,
   * but opencli's daemon keeps driving the browser until that command's own
   * step finishes, and holds the site session meanwhile. The next turn's
   * command is then refused with `SESSION_BUSY` although nothing else wants
   * the tab -- a worker turn failed that way. The session frees itself, so a
   * busy refusal is retried until the turn's own timeout.
   *
   * The deadline is the *turn's* budget, not this command's: a turn that
   * continues a chat in a new one runs two commands, and both draw on the same
   * budget, so a turn can never hold the browser tab longer than it was given.
   */
  function execFor(signal: AbortSignal, deadline: number): OpencliExec {
    const retryMs = options.sessionBusyRetryMs ?? DEFAULT_SESSION_BUSY_RETRY_MS;
    const unsentRetryMs = options.unsentRetryMs ?? DEFAULT_UNSENT_RETRY_MS;
    // One daemon belongs to one version: a command that met a daemon of
    // another version stops it and runs again, and only the first such
    // failure in a turn does so.
    let daemonStopped = false;
    const attempt = async (
      args: readonly string[],
      unsentRetries = UNSENT_RETRIES
    ): Promise<JsonRecord[]> => {
      if (signal.aborted)
        throw new OpencliCommandError("turn cancelled", "CANCELLED", null);
      try {
        return await options.run({ args, signal });
      } catch (error) {
        if (!(error instanceof OpencliCommandError)) throw error;
        if (STALE_DAEMON.test(error.message) && !daemonStopped) {
          daemonStopped = true;
          writeErrorLine(
            "opencli found a daemon of another version; stopping it and running the command again"
          );
          await stopStaleDaemon(signal);
          return attempt(args, unsentRetries);
        }
        if (error.code === SESSION_BUSY && Date.now() + retryMs <= deadline) {
          writeErrorLine(`opencli site session busy; retrying in ${retryMs}ms`);
          await sleep(retryMs);
          return attempt(args, unsentRetries);
        }
        if (unsentRetries > 0 && failedBeforeSending(error)) {
          writeErrorLine(
            `opencli site was not ready (${error.message}); retrying in ${unsentRetryMs}ms`
          );
          await sleep(unsentRetryMs);
          return attempt(args, unsentRetries - 1);
        }
        throw error;
      }
    };
    return attempt;
  }

  /**
   * Stop the daemon opencli found, so the next command starts one of this
   * version.
   *
   * The daemon is shared machine-wide, so the stop is the CLI's own remedy
   * ("run manually: opencli daemon stop"). Doing it here keeps a version skew
   * from failing the turn: the bridge runs the version the repository pins,
   * and the daemon it inherits may be another one's.
   */
  async function stopStaleDaemon(signal: AbortSignal): Promise<void> {
    try {
      await options.run({ args: ["daemon", "stop"], signal });
    } catch (error) {
      writeErrorLine(`opencli daemon stop failed: ${errorMessage(error)}`);
    }
  }

  /**
   * The turn's own budget: the whole turn, every command in it, has this long.
   *
   * It is drawn once, when the turn is accepted, and shared by the commands
   * that run it. A turn that continues a chat in a new one runs a second
   * command, and that second command draws on what is left of the same budget
   * rather than on a fresh one -- otherwise a turn could hold the site's single
   * browser tab for twice its timeout, which is longer than the site is
   * reported wedged, and the site would answer "unavailable" while it was
   * working.
   */
  function turnBudget(): number {
    return Date.now() + options.turnTimeoutSeconds * 1000;
  }

  async function attemptTurn(
    turn: PreparedTurn,
    prompt: string,
    conversationId: string | null,
    signal: AbortSignal,
    deadline: number
  ): Promise<OpencliReply> {
    const directory = mkdtempSync(
      path.join(options.tempRoot ?? tmpdir(), "autodev-opencli-")
    );
    try {
      const promptFile = path.join(directory, attachedPromptFileName());
      if (turn.spec.attachesPrompt)
        writeFileSync(promptFile, prompt, { mode: 0o600 });
      return await queues.run(turn.site, async () => {
        // A turn that waited for the site can arrive with its budget spent.
        // There is nothing left to give the site then, and a command with no
        // time left would hold the tab without answering.
        if (budgetLeft(deadline) <= 0)
          throw new OpencliCommandError(
            "the site's tab was busy for the whole of the turn",
            SITE_BUSY,
            null
          );
        // Decided inside the site's queue: the model a site last answered
        // with is what its tab shows now.
        const reply = await turn.spec.turn(
          {
            prompt,
            promptFile,
            conversationId,
            siteModel: turn.siteModel,
            selectModel: selectedModels.get(turn.site) !== turn.siteModel,
            // What is left of the turn's budget, not the whole of it: a turn
            // that already waited for the site must not be given a command
            // timeout longer than the turn itself.
            timeoutSeconds: remainingSeconds(deadline)
          },
          execFor(signal, deadline)
        );
        selectedModels.set(turn.site, turn.siteModel);
        return reply;
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /**
   * Run a turn in the chat the ledger names, or in a new one.
   *
   * A recorded chat can stop opening -- deleted on the site, or a Gemini chat
   * whose page shows no turns -- and every retry of the session would then fail
   * the same way. When continuing fails before anything was sent, the entry is
   * dropped and the turn runs once more as a new chat with the whole
   * conversation, so the session goes on rather than sticking.
   *
   * Both attempts share one budget. The second one is only worth starting if
   * that budget still has time in it: a turn that has already spent it has
   * nothing left to give the site, and running it anyway would hold the site's
   * tab past the point at which the site is reported wedged.
   */
  async function runTurn(
    turn: PreparedTurn,
    signal: AbortSignal
  ): Promise<OpencliReply> {
    const deadline = turnBudget();
    try {
      return await attemptTurn(
        turn,
        turn.prompt,
        turn.conversationId,
        signal,
        deadline
      );
    } catch (error) {
      if (
        turn.conversationId === null ||
        turn.freshPrompt === null ||
        turn.resumedFrom === null ||
        signal.aborted ||
        !(error instanceof OpencliCommandError) ||
        (!failedBeforeSending(error) && error.code !== EMPTY_RESULT)
      )
        throw error;
      if (budgetLeft(deadline) <= 0)
        throw new OpencliCommandError(
          "the site's tab was busy for the whole of the turn",
          SITE_BUSY,
          null
        );
      writeErrorLine(
        `opencli ${turn.site} chat ${turn.conversationId} could not be continued (${error.message}); starting a new chat`
      );
      ledger.consume(turn.scope, turn.resumedFrom);
      return attemptTurn(
        { ...turn, conversationId: null, resumedFrom: null },
        turn.freshPrompt,
        null,
        signal,
        deadline
      );
    }
  }

  /**
   * The reply as Responses output items, and the ledger moved on: the entry
   * the turn continued from is spent, and the one this reply ends is what the
   * next request resumes.
   */
  function finishTurn(
    turn: PreparedTurn,
    reply: OpencliReply
  ): { output: JsonRecord[]; calls: number } {
    const parsed = parseOpencliReply(reply.response);
    const output: JsonRecord[] = [];
    if (parsed.text || parsed.calls.length === 0)
      output.push(messageItem(parsed.text, `msg_${turnId(10)}`));
    for (const call of parsed.calls)
      output.push(
        opencliToolCallItem(call, turn.tools, {
          itemId: `fc_${turnId(10)}`,
          callId: `call_${turnId(12)}`
        })
      );
    if (turn.resumedFrom) ledger.consume(turn.scope, turn.resumedFrom);
    if (reply.conversationId) {
      const last = prefixDigests([
        ...turn.segments,
        ...transcriptSegments(output)
      ]).at(-1);
      if (last) ledger.record(turn.scope, last, reply.conversationId);
    }
    return { output, calls: parsed.calls.length };
  }

  async function handleResponses(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (
      options.authToken &&
      request.headers.authorization !== `Bearer ${options.authToken}`
    ) {
      sendJson(response, 401, {
        error: { type: "authentication_error", message: "unauthorized" }
      });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await bodyOf(request));
    } catch {
      payload = null;
    }
    if (!isRecord(payload)) {
      sendJson(response, 400, {
        error: { type: "invalid_request_error", message: "invalid JSON body" }
      });
      return;
    }
    const turn = prepare(payload, request, response);
    if (!turn) return;

    // A client that goes away cancels its turn: nothing keeps typing into the
    // site for a caller that is no longer listening.
    const controller = new AbortController();
    const responseId = `resp_${turnId(12)}`;
    const stream = turn.stream
      ? new TurnStream(
          response,
          responseId,
          turn.model,
          options.keepAliveMs ?? KEEP_ALIVE_MS
        )
      : null;
    const onClose = () => {
      if (!response.writableEnded) {
        controller.abort();
        stream?.dispose();
      }
    };
    response.once("close", onClose);
    let reply: OpencliReply;
    try {
      reply = await runTurn(turn, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (stream) {
        writeErrorLine(`opencli turn failed: ${errorMessage(error)}`);
        stream.fail(error);
      } else sendFailure(response, error);
      return;
    } finally {
      response.removeListener("close", onClose);
    }

    const { output, calls } = finishTurn(turn, reply);
    writeErrorLine(
      `opencli ${turn.site}/${turn.siteModel} turn: ${calls} tool call(s), ${turn.tools.length} tool(s) offered, ${Buffer.byteLength(turn.prompt)}-byte prompt${turn.conversationId ? ", continued conversation" : ""}`
    );
    if (stream) stream.complete(output);
    else
      sendJson(
        response,
        200,
        responseObject(responseId, turn.model, "completed", output)
      );
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (pathname === "/health" || pathname === "/health/liveliness") {
      const requested = url.searchParams.get("provider");
      if (requested) {
        if (!OPENCLI_PROVIDERS.includes(requested as OpencliProvider)) {
          sendJson(response, 400, {
            status: "error",
            error: "Unknown opencli provider: " + requested
          });
          return;
        }
        const site = OPENCLI_PROVIDER_SITES[requested as OpencliProvider];
        const activeSince = queues.activeSinceFor(site);
        const wedgedThresholdMs =
          options.wedgedTimeoutMs ?? options.turnTimeoutSeconds * 1000 + 30_000;
        // A site is wedged when the task holding its tab has run past the time
        // it was given. Every turn draws one budget and every command in that
        // turn draws on the same one, so a turn cannot hold the tab past the
        // threshold: the threshold is reached by a command that stopped
        // answering, not by a turn that is merely slow.
        const isWedged =
          activeSince !== null && Date.now() - activeSince > wedgedThresholdMs;
        if (isWedged) {
          sendJson(response, 503, {
            status: "unavailable",
            provider: requested,
            site,
            error:
              "opencli " +
              site +
              " turn has been running for " +
              Math.round((Date.now() - activeSince) / 1000) +
              "s"
          });
          return;
        }
        const cachedModels = modelLists.get(site);
        sendJson(response, 200, {
          status: "ok",
          provider: requested,
          site,
          // A site is one browser tab: it is busy whenever a turn holds it.
          // Busy is not broken, and the caller is told which one it is.
          busy: activeSince !== null,
          queueDepth: queues.depthFor(site),
          queued: queues.status(),
          modelsObserved: Boolean(
            cachedModels && cachedModels.models.length > 0
          ),
          modelsCount: cachedModels?.models.length ?? 0,
          conversations: ledger.size
        });
        return;
      }
      sendJson(response, 200, {
        status: "ok",
        provider: PROVIDER,
        queued: queues.status(),
        conversations: ledger.size
      });
      return;
    }
    if (pathname === "/v1/models" && request.method === "GET") {
      const requested = new URL(
        request.url ?? "/",
        "http://127.0.0.1"
      ).searchParams.get("provider");
      const providers = OPENCLI_PROVIDERS.filter(
        (provider) => requested === null || provider === requested
      );
      const lists = await Promise.all(providers.map(listModels));
      const ids = lists.flat();
      // No list observed yet is not "this provider has no models": answer
      // unavailable so discovery keeps what it had and asks again.
      if (ids.length === 0) {
        sendJson(response, 503, {
          error: {
            type: "opencli_proxy_error",
            message: `no ${requested ?? "opencli"} model list has been read from the site yet`
          }
        });
        return;
      }
      sendJson(response, 200, {
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          owned_by: opencliModel(id)?.provider ?? PROVIDER
        }))
      });
      return;
    }
    if (pathname !== "/v1/responses" || request.method !== "POST") {
      sendJson(response, 404, {
        error: { message: "not found", type: "invalid_request_error" }
      });
      return;
    }
    try {
      await handleResponses(request, response);
    } catch (error) {
      sendFailure(response, error);
    }
  }

  return { handle, ledger };
}

const IS_MAIN =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const host = process.env.OPENCLI_PROXY_HOST?.trim() || "127.0.0.1";
  const port = parseNonNegativeInteger(
    process.env.OPENCLI_PROXY_PORT,
    DEFAULT_PORT
  );
  const live = new Set<ChildProcess>();
  const bridge = createOpencliBridge({
    run: processRunner(() => resolveOpencliCommand(), live),
    authToken: process.env[OPENCLI_ROUTER_AUTH_VARIABLE] ?? "",
    ledger: new OpencliConversationLedger({
      file:
        process.env.OPENCLI_CONVERSATION_LEDGER_FILE?.trim() ||
        path.join(
          process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
          "run",
          "opencli-conversations.json"
        )
    }),
    turnTimeoutSeconds: parseNonNegativeInteger(
      process.env.OPENCLI_TURN_TIMEOUT_SECONDS,
      DEFAULT_TURN_TIMEOUT_SECONDS
    )
  });
  const server = createServer((request, response) => {
    void bridge.handle(request, response);
  }).listen(port, host, () => {
    writeErrorLine(
      `opencli Responses proxy listening at http://${host}:${port}`
    );
  });
  // A turn's opencli command is this process's child; stop it with the bridge
  // so a restart leaves nothing typing into a site.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      for (const child of live) child.kill("SIGTERM");
      server.close();
      process.exit(0);
    });
  }
}
