/**
 * The opencli Responses bridge: Codex turns served by web chat sites.
 *
 * Codex -> Router -> this bridge (`127.0.0.1:4004`) -> `opencli <site> ...` ->
 * the user's signed-in browser tabs on chatgpt.com or gemini.google.com.
 *
 * Each `opencli-<site>` model is one site. A turn is one opencli command: the
 * bridge renders the Codex conversation into a prompt (see `opencli-turn.ts`),
 * waits for the site's reply, and returns it as Responses output items. Tool
 * calls in the reply become `custom_tool_call`/`function_call` items that
 * Codex executes; nothing runs inside the site or this bridge.
 *
 * A site runs turns in a pool of browser tabs, one turn per tab, as many at
 * once as its route's `maxConcurrentRequests` (see `SiteTabs`). Different
 * sites run in parallel.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
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
  retryAfterSecondsFromLimit
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
  providerPhasesField,
  type ProviderPhaseTiming
} from "@simulatorlife/autodev-runtime/telemetry/provider-phases";

import { type ProviderRoute, ROUTES } from "../router/routing.ts";
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
  compactTranscript,
  describeTranscriptBytes,
  GEMINI_THINKING_LEVELS,
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
  transcriptEntries,
  type TranscriptEntry,
  transcriptSegments,
  UPLOADS_EXHAUSTED,
  uploadsRefused
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
 * took the model 85 seconds to say anything at all.
 *
 * What fills a long prompt is usually not the reference but the
 * conversation: a session that has run dozens of tools carries hundreds of
 * kilobytes of tool results, and a chat that is new has to carry all of it.
 * The reference is narrowed first, because a listing the model can read the
 * rest of from inside `exec` is the cheapest thing to give up; the
 * conversation is shortened only when narrowing the reference was not enough,
 * and the model is told what was left out.
 */
const MAX_ATTACHED_PROMPT_BYTES = 120_000;
/**
 * The largest prompt a site that takes it as a file is given as typed text.
 *
 * ChatGPT allows an account a fixed number of uploads in a rolling window,
 * and a bridge that uploads every turn's prompt spends it: 80 turns took the
 * site out for the rest of three hours, twice in one afternoon. Most turns do
 * not need the upload -- a follow-up carries one tool result, and nine in ten
 * are under this size -- so a prompt that fits is typed into the composer and
 * the upload is kept for the prompts that need it: a chat's first message,
 * and a follow-up carrying a very large tool result. A 31 KB prompt was typed
 * and answered in 35 seconds; nothing larger has been tried.
 */
const MAX_TYPED_PROMPT_BYTES = 32_000;
/** ChatGPT uploads observed available to this account in any three-hour window. */
const CHATGPT_UPLOAD_ALLOWANCE = 80;
/** The rolling window ChatGPT counts an account's uploads over. */
const UPLOAD_WINDOW_MS = 3 * 60 * 60 * 1000;
const UPLOAD_LOG_SCHEMA = "autodev-opencli-uploads-v1";
/**
 * How long to leave a site that refuses uploads when the bridge has seen none
 * of the uploads that spent the allowance (it was restarted, or the account
 * was used elsewhere) and so cannot say when the window moves on.
 */
const UPLOAD_REFUSAL_RETRY_MS = 15 * 60 * 1000;
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

/** Preserve instructions and transcript while shrinking only MCP references. */
function compactForTypedChatgpt(
  original: string,
  tools: readonly CodexTool[],
  transcript: string,
  render: (tools: readonly CodexTool[], transcript: string) => string
): string {
  if (Buffer.byteLength(original) <= MAX_TYPED_PROMPT_BYTES) return original;
  for (const detail of ["summaries", "names"] as const) {
    const candidate = render(compactCodexTools(tools, detail), transcript);
    if (Buffer.byteLength(candidate) > MAX_TYPED_PROMPT_BYTES) continue;
    writeErrorLine(
      `opencli chatgpt typed prompt: MCP ${detail} reduced ${Buffer.byteLength(original)} to ${Buffer.byteLength(candidate)} bytes`
    );
    return candidate;
  }
  return original;
}

