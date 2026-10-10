/**
 * Runtime-owned v1 JSON-RPC stdio client for a Core-defined game adapter.
 *
 * The wire format, error vocabulary, capability advertisement and request /
 * notification envelopes are all defined in `core/src/playtesting/protocol.ts`
 * and `core/src/playtesting/types.ts`. This module is the only place in
 * Runtime that parses and emits those envelopes, and it never invents a
 * parallel protocol: a Core validator failure is propagated verbatim to the
 * caller and the transport is failed closed.
 *
 * The client deliberately does not spawn a host process. It owns the
 * `JSON-RPC over separate UTF-8 stdin/stdout/stderr streams` transport and
 * accepts whatever stream triplet the caller provides (Docker sandbox,
 * direct test fixture, future authenticated HTTP transport, etc.). The
 * caller is responsible for sourcing, isolating and killing the process;
 * this module is responsible for protocol correctness, ordering,
 * revision binding, cancellation, duplicate detection, oversize rejection
 * and graceful drain on EOF.
 *
 * Concurrency model: the public API is a single state machine
 * (`init` -> `capabilities` -> `ready` -> `failClosed`). All public methods
 * are safe to call only after the appropriate state has been reached. The
 * client never re-uses a request id, never retries a possibly-executed
 * step in place, and never completes a reused id with a late response.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  assertPlaytestAdapterParams,
  assertPlaytestAdapterResult,
  assertPlaytestJsonRpcNotification,
  assertPlaytestJsonRpcRequest,
  assertPlaytestJsonRpcResponse,
  type PlaytestAdapterErrorCode,
  type PlaytestAdapterMethod,
  type PlaytestAdapterNotification,
  type PlaytestAdapterQuotas,
  type PlaytestCapabilityAdvertisement,
  type PlaytestJsonRpcNotification,
  type PlaytestJsonRpcRequest,
  type PlaytestJsonRpcResponse,
  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES,
  PLAYTESTS_ADAPTER_DEFAULT_QUOTAS,
  PLAYTESTS_ADAPTER_METHODS,
  PLAYTESTS_ADAPTER_NOTIFICATIONS,
  PLAYTESTS_JSON_RPC_STANDARD_ERROR_CODES,
  PLAYTESTS_PROTOCOL_VERSION
} from "@simulatorlife/autodev-core";

import { JsonLineFrameError, JsonLineFramer } from "./jsonl-framer.ts";

/** Method names used by stateful request handling; Core owns the vocabulary. */
const GAME_RESET_METHOD: PlaytestAdapterMethod = "game.reset";
const GAME_STEP_METHOD: PlaytestAdapterMethod = "game.step";
const GAME_REPLAY_METHOD: PlaytestAdapterMethod = "game.replay";

/** Local reason for refusing work once the adapter request ceiling is reached. */
const QUEUE_FULL_DISPOSITION = "queue-full" as const;

/** Maximum bytes of one LF-terminated line; never above the v1 default. */
const MAX_LINE_BYTES = PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.maxMessageBytes;

/** Hard ceiling on simultaneously outstanding requests. */
const MAX_QUEUED_REQUESTS = PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.maxQueuedRequests;

/** Default ordinary-call deadline. */
const DEFAULT_ORDINARY_TIMEOUT_MS =
  PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.ordinaryCallTimeoutMs;

/** Default reset/replay deadline. */
const DEFAULT_RESET_REPLAY_TIMEOUT_MS =
  PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.resetReplayTimeoutMs;

/** Two-second grace before declaring a cancel lost. */
const CANCEL_GRACE_MS = PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.cancelGraceMs;
const MAX_ISSUED_REQUEST_IDS = 1_000_000;
const MAX_EPISODE_IDS = 100_000;
const MAX_EVENTS_PER_EPISODE = 100_000;
const MAX_DIAGNOSTIC_RECORDS = 2048;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2048;
const MAX_STDERR_CAPTURE_BYTES = 65_536;
const MAX_STDERR_LINE_CHARS = 4096;
const STANDARD_PARSE_ERROR = PLAYTESTS_JSON_RPC_STANDARD_ERROR_CODES.parseError;
const STANDARD_INVALID_REQUEST =
  PLAYTESTS_JSON_RPC_STANDARD_ERROR_CODES.invalidRequest;
const STANDARD_INVALID_PARAMS =
  PLAYTESTS_JSON_RPC_STANDARD_ERROR_CODES.invalidParams;
const STANDARD_METHOD_NOT_FOUND =
  PLAYTESTS_JSON_RPC_STANDARD_ERROR_CODES.methodNotFound;
/** Splits stderr chunks on CRLF or LF; hoisted to avoid per-call recompilation. */
const STDERR_LINE_SPLIT_PATTERN = /\r?\n/u;

/** Strips a trailing CR from a line; hoisted to avoid per-call recompilation. */
const TRAILING_CR_PATTERN = /\r$/u;

/** Methods whose effective deadline is `resetReplayTimeoutMs`. */
const RESET_REPLAY_METHODS: ReadonlySet<PlaytestAdapterMethod> = new Set([
  GAME_RESET_METHOD,
  GAME_REPLAY_METHOD
]);

const OPTIONAL_VOCABULARY: ReadonlySet<PlaytestAdapterMethod> = new Set([
  "game.invariants",
  "game.snapshot",
  GAME_REPLAY_METHOD,
  "game.fork",
  "game.captureEvents",
  "game.captureFrame"
]);

const NOTIFICATION_METHODS: ReadonlySet<PlaytestAdapterNotification> = new Set(
  PLAYTESTS_ADAPTER_NOTIFICATIONS
);

/** Methods that need a typed `expectedRevision` in their params. */
const REVISION_BOUND_METHODS: ReadonlySet<PlaytestAdapterMethod> = new Set([
  "game.observe",
  "game.legalActions",
  GAME_STEP_METHOD,
  "game.outcome",
  "game.invariants"
]);

