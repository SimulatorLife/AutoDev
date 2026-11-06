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
import { tmpdir } from "node:os";
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

import { codexToolCallEvents, codexToolSurface } from "./claude-codex-tools.ts";
import { turnId } from "./codex-tool-turns.ts";
import {
  attachedPromptFileName,
  CHATGPT_MODELS,
  OPENCLI_SITE_SPECS,
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
 * The largest prompt passed on the command line. A site that takes its prompt
 * as argv cannot carry a transcript past the platform's argument limit, and a
 * prompt this long would also take minutes to type into a composer; such a
 * request is refused so the router moves on to a route that can serve it.
 */
const MAX_ARGV_PROMPT_BYTES = 200_000;
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
}

/** opencli's code for a site session another command still holds. */
const SESSION_BUSY = "SESSION_BUSY";
const DEFAULT_SESSION_BUSY_RETRY_MS = 5000;
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
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
      const onAbort = () => child.kill("SIGTERM");
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

  run<T>(site: OpencliSite, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(site) ?? Promise.resolve();
    this.depth.set(site, (this.depth.get(site) ?? 0) + 1);
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => this.depth.set(site, (this.depth.get(site) ?? 1) - 1));
    this.tails.set(site, next);
    return next;
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
      "response.output_item.added",
      {
        type: "response.output_item.added",
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

function sendStream(
  response: ServerResponse,
  responseId: string,
  model: string,
  output: JsonRecord[]
): void {
  let sequence = 0;
  const lines: string[] = [];
  const emit = (event: string, body: JsonRecord) => {
    lines.push(
      `event: ${event}\ndata: ${JSON.stringify({ ...body, sequence_number: ++sequence })}\n\n`
    );
  };
  emit("response.created", {
    type: "response.created",
    response: responseObject(responseId, model, "in_progress", [])
  });
  output.forEach((item, index) => {
    const events =
      item.type === "message"
        ? messageEvents(item, index)
        : codexToolCallEvents(item, index);
    for (const [event, body] of events) emit(event, body);
  });
  emit("response.completed", {
    type: "response.completed",
    response: responseObject(responseId, model, "completed", output)
  });
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close"
  });
  response.end(lines.join(""));
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
 */
function sendFailure(response: ServerResponse, error: unknown): void {
  const message = errorMessage(error);
  const exitCode = error instanceof OpencliCommandError ? error.exitCode : null;
  const code = error instanceof OpencliCommandError ? error.code : null;
  writeErrorLine(`opencli turn failed${code ? ` (${code})` : ""}: ${message}`);
  if (response.headersSent || response.destroyed) return;
  const limit = classifyCliLimit(message, exitCode);
  const timedOut = code === "TIMEOUT" || exitCode === OPENCLI_TIMEOUT_EXIT_CODE;
  const status =
    limit && LIMIT_STATUS_CLASSES.has(limit.limitClass)
      ? 429
      : timedOut
        ? 408
        : 503;
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
  readonly segments: string[];
  readonly tools: ReturnType<typeof codexToolSurface>["tools"];
}

export interface OpencliBridge {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  readonly ledger: OpencliConversationLedger;
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

  /** Read a site's model list into the cache; an empty read keeps the last list. */
  function refreshSiteModels(site: OpencliSite): Promise<void> {
    const inFlight = modelRefreshes.get(site);
    if (inFlight) return inFlight;
    const refresh = queues
      .run(site, () =>
        OPENCLI_SITE_SPECS[site].models(
          execFor(AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS))
        )
      )
      .then((models) => {
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
    } else if (Date.now() - cached.at > MODEL_LIST_TTL_MS) {
      void refreshSiteModels(site);
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
    const resume = ledger.take(site, prefixDigests(segments));
    // A root orchestrator's policy is the one role Codex does not carry whole
    // (see roleSection), so it is added from the router's role header, as the
    // CLI bridges do. A leaf's role instructions arrive intact in the input.
    const agentRole = resolveAgentRole(request.headers);
    const role = isOrchestratorRole(agentRole)
      ? roleInstructions(agentRole)
      : null;
    const prompt = resume
      ? renderOpencliContinuation(
          tools,
          segments.slice(resume.seen).join("\n\n"),
          role
        )
      : renderOpencliPrompt(
          typeof payload.instructions === "string" ? payload.instructions : "",
          tools,
          segments.join("\n\n"),
          role
        );
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
   */
  function execFor(signal: AbortSignal): OpencliExec {
    const deadline = Date.now() + options.turnTimeoutSeconds * 1000;
    const retryMs = options.sessionBusyRetryMs ?? DEFAULT_SESSION_BUSY_RETRY_MS;
    const attempt = async (args: readonly string[]): Promise<JsonRecord[]> => {
      if (signal.aborted)
        throw new OpencliCommandError("turn cancelled", "CANCELLED", null);
      try {
        return await options.run({ args, signal });
      } catch (error) {
        if (
          !(error instanceof OpencliCommandError) ||
          error.code !== SESSION_BUSY ||
          Date.now() + retryMs > deadline
        )
          throw error;
        writeErrorLine(`opencli site session busy; retrying in ${retryMs}ms`);
        await sleep(retryMs);
        return attempt(args);
      }
    };
    return attempt;
  }

  async function runTurn(
    turn: PreparedTurn,
    signal: AbortSignal
  ): Promise<OpencliReply> {
    const directory = mkdtempSync(
      path.join(options.tempRoot ?? tmpdir(), "autodev-opencli-")
    );
    try {
      const promptFile = path.join(directory, attachedPromptFileName());
      if (turn.spec.attachesPrompt)
        writeFileSync(promptFile, turn.prompt, { mode: 0o600 });
      return await queues.run(turn.site, async () => {
        // Decided inside the site's queue: the model a site last answered
        // with is what its tab shows now.
        const reply = await turn.spec.turn(
          {
            prompt: turn.prompt,
            promptFile,
            conversationId: turn.conversationId,
            siteModel: turn.siteModel,
            selectModel: selectedModels.get(turn.site) !== turn.siteModel,
            timeoutSeconds: options.turnTimeoutSeconds
          },
          execFor(signal)
        );
        selectedModels.set(turn.site, turn.siteModel);
        return reply;
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onClose);
    let reply: OpencliReply;
    try {
      reply = await runTurn(turn, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) sendFailure(response, error);
      return;
    } finally {
      response.removeListener("close", onClose);
    }

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
    if (reply.conversationId) {
      const digests = prefixDigests([
        ...turn.segments,
        ...transcriptSegments(output)
      ]);
      const last = digests.at(-1);
      if (last) ledger.record(turn.site, last, reply.conversationId);
    }
    writeErrorLine(
      `opencli ${turn.site}/${turn.siteModel} turn: ${parsed.calls.length} tool call(s)${turn.conversationId ? ", continued conversation" : ""}`
    );
    const responseId = `resp_${turnId(12)}`;
    if (turn.stream) sendStream(response, responseId, turn.model, output);
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
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/health" || pathname === "/health/liveliness") {
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