/** Build a first-chat prompt, retaining all instructions and minimizing MCP references first. */
function firstPromptForSite(
  site: OpencliSite,
  spec: OpencliSiteSpec,
  tools: readonly CodexTool[],
  segments: string[],
  instructions: string,
  role: string | null
): string {
  const transcript = segments.join("\n\n");
  const render = (reference: readonly CodexTool[], text: string): string =>
    renderOpencliPrompt(instructions, reference, text, role);
  let reference = tools;
  let prompt = render(reference, transcript);
  const promptLimit = spec.attachesPrompt
    ? MAX_ATTACHED_PROMPT_BYTES
    : MAX_ARGV_PROMPT_BYTES;
  for (const detail of ["summaries", "names"] as const) {
    if (Buffer.byteLength(prompt) <= promptLimit) break;
    const narrowed = compactCodexTools(tools, detail);
    const compact = render(narrowed, transcript);
    writeErrorLine(
      `opencli ${site} first prompt is ${Buffer.byteLength(prompt)} bytes; MCP tools listed by ${detail === "names" ? "name only" : "name and summary"} (${Buffer.byteLength(compact)} bytes)`
    );
    prompt = compact;
    reference = narrowed;
  }
  // The reference is shortened before the transcript; older transcript
  // messages are omitted only when the complete first prompt cannot fit.
  if (Buffer.byteLength(prompt) > promptLimit) {
    const head = Buffer.byteLength(render(reference, ""));
    if (head <= promptLimit) {
      const compacted = compactTranscript(segments, promptLimit - head);
      if (compacted.dropped > 0) {
        prompt = render(reference, compacted.text);
        writeErrorLine(
          `opencli ${site} first prompt is ${Buffer.byteLength(prompt)} bytes; ${compacted.dropped} earlier message(s) left out to fit the site's limit`
        );
      }
    }
  }
  // A compacted MCP tool reference may allow typing the entire transcript,
  // including when attachment-size handling had omitted some history.
  return site === "chatgpt"
    ? compactForTypedChatgpt(prompt, tools, transcript, render)
    : prompt;
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
  /**
   * How many browser tabs each site runs turns in at once: its route's
   * `maxConcurrentRequests`, so the router and the bridge admit the same
   * number of turns.
   */
  readonly siteTabs: Readonly<Record<OpencliSite, number>>;
  readonly ledger?: OpencliConversationLedger;
  /** Persist the bridge's observed upload usage alongside its conversation ledger. */
  readonly uploadLogPath?: string;
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
  /** The clock, for a test that moves an upload window. */
  readonly now?: () => number;
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
 * Whether running the command again could find the site ready.
 *
 * A page that was still loading is ready a moment later. A site that has
 * stopped taking uploads is not: the same command is refused the same way,
 * and each attempt holds the site's one tab away from every turn behind it.
 * Six attempts at an upload the site would not take cost each failing turn
 * two minutes, and the turns queued behind them their whole budget.
 */
function worthRunningAgain(error: OpencliCommandError): boolean {
  return (
    failedBeforeSending(error) &&
    !uploadsRefused(error) &&
    error.code !== UPLOADS_EXHAUSTED
  );
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
 *
 * Every command runs in the site's tab pool (`OPENCLI_SITE_SLOTS`), sized to
 * the tabs the bridge admits turns into, so opencli never hands out more tabs
 * than the bridge runs turns in.
 */
export function processRunner(
  resolveCommand: () => OpencliCommand,
  siteTabs: Readonly<Record<OpencliSite, number>>,
  live: Set<ChildProcess> = new Set()
): OpencliRunner {
  const env = {
    ...process.env,
    OPENCLI_SITE_SLOTS: opencliSiteSlots(siteTabs)
  };
  return ({ args, signal }) =>
    new Promise((resolve, reject) => {
      const command = resolveCommand();
      const child = spawn(command.command, [...command.args, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env
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
 * opencli's site-slot pool for the tabs the bridge was given: each site runs
 * its commands in that many persistent tabs (`site:<site>#<n>`), one command
 * per tab at a time, and opencli's daemon hands each command a free one.
 */
export function opencliSiteSlots(
  tabs: Readonly<Record<OpencliSite, number>>
): string {
  return OPENCLI_SITES.map((site) => `${site}:${tabs[site]}`).join(",");
}

/**
 * The tabs each site runs turns in: its route's `maxConcurrentRequests`, the
 * number of turns the router sends it at once. A route with no limit gets one
 * tab, the most a site can serve without one.
 */
export function routedSiteTabs(
  routes: readonly Pick<
    ProviderRoute,
    "provider" | "maxConcurrentRequests"
  >[] = ROUTES
): Record<OpencliSite, number> {
  const tabs = Object.fromEntries(
    OPENCLI_SITES.map((site) => [site, 1])
  ) as Record<OpencliSite, number>;
  for (const provider of OPENCLI_PROVIDERS) {
    const limit = routes.find(
      (route) => route.provider === provider
    )?.maxConcurrentRequests;
    if (limit !== undefined) tabs[OPENCLI_PROVIDER_SITES[provider]] = limit;
  }
  return tabs;
}

interface TabTask {
  readonly level: string | null;
  readonly start: () => void;
}

interface RunningTask {
  readonly since: number;
  readonly level: string | null;
}

/**
 * The browser tabs each site's commands run in.
 *
 * A site has as many tabs as its route takes concurrent requests, and one
 * command at a time drives each tab: opencli's daemon gives every command a
 * free tab of the site's pool. Turns are admitted in arrival order, as many at
 * once as the site has tabs. One tab per site made every agent on a site wait
 * for every other: more than half of a ChatGPT turn's time was spent queued
 * behind other agents' turns, not answering.
 *
 * A site's model is an account setting, not a tab's (`chatgpt model` changes
 * the account's last-used model), so turns share the site only while they
 * want the model it is on. A turn that wants another model waits for the
 * site to drain and then runs alone, so its switch cannot change the model
 * under a turn in another tab; once the site is on its model, later turns
 * that want the same one run beside it again. `level` is that model; a task
 * with no level (a model listing) runs at any model.
 */
class SiteTabs {
  private readonly waiting = new Map<OpencliSite, TabTask[]>();
  private readonly running = new Map<OpencliSite, Map<symbol, RunningTask>>();

  private readonly tabs: Readonly<Record<OpencliSite, number>>;
  /** The model the site is on now, as far as the bridge knows. */
  private readonly siteLevel: (site: OpencliSite) => string | undefined;

  constructor(
    tabs: Readonly<Record<OpencliSite, number>>,
    siteLevel: (site: OpencliSite) => string | undefined
  ) {
    this.tabs = tabs;
    this.siteLevel = siteLevel;
  }

  run<T>(
    site: OpencliSite,
    level: string | null,
    task: () => Promise<T>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waitingFor(site).push({
        level,
        start: () => {
          const id = Symbol(site);
          const running = this.runningFor(site);
          running.set(id, { since: Date.now(), level });
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              running.delete(id);
              this.admit(site);
            })
            .catch(reject);
        }
      });
      this.admit(site);
    });
  }

  /**
   * Run a background task in one of the site's tabs, but only while the site
   * is idle.
   *
   * A background task is a refresh of what the site can answer, not a request:
   * it may be dropped and asked for again. One that queued behind a turn would
   * hold a tab away from the turns that arrive after it, and one that cannot
   * read the site's models holds it for its whole timeout. So a background task
   * runs only when nothing else wants the site, and is dropped otherwise.
   */
  runInBackground<T>(
    site: OpencliSite,
    task: () => Promise<T>
  ): Promise<T | null> {
    if (this.depthFor(site) > 0) return Promise.resolve(null);
    return this.run(site, null, task);
  }

  /** When the longest-running task on the site started, or null when idle. */
  oldestActiveSince(site: OpencliSite): number | null {
    let oldest: number | null = null;
    for (const { since } of this.runningFor(site).values())
      oldest = oldest === null ? since : Math.min(oldest, since);
    return oldest;
  }

  tabsFor(site: OpencliSite): number {
    return this.tabs[site];
  }

  activeFor(site: OpencliSite): number {
    return this.runningFor(site).size;
  }

  /** Tasks running or waiting on the site. */
  depthFor(site: OpencliSite): number {
    return this.waitingFor(site).length + this.activeFor(site);
  }

  status(): Record<string, number> {
    return Object.fromEntries(
      OPENCLI_SITES.map((site) => [site, this.depthFor(site)])
    );
  }

  private admit(site: OpencliSite): void {
    const waiting = this.waitingFor(site);
    const running = this.runningFor(site);
    while (waiting.length > 0 && running.size < this.tabs[site]) {
      const next = waiting[0];
      if (next === undefined || !this.joins(site, next.level, running)) return;
      waiting.shift();
      next.start();
    }
  }

  /** Whether a task at `level` may run beside the tasks running now. */
  private joins(
    site: OpencliSite,
    level: string | null,
    running: Map<symbol, RunningTask>
  ): boolean {
    if (running.size === 0 || level === null) return true;
    for (const task of running.values())
      if (task.level !== null && task.level !== level) return false;
    return this.siteLevel(site) === level;
  }

  private waitingFor(site: OpencliSite): TabTask[] {
    let waiting = this.waiting.get(site);
    if (!waiting) this.waiting.set(site, (waiting = []));
    return waiting;
  }

  private runningFor(site: OpencliSite): Map<symbol, RunningTask> {
    let running = this.running.get(site);
    if (!running) this.running.set(site, (running = new Map()));
    return running;
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

/**
 * A Responses object for one turn. A web chat reports no token counts, so the
 * response carries no `usage` -- an unreported count is unknown, not zero --
 * and a completed turn carries where its time went (a wait for a tab, then
 * the site), which the router records on the attempt.
 */
function responseObject(
  id: string,
  model: string,
  status: string,
  output: JsonRecord[],
  phases: ProviderPhaseTiming | null = null
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
    ...(phases === null ? {} : providerPhasesField(phases))
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

  complete(output: JsonRecord[], phases: ProviderPhaseTiming): void {
    output.forEach((item, index) => {
      const events =
        item.type === "message"
          ? messageEvents(item, index)
          : codexToolCallEvents(item, index);
      for (const [event, body] of events) this.emit(event, body);
    });
    this.emit("response.completed", {
      type: "response.completed",
      response: responseObject(
        this.responseId,
        this.model,
        "completed",
        output,
        phases
      )
    });
    this.end();
  }

  /**
   * A failed turn is a `response.failed`, always before any output: a site's
   * reply arrives whole, so nothing has been streamed when a turn fails.
   * That is what lets the router ask its next candidate on the same stream.
   *
   * The failure says what kind it is. A site limit carries the declared
   * limit, which the router reads to cool the provider down for as long as
   * the site said. A turn whose prompt never reached the site is typed the
   * way the router reads a refusal, so the provider is left serving instead
   * of being cooled down for a browser tab that was not ready.
   */
  fail(error: unknown): void {
    const message = errorMessage(error);
    const exitCode =
      error instanceof OpencliCommandError ? error.exitCode : null;
    const code = error instanceof OpencliCommandError ? error.code : null;
    const declared = limitPayload(classifyCliLimit(message, exitCode));
    const limit =
      declared && LIMIT_STATUS_CLASSES.has(String(declared.class))
        ? declared
        : null;
    this.emit("response.failed", {
      type: "response.failed",
      response: {
        ...responseObject(this.responseId, this.model, "failed", []),
        error: {
          type: failureErrorType(failureKind(error)),
          ...(code ? { code } : {}),
          message,
          ...(limit ? { limit } : {})
        }
      }
    });
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
  /** The thinking level the request asks the site for, or null for none. */
  readonly siteThinking: string | null;
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
  /** The conversation's items as the prompt renders them. */
  readonly entries: TranscriptEntry[];
  /** How many leading items the continued chat has already seen; 0 for a fresh turn. */
  readonly seen: number;
  readonly tools: ReturnType<typeof codexToolSurface>["tools"];
}

/** A turn's reply, with the prompt that produced it and whether it continued a chat. */
interface TurnRun {
  readonly reply: OpencliReply;
  readonly prompt: string;
  readonly continued: boolean;
  readonly timing: ProviderPhaseTiming;
}

/** Milliseconds as seconds with one decimal, for the turn log. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * The bridge log's line for a finished turn: the site and model, the calls it
 * made, the prompt it sent, and what that prompt spent on each kind of
 * conversation item -- only the new items for a continued chat, every item
 * for a new one.
 */
export function opencliTurnLogLine(
  turn: {
    readonly site: string;
    readonly siteModel: string;
    readonly tools: readonly unknown[];
    readonly entries: readonly TranscriptEntry[];
    readonly seen: number;
  },
  run: {
    readonly prompt: string;
    readonly continued: boolean;
    readonly timing: Readonly<ProviderPhaseTiming>;
  },
  calls: number
): string {
  const items = turn.entries.slice(run.continued ? turn.seen : 0);
  return `opencli ${turn.site}/${turn.siteModel} turn: ${calls} tool call(s), ${turn.tools.length} tool(s) offered, ${Buffer.byteLength(run.prompt)}-byte prompt, queued ${seconds(run.timing.queuedMs)}s, on site ${seconds(run.timing.onSiteMs)}s${run.continued ? ", continued conversation; new items" : "; conversation items"}: ${describeTranscriptBytes(items)}`;
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
  // The model each site was last switched to by this bridge. A site whose
  // model is an account setting is switched only when a turn asks for another.
  const selectedModels = new Map<OpencliSite, string>();
  const tabs = new SiteTabs(options.siteTabs, (site) =>
    selectedModels.get(site)
  );
  // The thinking level each site last answered at. A site that is already at
  // the level the turn asks for is not asked again: the switch costs the site
  // a menu it has to open and close.
  const selectedThinking = new Map<OpencliSite, string>();
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
        ? tabs.runInBackground(site, list)
        : tabs.run(site, null, list)
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

  /**
   * The thinking level the request asks a site to answer at.
   *
   * Gemini is the site with a thinking level of its own (`low`, `medium`,
   * `high`), and it is asked for one through the request's effort. ChatGPT's
   * intelligence level is its model, so it has no effort of its own, and a
   * level the site does not offer is not asked for at all: the turn answers
   * at the level the site has rather than failing over a preference.
   */
  function siteThinking(site: OpencliSite, payload: JsonRecord): string | null {
    if (site !== "gemini") return null;
    const reasoning = payload.reasoning;
    if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning))
      return null;
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort !== "string") return null;
    const value = effort.trim().toLowerCase();
    return GEMINI_THINKING_LEVELS.includes(value) ? value : null;
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
    const entries = transcriptEntries(payload.input);
    const segments = entries.map((entry) => entry.text);
    const scope: OpencliChatScope = {
      site,
      thread: codexThread(request, payload)
    };
    const recorded = ledger.find(scope, prefixDigests(segments));
    // A root orchestrator's policy is the one role Codex does not carry whole
    // (see roleSection), so it is added from the router's role header, as the
    // CLI bridges do. A leaf's role instructions arrive intact in the input.
    const agentRole = resolveAgentRole(request.headers);
    const orchestrator = isOrchestratorRole(agentRole);
    const instructions =
      typeof payload.instructions === "string" ? payload.instructions : "";
    const role = orchestrator ? roleInstructions(agentRole) : null;
    // Both sites narrow MCP tool descriptions before omitting transcript.
    // ChatGPT additionally attempts MCP-only compaction to stay in typed mode.
    const fullPrompt = firstPromptForSite(
      site,
      spec,
      tools,
      segments,
      instructions,
      role
    );
    const fits = (text: string) =>
      spec.attachesPrompt || Buffer.byteLength(text) <= MAX_ARGV_PROMPT_BYTES;
    const continuation = recorded
      ? renderOpencliContinuation(
          tools,
          segments.slice(recorded.seen).join("\n\n"),
          orchestrator
        )
      : null;
    // A chat that fell behind -- the session's turns went to another route
    // while this site was unavailable -- has the whole gap to catch up on,
    // and a command line cannot carry it: an opencli-gemini root was refused
    // every turn with a 345 KB continuation while its compacted first prompt
    // was 95 KB. Such a turn starts a new chat with that first prompt.
    const resume =
      recorded &&
      continuation !== null &&
      !fits(continuation) &&
      fits(fullPrompt)
        ? null
        : recorded;
    if (recorded && resume === null) {
      ledger.consume(scope, recorded.digest);
      writeErrorLine(
        `opencli ${site} chat ${recorded.conversationId} is ${Buffer.byteLength(continuation ?? "")} bytes behind; starting a new chat`
      );
    }
    const prompt = resume && continuation !== null ? continuation : fullPrompt;
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
      siteThinking: siteThinking(site, payload),
      spec,
      model,
      stream: payload.stream === true,
      prompt,
      conversationId: resume?.conversationId ?? null,
      scope,
      resumedFrom: resume?.digest ?? null,
      freshPrompt: resume && fits(fullPrompt) ? fullPrompt : null,
      entries,
      seen: resume?.seen ?? 0,
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
        if (unsentRetries > 0 && worthRunningAgain(error)) {
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

  interface TurnBudget {
    /** When the turn stops waiting for the site's tab. */
    readonly waitUntil: number;
    /** When the turn must be done, set once it first takes the tab. */
    deadline: number | null;
  }

  /**
   * A turn waits for the tab for as long as it may then hold it.
   *
   * The two are separate allowances. Counted as one, a turn that waited eight
   * minutes behind other agents was given the two minutes that were left and
   * timed out on a site that was answering -- and the wait, which is the
   * site's other users, was charged to the turn as if the site had failed it.
   * The time a turn holds the tab is still bounded by its own timeout, which
   * is what the wedged check measures.
   */
  function turnBudget(): TurnBudget {
    return {
      waitUntil: Date.now() + options.turnTimeoutSeconds * 1000,
      deadline: null
    };
  }

  /** The turn's deadline, started the first time it takes the site's tab. */
  function deadlineOnTab(budget: TurnBudget): number {
    if (budget.deadline === null) {
      if (Date.now() > budget.waitUntil)
        throw new OpencliCommandError(
          "the site's tab was busy for the whole of the turn",
          SITE_BUSY,
          null
        );
      budget.deadline = Date.now() + options.turnTimeoutSeconds * 1000;
    }
    return budget.deadline;
  }

  const now = options.now ?? Date.now;
  const uploadLogPath = options.uploadLogPath ?? null;
  // The bridge's accounted uploads, oldest first, kept across restarts when a
  // log path is supplied. This does not observe uploads made elsewhere.
  const uploads = new Map<OpencliSite, number[]>();

  function recentUploads(site: OpencliSite): number[] {
    const current = now();
    const recorded = uploads.get(site) ?? [];
    const recent = recorded.filter(
      (at) => at > current - UPLOAD_WINDOW_MS && at <= current
    );
    if (recent.length !== recorded.length) uploads.set(site, recent);
    return recent;
  }

  function uploadHealth(site: OpencliSite): {
    uploadsUsed: number;
    nextResetAt: string | null;
  } {
    const recent = recentUploads(site);
    const oldest = recent[0];
    return {
      uploadsUsed: recent.length,
      nextResetAt:
        oldest === undefined
          ? null
          : new Date(oldest + UPLOAD_WINDOW_MS).toISOString()
    };
  }

  function saveUploadLog(): void {
    if (uploadLogPath === null) return;
    try {
      mkdirSync(path.dirname(uploadLogPath), { recursive: true, mode: 0o700 });
      const temporary = `${uploadLogPath}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({
          schema: UPLOAD_LOG_SCHEMA,
          sites: Object.fromEntries(
            OPENCLI_SITES.map((site) => [site, recentUploads(site)])
          )
        }),
        { mode: 0o600 }
      );
      renameSync(temporary, uploadLogPath);
    } catch (error) {
      writeErrorLine(
        `opencli upload log could not be saved: ${errorMessage(error)}`
      );
    }
  }

  function loadUploadLog(): void {
    if (uploadLogPath === null || !existsSync(uploadLogPath)) return;
    try {
      const saved: unknown = JSON.parse(readFileSync(uploadLogPath, "utf8"));
      if (
        !isRecord(saved) ||
        saved.schema !== UPLOAD_LOG_SCHEMA ||
        !isRecord(saved.sites)
      )
        return;
      const horizon = now() - UPLOAD_WINDOW_MS;
      for (const site of OPENCLI_SITES) {
        const entries = saved.sites[site];
        if (!Array.isArray(entries)) continue;
        const recent = entries
          .filter(
            (at): at is number =>
              typeof at === "number" &&
              Number.isFinite(at) &&
              at > horizon &&
              at <= now()
          )
          .sort((a, b) => a - b);
        uploads.set(site, recent);
      }
    } catch (error) {
      writeErrorLine(
        `opencli upload log could not be loaded: ${errorMessage(error)}`
      );
    }
  }

  loadUploadLog();

  function recordUpload(site: OpencliSite): void {
    uploads.set(site, [...recentUploads(site), now()]);
    saveUploadLog();
  }

  // Uploads that turns running in a site's tabs are about to make: a turn's
  // upload is recorded only once it is known to have been spent, and until
  // then the turns in the site's other tabs must still count it.
  const pendingUploads = new Map<OpencliSite, number>();

  function uploadsInFlight(site: OpencliSite): number {
    return pendingUploads.get(site) ?? 0;
  }

  function reserveUpload(site: OpencliSite, change: 1 | -1): void {
    pendingUploads.set(site, uploadsInFlight(site) + change);
  }

  /**
   * The site would not take the upload a prompt this long needs.
   *
   * It is the site's rate limit and is reported as one, with the time the
   * window moves past the oldest upload the bridge made in it: the router
   * cools the provider down until then and serves the turn from another
   * route, instead of handing every retry back to a site that refuses it.
   */
  function uploadsExhausted(
    site: OpencliSite,
    promptBytes: number,
    cause: OpencliCommandError | null = null
  ): OpencliCommandError {
    const resetsAt =
      uploadHealth(site).nextResetAt ??
      new Date(now() + UPLOAD_REFUSAL_RETRY_MS).toISOString();
    const reason = cause
      ? `the site is not taking file uploads (${cause.message})`
      : `the bridge has accounted for ${CHATGPT_UPLOAD_ALLOWANCE} uploads in this rolling window`;
    return new OpencliCommandError(
      `${site} upload rate limit reached: ${reason} and this ${promptBytes}-byte prompt is too long to type; resets at ${resetsAt}`,
      UPLOADS_EXHAUSTED,
      cause?.exitCode ?? null
    );
  }

  async function attemptTurn(
    turn: PreparedTurn,
    prompt: string,
    conversationId: string | null,
    signal: AbortSignal,
    budget: TurnBudget,
    timing: ProviderPhaseTiming
  ): Promise<OpencliReply> {
    const promptBytes = Buffer.byteLength(prompt);
    // A prompt that fits is typed; only one too long to type is uploaded.
    const typed =
      turn.spec.attachesPrompt && promptBytes <= MAX_TYPED_PROMPT_BYTES;
    const uploading = turn.spec.attachesPrompt && !typed;
    const directory = mkdtempSync(
      path.join(options.tempRoot ?? tmpdir(), "autodev-opencli-")
    );
    try {
      const promptFile = path.join(directory, attachedPromptFileName());
      if (turn.spec.attachesPrompt)
        writeFileSync(promptFile, prompt, { mode: 0o600 });
      const runOnTab = async (): Promise<OpencliReply> => {
        // Checked once the turn has a tab, counting the uploads the turns in
        // the site's other tabs are making, so concurrent turns cannot both
        // spend the final available upload. A refusal makes no opencli/site
        // call.
        if (
          uploading &&
          turn.site === "chatgpt" &&
          uploadHealth(turn.site).uploadsUsed + uploadsInFlight(turn.site) >=
            CHATGPT_UPLOAD_ALLOWANCE
        )
          throw uploadsExhausted(turn.site, promptBytes);
        // A turn that waited for the site as long as it may hold it is
        // refused; one that has already held it has only what is left.
        const deadline = deadlineOnTab(budget);
        if (budgetLeft(deadline) <= 0)
          throw new OpencliCommandError(
            "the site's tab was busy for the whole of the turn",
            SITE_BUSY,
            null
          );
        if (uploading) reserveUpload(turn.site, 1);
        try {
          // Decided once the turn has a tab: the site runs one model at a
          // time, and the one it last answered with is the one it is on.
          const reply = await turn.spec
            .turn(
              {
                prompt,
                promptFile,
                typed,
                conversationId,
                siteModel: turn.siteModel,
                selectModel: selectedModels.get(turn.site) !== turn.siteModel,
                siteThinking:
                  turn.siteThinking !== null &&
                  selectedThinking.get(turn.site) !== turn.siteThinking
                    ? turn.siteThinking
                    : null,
                // What is left of the turn's budget, not the whole of it: a
                // turn that already held the site must not be given a command
                // timeout longer than the turn itself.
                timeoutSeconds: remainingSeconds(deadline)
              },
              execFor(signal, deadline)
            )
            .catch((error: unknown) => {
              if (!(error instanceof OpencliCommandError)) throw error;
              if (uploadsRefused(error))
                throw uploadsExhausted(turn.site, promptBytes, error);
              // Even a failure after sending does not establish that the site
              // accepted the attachment. Count only confirmed successful turns;
              // an ambiguous failure remains unknown rather than invented usage.
              throw error;
            });
          if (uploading) recordUpload(turn.site);
          selectedModels.set(turn.site, turn.siteModel);
          // The site reports the level it answered at. A turn that asked for
          // a level the site would not take answers at the level the site
          // had, so the bridge keeps what it knew: the site's level did not
          // change, and a later turn that asks for it again is the one that
          // finds out whether the site will take it now.
          if (reply.thinking) selectedThinking.set(turn.site, reply.thinking);
          return reply;
        } finally {
          if (uploading) reserveUpload(turn.site, -1);
        }
      };
      const queuedAt = Date.now();
      return await tabs.run(turn.site, turn.siteModel, async () => {
        const startedAt = Date.now();
        timing.queuedMs += startedAt - queuedAt;
        try {
          return await runOnTab();
        } finally {
          timing.onSiteMs += Date.now() - startedAt;
        }
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
   * Both attempts share one budget, which starts when the turn first takes
   * the site's tab. The second one is only worth starting if that budget
   * still has time in it: a turn that has already spent it has nothing left to
   * give the site, and running it anyway would hold the site's tab past the
   * point at which the site is reported wedged.
   *
   * A site that will not take the upload is not a chat that stopped opening:
   * a new chat needs a larger upload still, so that failure is not retried
   * here.
   */
  async function runTurn(
    turn: PreparedTurn,
    signal: AbortSignal
  ): Promise<TurnRun> {
    const budget = turnBudget();
    const timing: ProviderPhaseTiming = { queuedMs: 0, onSiteMs: 0 };
    try {
      const reply = await attemptTurn(
        turn,
        turn.prompt,
        turn.conversationId,
        signal,
        budget,
        timing
      );
      return {
        reply,
        prompt: turn.prompt,
        continued: turn.conversationId !== null,
        timing
      };
    } catch (error) {
      if (
        turn.conversationId === null ||
        turn.freshPrompt === null ||
        turn.resumedFrom === null ||
        signal.aborted ||
        !(error instanceof OpencliCommandError) ||
        (!worthRunningAgain(error) && error.code !== EMPTY_RESULT)
      )
        throw error;
      if (budget.deadline !== null && budgetLeft(budget.deadline) <= 0)
        throw new OpencliCommandError(
          "the site's tab was busy for the whole of the turn",
          SITE_BUSY,
          null
        );
      writeErrorLine(
        `opencli ${turn.site} chat ${turn.conversationId} could not be continued (${error.message}); starting a new chat`
      );
      ledger.consume(turn.scope, turn.resumedFrom);
      const reply = await attemptTurn(
        { ...turn, conversationId: null, resumedFrom: null },
        turn.freshPrompt,
        null,
        signal,
        budget,
        timing
      );
      return { reply, prompt: turn.freshPrompt, continued: false, timing };
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
        ...turn.entries.map((entry) => entry.text),
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
    let run: TurnRun;
    try {
      run = await runTurn(turn, controller.signal);
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

    const { output, calls } = finishTurn(turn, run.reply);
    writeErrorLine(opencliTurnLogLine(turn, run, calls));
    if (stream) stream.complete(output, run.timing);
    else
      sendJson(
        response,
        200,
        responseObject(responseId, turn.model, "completed", output, run.timing)
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
        const activeSince = tabs.oldestActiveSince(site);
        const wedgedThresholdMs =
          options.wedgedTimeoutMs ?? options.turnTimeoutSeconds * 1000 + 30_000;
        // A site is wedged when a task holding one of its tabs has run past
        // the time it was given. Every turn draws one budget and every command
        // in that turn draws on the same one, so a turn cannot hold a tab past
        // the threshold: the threshold is reached by a command that stopped
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
          // A site is busy when a turn holds every one of its tabs. Busy is
          // not broken, and the caller is told which one it is.
          busy: tabs.activeFor(site) >= tabs.tabsFor(site),
          tabs: tabs.tabsFor(site),
          activeTurns: tabs.activeFor(site),
          queueDepth: tabs.depthFor(site),
          queued: tabs.status(),
          modelsObserved: Boolean(
            cachedModels && cachedModels.models.length > 0
          ),
          modelsCount: cachedModels?.models.length ?? 0,
          ...uploadHealth(site),
          conversations: ledger.size
        });
        return;
      }
      sendJson(response, 200, {
        status: "ok",
        provider: PROVIDER,
        queued: tabs.status(),
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
  const siteTabs = routedSiteTabs();
  const bridge = createOpencliBridge({
    run: processRunner(() => resolveOpencliCommand(), siteTabs, live),
    siteTabs,
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
    uploadLogPath:
      process.env.OPENCLI_UPLOAD_LOG_FILE?.trim() ||
      path.join(
        process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
        "run",
        "opencli-uploads.json"
      ),
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