/** Stream triplet + exit signal the client operates on. */
export interface PlaytestAdapterStreams {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Fires exactly once when the process is gone for any reason. */
  readonly onExit: (listener: (cause: PlaytestAdapterExit) => void) => void;
}

/** A captured process exit signal. */
export interface PlaytestAdapterExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: readonly string[];
}

/** Options for creating a client. */
export interface PlaytestAdapterClientOptions {
  /** Inject a deterministic id source. */
  readonly mintId?: () => string;
  /** Inject a clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Number of stderr lines preserved on EOF; default 64. */
  readonly stderrTailLines?: number;
}

/** Result of a single request call. */
/** Local disposition classification attached to every failed call result. */
export type PlaytestAdapterDisposition =
  | "unchanged"
  | "aborted"
  | "unknown"
  | "transport-failed"
  | "duplicate"
  | "oversized"
  | "version"
  | "malformed"
  | "stale-revision"
  | typeof QUEUE_FULL_DISPOSITION
  | "timeout"
  | "canceled"
  | "infrastructure"
  | "unsupported-capability";

export type PlaytestAdapterFailure = {
  readonly ok: false;
  readonly id: string;
  readonly code: PlaytestAdapterErrorCode;
  readonly message: string;
  readonly data?: unknown;
  readonly disposition: PlaytestAdapterDisposition;
};

export type PlaytestAdapterCallResult =
  | { readonly ok: true; readonly result: unknown; readonly id: string }
  | PlaytestAdapterFailure;

/** Summary of protocol cancellation attempts. */
export interface PlaytestAdapterCancellationReport {
  /** Typed acknowledgements/errors returned by game.cancel calls. */
  readonly results: readonly PlaytestAdapterCallResult[];
  /** Original request IDs still active after the v1 cancellation grace. */
  readonly unresolvedRequestIds: readonly string[];
}

/** A buffered, ordered notification delivered to listeners. */
export interface PlaytestAdapterNotificationEvent {
  readonly method: PlaytestAdapterNotification;
  readonly params: Readonly<Record<string, unknown>>;
  /** Monotonic, adapter-supplied sequence; `null` when the adapter omits one. */
  readonly sequence: number | null;
}

/** Diagnostic record preserved on EOF / fail-closed transitions. */
export interface PlaytestAdapterDiagnostic {
  readonly kind:
    | "stderr"
    | "eof"
    | "oversized"
    | "malformed"
    | "duplicate-id"
    | "wrong-version"
    | "unsupported-capability"
    | "stale-revision"
    | typeof QUEUE_FULL_DISPOSITION
    | "late-canceled-response"
    | "diagnostic-overflow";
  readonly message: string;
  readonly at: number;
  readonly id?: string;
}

/** Notification listener registration. */
export type PlaytestAdapterListener = (
  event: PlaytestAdapterNotificationEvent
) => void;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function defaultMintId(): string {
  return `r-${randomUUID()}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Schema contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (!isPlainObject(value))
    throw new TypeError("Schema must contain only JSON values.");
  const entries = Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]));
  return "{" + entries.join(",") + "}";
}

function schemaSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function assertCapabilitySchemaHashes(
  capabilities: PlaytestCapabilityAdvertisement
): void {
  const schemas = [
    [
      "observationSchema",
      capabilities.observationSchema,
      capabilities.observationSchemaHash
    ],
    ["actionSchema", capabilities.actionSchema, capabilities.actionSchemaHash],
    ["eventSchema", capabilities.eventSchema, capabilities.eventSchemaHash]
  ] as const;
  for (const [name, schema, expectedHash] of schemas) {
    if (schemaSha256(schema) !== expectedHash.toLowerCase()) {
      throw new TypeError(
        name + " does not match its negotiated SHA-256 schema hash."
      );
    }
  }
}

function assertBoundedId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new TypeError(
      "Request id must match the bounded alphanumeric+._:- pattern."
    );
  }
}

function isBoundedRevision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < 2 ** 31
  );
}

/** Inflight request record. */
interface InflightRequest {
  readonly id: string;
  readonly method: PlaytestAdapterMethod;
  readonly params: Readonly<Record<string, unknown>>;
  readonly timeoutAt: number;
  readonly listener: (result: PlaytestAdapterCallResult) => void;
  /** Set when the caller has explicitly asked to cancel. */
  cancelRequested: boolean;
  /** Filled with the original disposition once the request resolves. */
  settled: boolean;
}

/**
 * Single-instance JSON-RPC v1 stdio client.
 *
 * The client is bound to a single transport and a single capability
 * negotiation. Re-negotiating requires closing the transport and creating a
 * new client, which matches the "process isolation per attempt" boundary the
 * adapter contract requires.
 */
export class PlaytestAdapterClient {
  private readonly streams: PlaytestAdapterStreams;
  private readonly mintId: () => string;
  private readonly now: () => number;
  private readonly stderrTailLines: number;
  private state: "init" | "capabilities" | "ready" | "failClosed" = "init";
  private capabilities: PlaytestCapabilityAdvertisement | null = null;
  /** Original advertised quotas; the client narrows them with defaults. */
  private quotas: PlaytestAdapterQuotas = {
    maxMessageBytes: MAX_LINE_BYTES,
    maxQueuedRequests: MAX_QUEUED_REQUESTS,
    ordinaryCallTimeoutMs: DEFAULT_ORDINARY_TIMEOUT_MS,
    resetReplayTimeoutMs: DEFAULT_RESET_REPLAY_TIMEOUT_MS
  };
  /** Optional operations the adapter declared. */
  private optionalOperations: ReadonlySet<PlaytestAdapterMethod> = new Set();
  private readonly inflight = new Map<string, InflightRequest>();
  private readonly issuedIds = new Set<string>();
  private readonly issuedEpisodeIds = new Set<string>();
  private currentEpisodeId: string | null = null;
  private readonly eventIdsByEpisode = new Map<string, Set<string>>();
  private resetInFlight = false;
  /** Ids this client has explicitly asked the adapter to cancel; ids are never reused. */
  private readonly canceledIds = new Set<string>();
  private readonly lateCanceledResponseIds = new Set<string>();
  /** Event ordering is tracked per episode as specified by game.event. */
  private readonly lastEventSequenceByEpisode = new Map<string, number>();
  /** Progress counts are monotonic and retain a stable total per request. */
  private readonly progressByRequest = new Map<
    string,
    { readonly completed: number; readonly total: number }
  >();
  private readonly stderrTail: string[] = [];
  private stderrBytes = 0;
  private droppedDiagnosticCount = 0;
  private readonly diagnostics: PlaytestAdapterDiagnostic[] = [];
  private readonly listeners = new Set<PlaytestAdapterListener>();
  private exitFired = false;
  /** Bounded, amortized-linear line framing for stdout. */
  private readonly lineFramer = new JsonLineFramer(MAX_LINE_BYTES);
  private exitCause: PlaytestAdapterExit | null = null;
  private stderrOff: (() => void) | null = null;
  private stdoutOff: (() => void) | null = null;
  private exitListener: ((cause: PlaytestAdapterExit) => void) | null = null;

  constructor(
    streams: PlaytestAdapterStreams,
    options: PlaytestAdapterClientOptions = {}
  ) {
    this.streams = streams;
    this.mintId = options.mintId ?? defaultMintId;
    this.now = options.now ?? Date.now;
    this.stderrTailLines = options.stderrTailLines ?? 64;
    this.attachTransport();
  }

  /** Detach listeners and fail-closed all in-flight requests. */
  close(): void {
    if (this.state === "failClosed") return;
    this.detachTransport();
    this.failClosed("Caller closed the client.", undefined);
  }

  /** Read-only access to the negotiated capability advertisement. */
  getCapabilities(): PlaytestCapabilityAdvertisement | null {
    return this.capabilities;
  }

  /** All diagnostics captured so far. The list is append-only. */
  getDiagnostics(): readonly PlaytestAdapterDiagnostic[] {
    return this.diagnostics;
  }

  /** Stderr lines preserved (most recent at the end). */
  getStderrTail(): readonly string[] {
    return this.stderrTail;
  }

  /** Incomplete trailing stdout bytes retained on EOF for partial-evidence storage. */
  getUnterminatedLineBytes(): Buffer {
    return this.lineFramer.pendingLine();
  }

  /** Current effective state. */
  getState(): "init" | "capabilities" | "ready" | "failClosed" {
    return this.state;
  }

  /** True once the transport has failed closed; reads a fresh value every call. */
  private isFailClosed(): boolean {
    const state: "init" | "capabilities" | "ready" | "failClosed" = this.state;
    return state === "failClosed";
  }

  /** Add a notification listener; returns the unsubscribe function. */
  onNotification(listener: PlaytestAdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Perform the initial capability negotiation. Must be called before any
   * other method. The caller's deadline is reduced by any lower advertised
   * `resetReplayTimeoutMs` so a misbehaving adapter cannot extend its
   * own timeouts beyond the Core defaults.
   */
  async negotiateCapabilities(
    deadlineMs: number = DEFAULT_ORDINARY_TIMEOUT_MS
  ): Promise<PlaytestCapabilityAdvertisement> {
    if (this.state !== "init") {
      throw new TypeError(
        `Capability negotiation is only valid in the 'init' state; current state is '${this.state}'.`
      );
    }
    this.state = "capabilities";
    const effectiveDeadline = Math.min(deadlineMs, DEFAULT_ORDINARY_TIMEOUT_MS);
    const response = await this.sendRequest(
      "game.capabilities",
      { protocolVersion: PLAYTESTS_PROTOCOL_VERSION },
      effectiveDeadline
    );
    if (!response.ok) {
      this.state = "failClosed";
      throw new PlaytestAdapterProtocolError(
        `Capability negotiation failed: ${response.message}`,
        response.code,
        response.data
      );
    }
    const capabilities = response.result as PlaytestCapabilityAdvertisement;
    try {
      assertCapabilitySchemaHashes(capabilities);
    } catch (error) {
      this.state = "failClosed";
      const reason = error instanceof TypeError ? error.message : String(error);
      this.recordDiagnostic({
        kind: "malformed",
        message: "Capability schema hash verification failed: " + reason,
        at: this.now()
      });
      throw new PlaytestAdapterProtocolError(
        "Capability schema hash verification failed: " + reason,
        PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability,
        { category: "schema-hash-mismatch", retryable: false }
      );
    }
    this.capabilities = capabilities;
    this.quotas = narrowQuotas(capabilities.quotas);
    this.optionalOperations = new Set(capabilities.optionalOperations);
    this.state = "ready";
    return capabilities;
  }

  /**
   * Issue a typed `game.step` request. The caller passes the
   * `expectedRevision` observed on the matching `game.observe`; the client
   * records it on the wire and the response's `revision` must match before
   * the call resolves as success. A revision mismatch resolves as a typed
   * `staleRevision` rejection without any retry.
   */
  step(params: PlaytestStepParams): Promise<PlaytestAdapterCallResult> {
    return this.call(GAME_STEP_METHOD, {
      episodeId: params.episodeId,
      actionId: params.actionId,
      expectedRevision: params.expectedRevision
    });
  }

  /**
   * Issue a request against any method (mandatory or optional). Methods
   * declared unsupported by the adapter are rejected locally with the
   * `unsupportedCapability` code without going on the wire.
   */
  call(
    method: PlaytestAdapterMethod,
    params: Readonly<Record<string, unknown>> = {},
    options: { readonly deadlineMs?: number } = {}
  ): Promise<PlaytestAdapterCallResult> {
    if (this.state !== "ready") {
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability,
          `Method '${method}' requires the 'ready' state; current state is '${this.state}'.`,
          "infrastructure"
        )
      );
    }
    if (!PLAYTESTS_ADAPTER_METHODS.includes(method)) {
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability,
          `Method '${method}' is not part of the v1 method vocabulary.`,
          "infrastructure"
        )
      );
    }
    if (
      OPTIONAL_VOCABULARY.has(method) &&
      !this.optionalOperations.has(method)
    ) {
      this.recordDiagnostic({
        kind: "unsupported-capability",
        message: `Adapter did not advertise optional method '${method}'.`,
        at: this.now()
      });
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability,
          `Adapter did not advertise optional method '${method}'.`,
          "unsupported-capability"
        )
      );
    }
    if (
      method === GAME_RESET_METHOD &&
      (this.resetInFlight ||
        [...this.inflight.values()].some(
          (entry) => entry.method === GAME_STEP_METHOD
        ))
    ) {
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.quota,
          "game.reset cannot race an in-flight game.step or another game.reset.",
          QUEUE_FULL_DISPOSITION
        )
      );
    }
    if (method === GAME_STEP_METHOD && this.resetInFlight) {
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.quota,
          "game.step cannot race an in-flight game.reset.",
          QUEUE_FULL_DISPOSITION
        )
      );
    }
    if (REVISION_BOUND_METHODS.has(method)) {
      if (params.expectedRevision === undefined) {
        return Promise.resolve(
          this.transportErrorResult(
            PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.staleRevision,
            `Method '${method}' requires an expectedRevision parameter.`,
            "stale-revision"
          )
        );
      }
      if (!isBoundedRevision(params.expectedRevision)) {
        return Promise.resolve(
          this.transportErrorResult(
            PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.illegalAction,
            `Method '${method}' received a non-integer or out-of-range expectedRevision.`,
            "malformed"
          )
        );
      }
    }
    const deadline = options.deadlineMs ?? this.defaultDeadlineFor(method);
    if (method !== GAME_RESET_METHOD) {
      return this.sendRequest(method, params, deadline);
    }
    this.resetInFlight = true;
    return this.sendRequest(method, params, deadline).finally(() => {
      this.resetInFlight = false;
    });
  }

  /**
   * Cancel an in-flight request. The named id is the only id the server may
   * identify in the response; the local disposition of the original request
   * is kept as `unknown` until the original request resolves. A late
   * response to a canceled id is recorded as a diagnostic and never
   * completes a new request - ids are never reused.
   */
  async cancel(inflightId: string): Promise<PlaytestAdapterCallResult> {
    assertBoundedId(inflightId);
    if (this.state === "failClosed") {
      return this.transportErrorResult(
        PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.engineFailure,
        "Client is fail-closed; cancel cannot be issued.",
        "transport-failed"
      );
    }
    const inflight = this.inflight.get(inflightId);
    if (!inflight) {
      return this.transportErrorResult(
        PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.illegalAction,
        `No in-flight request with id '${inflightId}'.`,
        "infrastructure"
      );
    }
    if (inflight.cancelRequested) {
      return {
        ok: false,
        id: inflightId,
        code: PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.cancelled,
        message: "Cancellation is already pending for this request.",
        disposition: "unknown"
      };
    }
    inflight.cancelRequested = true;
    this.canceledIds.add(inflightId);
    const response = await this.sendRequest(
      "game.cancel",
      { requestId: inflightId },
      CANCEL_GRACE_MS
    );
    if (this.state === "ready" && this.inflight.has(inflightId)) {
      // Wait up to CANCEL_GRACE_MS for the original to resolve on its own.
      await this.waitForInflight(inflightId, CANCEL_GRACE_MS);
    }
    return response;
  }

  /**
   * Request protocol-level cancellation for every currently active operation.
   * The caller must terminate the sandbox if any request remains unresolved or
   * if the process must not continue after cancellation.
   */
  async cancelInflightRequests(): Promise<PlaytestAdapterCancellationReport> {
    const requestIds = [...this.inflight.values()]
      .filter((entry) => entry.method !== "game.cancel")
      .map((entry) => entry.id);
    const results = await Promise.all(requestIds.map((id) => this.cancel(id)));
    return {
      results,
      unresolvedRequestIds: requestIds.filter((id) => this.inflight.has(id))
    };
  }

  // -- private ---------------------------------------------------------------

  private attachTransport(): void {
    this.stdoutOff = attachReadable(this.streams.stdout, (chunk: Buffer) =>
      this.onStdoutChunk(chunk)
    );
    this.stderrOff = attachReadable(this.streams.stderr, (chunk: Buffer) =>
      this.onStderrChunk(chunk)
    );
    this.exitListener = (cause) => this.onProcessExit(cause);
    this.streams.onExit(this.exitListener);
  }

  private detachTransport(): void {
    this.stdoutOff?.();
    this.stderrOff?.();
    if (this.exitListener) {
      // The onExit contract is one-shot; we keep a single reference so the
      // caller's emitter can be GC'd alongside the client.
      this.exitListener = null;
    }
    this.stdoutOff = null;
    this.stderrOff = null;
  }

  private recordDiagnostic(entry: PlaytestAdapterDiagnostic): void {
    if (this.diagnostics.length >= MAX_DIAGNOSTIC_RECORDS) {
      this.droppedDiagnosticCount += 1;
      const marker = this.diagnostics.at(-1);
      if (marker?.kind === "diagnostic-overflow") {
        this.diagnostics[this.diagnostics.length - 1] = {
          ...marker,
          message:
            "Additional adapter diagnostics were dropped. Total dropped: " +
            String(this.droppedDiagnosticCount) +
            "."
        };
      } else {
        this.diagnostics[this.diagnostics.length - 1] = {
          kind: "diagnostic-overflow",
          message:
            "Additional adapter diagnostics were dropped. Total dropped: 1.",
          at: entry.at
        };
      }
      return;
    }
    this.diagnostics.push({
      ...entry,
      message: entry.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS)
    });
  }

  private onStderrChunk(chunk: Buffer): void {
    const remaining = Math.max(0, MAX_STDERR_CAPTURE_BYTES - this.stderrBytes);
    const captured = chunk.subarray(0, remaining);
    this.stderrBytes += captured.length;
    if (captured.length < chunk.length) {
      this.recordDiagnostic({
        kind: "stderr",
        message:
          "Adapter stderr capture reached its byte limit; remaining diagnostics were omitted.",
        at: this.now()
      });
    }
    const text = captured.toString("utf8");
    for (const line of text.split(STDERR_LINE_SPLIT_PATTERN)) {
      if (line.length === 0) continue;
      this.stderrTail.push(line.slice(0, MAX_STDERR_LINE_CHARS));
      if (this.stderrTail.length > this.stderrTailLines) {
        this.stderrTail.splice(
          0,
          this.stderrTail.length - this.stderrTailLines
        );
      }
      this.recordDiagnostic({
        kind: "stderr",
        message: line,
        at: this.now()
      });
    }
  }

  private onStdoutChunk(chunk: Buffer): void {
    if (this.isFailClosed()) return;
    let lines: readonly Buffer[];
    try {
      lines = this.lineFramer.push(chunk);
    } catch (error) {
      const oversized = error instanceof JsonLineFrameError;
      this.recordDiagnostic({
        kind: oversized ? "oversized" : "malformed",
        message: oversized
          ? "Inbound adapter line exceeded the negotiated byte ceiling."
          : "Inbound adapter line framing failed.",
        at: this.now()
      });
      this.failClosed(
        oversized ? "Oversized inbound line." : "Invalid inbound line framing.",
        oversized
          ? PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.quota
          : STANDARD_INVALID_REQUEST
      );
      return;
    }
    for (const line of lines) {
      this.handleLine(line);
      if (this.isFailClosed()) return;
    }
  }

  private handleLine(line: Buffer): void {
    const raw = line.toString("utf8").replace(TRAILING_CR_PATTERN, "");
    if (raw.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.recordDiagnostic({
        kind: "malformed",
        message: `JSON parse failed: ${(error as Error).message}`,
        at: this.now()
      });
      this.failClosed("Malformed JSON envelope.", STANDARD_PARSE_ERROR);
      return;
    }
    if (Array.isArray(parsed)) {
      this.recordDiagnostic({
        kind: "malformed",
        message: "Batch JSON-RPC arrays are not supported.",
        at: this.now()
      });
      this.failClosed(
        "Batch JSON-RPC arrays are not supported.",
        PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.illegalAction
      );
      return;
    }
    if (!isPlainObject(parsed) || parsed.jsonrpc !== "2.0") {
      this.recordDiagnostic({
        kind: "wrong-version",
        message: `Envelope missing or wrong jsonrpc version: ${String(
          (parsed as { jsonrpc?: unknown })?.jsonrpc
        )}.`,
        at: this.now()
      });
      this.failClosed(
        "Wrong JSON-RPC version.",
        PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.illegalAction
      );
      return;
    }
    if ("method" in parsed) {
      this.handleNotification(parsed as unknown as PlaytestJsonRpcNotification);
      return;
    }
    this.handleResponse(parsed as unknown as PlaytestJsonRpcResponse);
  }

  private handleNotification(value: PlaytestJsonRpcNotification): void {
    try {
      assertPlaytestJsonRpcNotification(value);
    } catch (error) {
      this.recordDiagnostic({
        kind: "malformed",
        message: "Notification rejected: " + (error as Error).message,
        at: this.now()
      });
      this.failClosed(
        "Malformed notification envelope.",
        STANDARD_INVALID_REQUEST
      );
      return;
    }
    if (!NOTIFICATION_METHODS.has(value.method)) {
      this.recordDiagnostic({
        kind: "malformed",
        message:
          "Notification method is not in the v1 vocabulary: " + value.method,
        at: this.now()
      });
      this.failClosed(
        "Unknown notification method.",
        STANDARD_METHOD_NOT_FOUND
      );
      return;
    }
    if (value.method === "game.progress") {
      this.handleGameProgressNotification(value);
      return;
    }
    this.handleGameEventNotification(value);
  }

  private handleGameEventNotification(
    notification: PlaytestJsonRpcNotification
  ): void {
    const params = notification.params;
    const episodeId = params.episodeId;
    const revision = params.revision;
    const sequence = params.eventSequence;
    const event = params.event;
    if (
      Object.keys(params).some(
        (key) =>
          !["episodeId", "revision", "eventSequence", "event"].includes(key)
      ) ||
      typeof episodeId !== "string" ||
      episodeId.length === 0 ||
      episodeId !== this.currentEpisodeId ||
      !isBoundedRevision(revision) ||
      !isBoundedRevision(sequence) ||
      !isPlainObject(event) ||
      typeof event.eventId !== "string" ||
      event.eventId.length === 0 ||
      typeof event.type !== "string" ||
      event.type.length === 0 ||
      !isBoundedRevision(event.step) ||
      event.revision !== revision ||
      (event.phaseId !== null && typeof event.phaseId !== "string") ||
      (event.actor !== null && typeof event.actor !== "string") ||
      !isPlainObject(event.fields)
    ) {
      this.recordDiagnostic({
        kind: "malformed",
        message:
          "game.event requires episodeId, revision, eventSequence and a typed event payload.",
        at: this.now()
      });
      this.failClosed(
        "Malformed game.event notification.",
        STANDARD_INVALID_PARAMS
      );
      return;
    }
    const lastSequence = this.lastEventSequenceByEpisode.get(episodeId) ?? 0;
    const eventIds = this.eventIdsByEpisode.get(episodeId);
    if (
      sequence !== lastSequence + 1 ||
      !eventIds ||
      eventIds.has(event.eventId as string) ||
      eventIds.size >= MAX_EVENTS_PER_EPISODE
    ) {
      this.recordDiagnostic({
        kind: "malformed",
        message:
          "Out-of-order, duplicate, or over-limit game.event sequence or identity.",
        at: this.now()
      });
      this.failClosed(
        "game.event sequence is inconsistent.",
        STANDARD_INVALID_REQUEST
      );
      return;
    }
    this.lastEventSequenceByEpisode.set(episodeId, sequence);
    eventIds.add(event.eventId as string);
    this.deliverNotification({
      method: "game.event",
      params,
      sequence
    });
  }

  private handleGameProgressNotification(
    notification: PlaytestJsonRpcNotification
  ): void {
    const params = notification.params;
    const requestId = params.requestId;
    const completed = params.completed;
    const total = params.total;
    if (
      Object.keys(params).some(
        (key) => !["requestId", "completed", "total"].includes(key)
      ) ||
      typeof requestId !== "string" ||
      !this.issuedIds.has(requestId) ||
      !isBoundedRevision(completed) ||
      !isBoundedRevision(total) ||
      completed > total
    ) {
      this.recordDiagnostic({
        kind: "malformed",
        message:
          "game.progress must name an issued request and bounded completed/total counts.",
        at: this.now(),
        ...(typeof requestId === "string" ? { id: requestId } : {})
      });
      this.failClosed(
        "Malformed game.progress notification.",
        STANDARD_INVALID_PARAMS
      );
      return;
    }
    if (!this.inflight.has(requestId)) {
      this.recordDiagnostic({
        kind: "eof",
        message:
          "Late game.progress notification ignored for a completed request.",
        at: this.now(),
        id: requestId
      });
      return;
    }
    const previous = this.progressByRequest.get(requestId);
    if (
      previous &&
      (completed < previous.completed || total !== previous.total)
    ) {
      this.recordDiagnostic({
        kind: "malformed",
        message:
          "game.progress counts regressed or changed total for request " +
          requestId +
          ".",
        at: this.now(),
        id: requestId
      });
      this.failClosed(
        "game.progress sequence is inconsistent.",
        STANDARD_INVALID_REQUEST
      );
      return;
    }
    this.progressByRequest.set(requestId, { completed, total });
    this.deliverNotification({
      method: "game.progress",
      params,
      sequence: null
    });
  }

  private deliverNotification(event: PlaytestAdapterNotificationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.recordDiagnostic({
          kind: "malformed",
          message: "Notification listener failed: " + (error as Error).message,
          at: this.now()
        });
      }
    }
  }

  private handleResponse(value: PlaytestJsonRpcResponse): void {
    if (this.isFailClosed()) {
      this.recordDiagnostic({
        kind: "malformed",
        message: "Response received after fail-closed transition.",
        at: this.now(),
        ...(typeof value.id === "string" ? { id: value.id } : {})
      });
      return;
    }
    try {
      assertPlaytestJsonRpcResponse(value);
    } catch (error) {
      this.recordDiagnostic({
        kind: "malformed",
        message: "Response envelope rejected: " + (error as Error).message,
        at: this.now(),
        ...(typeof value.id === "string" ? { id: value.id } : {})
      });
      this.failClosed("Malformed response envelope.", STANDARD_INVALID_REQUEST);
      return;
    }
    if (value.id === null) {
      this.recordDiagnostic({
        kind: "malformed",
        message: "Null-id response received without a matching request.",
        at: this.now()
      });
      this.failClosed(
        "Null-id response without a matching request.",
        STANDARD_INVALID_REQUEST
      );
      return;
    }
    const inflight = this.inflight.get(value.id);
    if (!inflight) {
      this.handleUnmatchedResponse(value.id);
      return;
    }
    if (inflight.settled) {
      this.recordDiagnostic({
        kind: "duplicate-id",
        message: "Duplicate response for id " + value.id + ".",
        at: this.now(),
        id: value.id
      });
      this.failClosed(
        "Duplicate response for a settled request.",
        STANDARD_INVALID_REQUEST
      );
      return;
    }
    if ("error" in value) {
      this.settleErrorResponse(inflight, value);
      return;
    }
    this.settleSuccessResponse(inflight, value);
  }

  private handleUnmatchedResponse(id: string): void {
    if (this.canceledIds.has(id) && !this.lateCanceledResponseIds.has(id)) {
      this.lateCanceledResponseIds.add(id);
      this.recordDiagnostic({
        kind: "late-canceled-response",
        message:
          "Late response to canceled id " + id + " retained as diagnostic.",
        at: this.now(),
        id
      });
      return;
    }
    this.recordDiagnostic({
      kind: "duplicate-id",
      message: "Unexpected or duplicate response for unknown id " + id + ".",
      at: this.now(),
      id
    });
    this.failClosed(
      "Unexpected or duplicate response id.",
      STANDARD_INVALID_REQUEST
    );
  }

  private settleErrorResponse(
    inflight: InflightRequest,
    response: Extract<PlaytestJsonRpcResponse, { readonly error: unknown }>
  ): void {
    inflight.settled = true;
    this.inflight.delete(inflight.id);
    this.progressByRequest.delete(inflight.id);
    const data = response.error.data;
    const isApplicationError = Object.values(
      PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES
    ).includes(
      response.error
        .code as (typeof PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES)[keyof typeof PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES]
    );
    const dataDisposition =
      isPlainObject(data) &&
      (data.episodeDisposition === "unchanged" ||
        data.episodeDisposition === "aborted" ||
        data.episodeDisposition === "unknown")
        ? data.episodeDisposition
        : "unknown";
    const disposition: PlaytestAdapterDisposition = isApplicationError
      ? dataDisposition
      : "unchanged";
    inflight.listener({
      ok: false,
      id: inflight.id,
      code: response.error.code,
      message: response.error.message,
      ...(data === undefined ? {} : { data }),
      disposition
    });
  }

  private settleSuccessResponse(
    inflight: InflightRequest,
    response: Extract<PlaytestJsonRpcResponse, { readonly result: unknown }>
  ): void {
    try {
      assertPlaytestAdapterResult(
        inflight.method,
        inflight.params,
        response.result
      );
    } catch (error) {
      const message = "Adapter result rejected: " + (error as Error).message;
      const capabilityRejected = inflight.method === "game.capabilities";
      const code = capabilityRejected
        ? PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability
        : STANDARD_INVALID_REQUEST;
      this.recordDiagnostic({
        kind: "malformed",
        message,
        at: this.now(),
        id: inflight.id
      });
      inflight.settled = true;
      this.inflight.delete(inflight.id);
      this.progressByRequest.delete(inflight.id);
      inflight.listener({
        ok: false,
        id: inflight.id,
        code,
        message,
        disposition: capabilityRejected ? "unsupported-capability" : "unknown"
      });
      this.failClosed(message, code);
      return;
    }
    if (inflight.method === GAME_RESET_METHOD) {
      const episodeId = (response.result as { readonly episodeId: string })
        .episodeId;
      if (
        this.issuedEpisodeIds.has(episodeId) ||
        this.issuedEpisodeIds.size >= MAX_EPISODE_IDS
      ) {
        const message =
          "game.reset reused an episode id or exceeded the per-process episode limit.";
        this.recordDiagnostic({
          kind: "malformed",
          message,
          at: this.now(),
          id: inflight.id
        });
        inflight.settled = true;
        this.inflight.delete(inflight.id);
        this.progressByRequest.delete(inflight.id);
        inflight.listener({
          ok: false,
          id: inflight.id,
          code: STANDARD_INVALID_REQUEST,
          message,
          disposition: "unknown"
        });
        this.failClosed(message, STANDARD_INVALID_REQUEST);
        return;
      }
      this.issuedEpisodeIds.add(episodeId);
      this.currentEpisodeId = episodeId;
      this.lastEventSequenceByEpisode.clear();
      this.lastEventSequenceByEpisode.set(episodeId, 0);
      this.eventIdsByEpisode.clear();
      this.eventIdsByEpisode.set(episodeId, new Set());
    }
    inflight.settled = true;
    this.inflight.delete(inflight.id);
    this.progressByRequest.delete(inflight.id);
    inflight.listener({ ok: true, result: response.result, id: inflight.id });
  }

  private onProcessExit(cause: PlaytestAdapterExit): void {
    if (this.exitFired) return;
    this.exitFired = true;
    this.exitCause = cause;
    const stderrCopy = [...this.stderrTail];
    for (const line of cause.stderrTail) {
      stderrCopy.push(line);
    }
    this.recordDiagnostic({
      kind: "eof",
      message: `Adapter process exited (code=${String(
        cause.code
      )}, signal=${String(cause.signal)}).`,
      at: this.now()
    });
    this.failClosed(
      "Adapter process exited.",
      PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.engineFailure,
      stderrCopy
    );
  }

  private failClosed(
    reason: string,
    code: PlaytestAdapterErrorCode = PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.engineFailure,
    preservedStderr?: readonly string[]
  ): void {
    if (this.state === "failClosed") {
      return;
    }
    this.state = "failClosed";
    if (preservedStderr) {
      for (const line of preservedStderr.slice(-this.stderrTailLines)) {
        if (this.stderrTail.at(-1) !== line) {
          this.stderrTail.push(line.slice(0, MAX_STDERR_LINE_CHARS));
        }
      }
    }
    for (const inflight of this.inflight.values()) {
      this.inflight.delete(inflight.id);
      this.progressByRequest.delete(inflight.id);
      const result: PlaytestAdapterCallResult = inflight.cancelRequested
        ? {
            ok: false,
            id: inflight.id,
            code: PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.cancelled,
            message: `Original request '${inflight.id}' was canceled before the transport closed.`,
            disposition: "unknown"
          }
        : {
            ok: false,
            id: inflight.id,
            code,
            message: `${reason} Original request '${inflight.id}' was in flight.`,
            disposition: "unknown"
          };
      try {
        inflight.listener(result);
      } catch {
        // The caller may have already detached; swallow.
      }
    }
    // Keep the incomplete line available to the runner for bounded partial-evidence storage.
  }

  private defaultDeadlineFor(method: PlaytestAdapterMethod): number {
    return RESET_REPLAY_METHODS.has(method)
      ? this.quotas.resetReplayTimeoutMs
      : this.quotas.ordinaryCallTimeoutMs;
  }

  private sendRequest(
    method: PlaytestAdapterMethod,
    params: Readonly<Record<string, unknown>>,
    deadlineMs: number
  ): Promise<PlaytestAdapterCallResult> {
    if (this.state === "failClosed") {
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.engineFailure,
          "Client is fail-closed.",
          "transport-failed"
        )
      );
    }
    try {
      assertPlaytestAdapterParams(method, params);
    } catch (error) {
      return Promise.resolve(
        this.transportErrorResult(
          STANDARD_INVALID_PARAMS,
          "Adapter method params were rejected: " + (error as Error).message,
          "malformed"
        )
      );
    }
    const effectiveCeiling = Math.min(
      this.quotas.maxQueuedRequests,
      MAX_QUEUED_REQUESTS
    );
    if (this.inflight.size >= effectiveCeiling) {
      this.recordDiagnostic({
        kind: QUEUE_FULL_DISPOSITION,
        message: `Outstanding request ceiling reached (${String(
          this.inflight.size
        )} of ${String(effectiveCeiling)}).`,
        at: this.now()
      });
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.quota,
          `Outstanding request ceiling reached (${String(
            this.inflight.size
          )} of ${String(effectiveCeiling)}).`,
          QUEUE_FULL_DISPOSITION
        )
      );
    }
    if (this.issuedIds.size >= MAX_ISSUED_REQUEST_IDS) {
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.quota,
          "Adapter request-id budget exhausted for this process.",
          QUEUE_FULL_DISPOSITION
        )
      );
    }
    const id = this.mintId();
    assertBoundedId(id);
    if (this.issuedIds.has(id)) {
      // The minting function must be collision-free; this is a server /
      // generator failure and we fail closed rather than reuse the id.
      this.failClosed(
        `Minted id '${id}' was already issued on this adapter process.`,
        PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.illegalAction
      );
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.illegalAction,
          "Minted id was already issued on this adapter process.",
          "duplicate"
        )
      );
    }
    const envelope: PlaytestJsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params }
    };
    try {
      assertPlaytestJsonRpcRequest(envelope);
    } catch (error) {
      return Promise.resolve(
        this.transportErrorResult(
          STANDARD_INVALID_PARAMS,
          "Outbound envelope rejected: " + (error as Error).message,
          "malformed"
        )
      );
    }
    const line = JSON.stringify(envelope) + "\n";
    if (
      Buffer.byteLength(line, "utf8") >
      Math.min(this.quotas.maxMessageBytes, MAX_LINE_BYTES)
    ) {
      return Promise.resolve(
        this.transportErrorResult(
          PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.quota,
          "Outbound JSON-RPC line exceeds the negotiated message-byte limit.",
          "oversized"
        )
      );
    }
    this.issuedIds.add(id);
    return new Promise<PlaytestAdapterCallResult>((resolve) => {
      const inflight: InflightRequest = {
        id,
        method,
        params: { ...params },
        timeoutAt: this.now() + Math.max(1, deadlineMs),
        listener: (result) => resolve(result),
        cancelRequested: false,
        settled: false
      };
      this.inflight.set(id, inflight);
      const written = this.streams.stdin.write(line, "utf8", (error) => {
        if (error) {
          this.recordDiagnostic({
            kind: "eof",
            message: `stdin write failed: ${error.message}`,
            at: this.now(),
            id
          });
          if (this.inflight.has(id)) {
            const target = this.inflight.get(id);
            this.inflight.delete(id);
            if (target && !target.settled) {
              target.settled = true;
              target.listener(
                this.transportErrorResult(
                  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.engineFailure,
                  `stdin write failed: ${error.message}`,
                  "infrastructure"
                )
              );
            }
          }
        }
      });
      if (written === false) {
        // Honour backpressure by waiting for the drain event; the call to
        // `write` already attached a callback, so this is purely advisory
        // for the caller.
      }
      this.scheduleTimeout(inflight);
    });
  }

  private scheduleTimeout(inflight: InflightRequest): void {
    const remaining = inflight.timeoutAt - this.now();
    if (remaining <= 0) {
      this.expireInflight(inflight, "timeout");
      return;
    }
    setTimeout(() => {
      if (this.inflight.has(inflight.id) && !inflight.settled) {
        this.expireInflight(inflight, "timeout");
      }
    }, remaining).unref?.();
  }

  private expireInflight(
    inflight: InflightRequest,
    reason: "timeout" | "cancel-grace"
  ): void {
    if (inflight.settled) return;
    if (this.inflight.has(inflight.id)) {
      this.inflight.delete(inflight.id);
    }
    this.progressByRequest.delete(inflight.id);
    inflight.settled = true;
    const code =
      reason === "timeout"
        ? PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.quota
        : PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.cancelled;
    const disposition: PlaytestAdapterDisposition = "unknown";
    inflight.listener({
      ok: false,
      id: inflight.id,
      code,
      message:
        reason === "timeout"
          ? `Request '${inflight.id}' exceeded its ${inflight.method} deadline.`
          : `Request '${inflight.id}' exceeded its cancel grace.`,
      disposition
    });
  }

  private waitForInflight(id: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = this.now() + Math.max(1, timeoutMs);
      const tick = (): void => {
        if (!this.inflight.has(id)) {
          resolve();
          return;
        }
        if (this.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(tick, 5).unref?.();
      };
      tick();
    });
  }

  private transportErrorResult(
    code: PlaytestAdapterErrorCode,
    message: string,
    disposition: PlaytestAdapterDisposition
  ): PlaytestAdapterFailure {
    return {
      ok: false,
      id: "",
      code,
      message,
      disposition
    };
  }
}

function narrowQuotas(
  advertised: PlaytestAdapterQuotas
): PlaytestAdapterQuotas {
  return {
    maxMessageBytes: Math.min(advertised.maxMessageBytes, MAX_LINE_BYTES),
    maxQueuedRequests: Math.min(
      advertised.maxQueuedRequests,
      MAX_QUEUED_REQUESTS
    ),
    ordinaryCallTimeoutMs: Math.min(
      advertised.ordinaryCallTimeoutMs,
      DEFAULT_ORDINARY_TIMEOUT_MS
    ),
    resetReplayTimeoutMs: Math.min(
      advertised.resetReplayTimeoutMs,
      DEFAULT_RESET_REPLAY_TIMEOUT_MS
    )
  };
}

function attachReadable(
  stream: Readable,
  listener: (chunk: Buffer) => void
): () => void {
  const handler = (chunk: Buffer | string): void => {
    listener(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  };
  stream.on("data", handler);
  return () => {
    stream.off("data", handler);
  };
}

/** Public error class for protocol-level negotiation failures. */
export class PlaytestAdapterProtocolError extends Error {
  readonly code: PlaytestAdapterErrorCode;
  readonly data: unknown;
  constructor(message: string, code: PlaytestAdapterErrorCode, data?: unknown) {
    super(message);
    this.name = "PlaytestAdapterProtocolError";
    this.code = code;
    this.data = data;
  }
}

/** Parameters accepted by {@link PlaytestAdapterClient.step}. */
export interface PlaytestStepParams {
  readonly episodeId: string;
  readonly actionId: string;
  readonly expectedRevision: number;
}

export const __testing = {
  narrowQuotas,
  ID_PATTERN,
  REVISION_BOUND_METHODS,
  RESET_REPLAY_METHODS,
  MAX_LINE_BYTES,
  MAX_QUEUED_REQUESTS,
  DEFAULT_ORDINARY_TIMEOUT_MS,
  DEFAULT_RESET_REPLAY_TIMEOUT_MS,
  CANCEL_GRACE_MS
} as const;
