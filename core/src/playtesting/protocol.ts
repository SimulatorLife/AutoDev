/**
 * JSON-RPC v1 envelope validators for the Core-owned game-adapter contract.
 *
 * The protocol is intentionally stricter than JSON-RPC 2.0: a fresh
 * `expectedRevision` must accompany every `submit_step`, the adapter may only
 * answer with the closed `error.code` vocabulary below, and a missing
 * `advertise_capabilities` call is treated as protocol violation rather than
 * as a successful but unspecified session.
 *
 * Validators throw `TypeError` with a single-line reason so the Runtime can
 * log them verbatim; they never return a permissive `{ valid: false }` that
 * a downstream caller could silently drop.
 */

import {
  type PlaytestAdapterErrorCode,
  type PlaytestAdapterMethod,
  type PlaytestCapabilityAdvertisement,
  type PlaytestEvidenceLocator,
  type PlaytestJsonRpcError,
  type PlaytestJsonRpcNotification,
  type PlaytestJsonRpcRequest,
  type PlaytestJsonRpcResponse,
  type PlaytestJsonRpcSuccess,
  type PlaytestLocatorKind,
  type PlaytestMiniPxiItem,
  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES,
  PLAYTESTS_ADAPTER_DEFAULT_QUOTAS,
  PLAYTESTS_ADAPTER_ERROR_CODES,
  PLAYTESTS_ADAPTER_METHODS,
  PLAYTESTS_ADAPTER_NOTIFICATIONS,
  PLAYTESTS_GAME_MODES,
  PLAYTESTS_LOCATOR_KINDS,
  PLAYTESTS_MINIPXI_ENJ_MAX,
  PLAYTESTS_MINIPXI_ENJ_MIN,
  PLAYTESTS_MINIPXI_ITEMS,
  PLAYTESTS_OPTIONAL_ADAPTER_METHODS,
  PLAYTESTS_PROTOCOL_VERSION
} from "./types.ts";

/** Is `value` one of the documented JSON-RPC error codes? */
export function isPlaytestAdapterErrorCode(
  value: unknown
): value is PlaytestAdapterErrorCode {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (PLAYTESTS_ADAPTER_ERROR_CODES as readonly number[]).includes(value)
  );
}

/** Is `value` one of the documented JSON-RPC methods? */
export function isPlaytestAdapterMethod(
  value: unknown
): value is PlaytestAdapterMethod {
  return (
    typeof value === "string" &&
    (PLAYTESTS_ADAPTER_METHODS as readonly string[]).includes(value)
  );
}

/** Is `value` one of the documented wire modes? */
function isPlaytestGameMode(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (PLAYTESTS_GAME_MODES as readonly string[]).includes(value)
  );
}

function isOptionalAdapterMethod(
  value: unknown
): value is (typeof PLAYTESTS_OPTIONAL_ADAPTER_METHODS)[number] {
  return (
    typeof value === "string" &&
    (PLAYTESTS_OPTIONAL_ADAPTER_METHODS as readonly string[]).includes(value)
  );
}

/** Is `value` one of the documented evidence locator kinds? */
export function isPlaytestLocatorKind(
  value: unknown
): value is PlaytestLocatorKind {
  return (
    typeof value === "string" &&
    (PLAYTESTS_LOCATOR_KINDS as readonly string[]).includes(value)
  );
}

/** Is `value` one of the documented miniPXI items? */
export function isPlaytestMiniPxiItem(
  value: unknown
): value is PlaytestMiniPxiItem {
  return (
    typeof value === "string" &&
    (PLAYTESTS_MINIPXI_ITEMS as readonly string[]).includes(value)
  );
}

function isPlainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

const APPLICATION_ERROR_CODE_SET = new Set<number>(
  Object.values(PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES)
);
const SHA256_HEX_PATTERN = /^[a-f\d]{64}$/iu;

function isApplicationErrorCode(value: number): boolean {
  return APPLICATION_ERROR_CODE_SET.has(value);
}

/** Validate a strict, single JSON-RPC v1 request envelope (never a batch). */
export function assertPlaytestJsonRpcRequest(
  value: unknown
): asserts value is PlaytestJsonRpcRequest {
  if (!isPlainObject(value)) {
    throw new TypeError(
      "JSON-RPC request must be a plain object; batch arrays are unsupported."
    );
  }
  if (!hasOnlyKeys(value, ["jsonrpc", "id", "method", "params"])) {
    throw new TypeError(
      "JSON-RPC request contains an unsupported envelope field."
    );
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC request must carry jsonrpc === "2.0".');
  }
  if (!isRequestId(value.id)) {
    throw new TypeError(
      "JSON-RPC request id must be a bounded non-empty string."
    );
  }
  if (!isPlaytestAdapterMethod(value.method)) {
    throw new TypeError(
      `JSON-RPC method must be one of ${PLAYTESTS_ADAPTER_METHODS.join(", ")}; received ${String(value.method)}.`
    );
  }
  if (!isPlainObject(value.params)) {
    throw new TypeError("JSON-RPC params must be a plain object.");
  }
}

/** Validate a JSON-RPC notification with no id and no response. */
export function assertPlaytestJsonRpcNotification(
  value: unknown
): asserts value is PlaytestJsonRpcNotification {
  if (!isPlainObject(value)) {
    throw new TypeError("JSON-RPC notification must be a plain object.");
  }
  if (!hasOnlyKeys(value, ["jsonrpc", "method", "params"])) {
    throw new TypeError(
      "JSON-RPC notification must not carry an id or unknown field."
    );
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC notification must carry jsonrpc === "2.0".');
  }
  if (
    typeof value.method !== "string" ||
    !(PLAYTESTS_ADAPTER_NOTIFICATIONS as readonly string[]).includes(
      value.method
    )
  ) {
    throw new TypeError(
      "JSON-RPC notification method must be game.event or game.progress."
    );
  }
  if (!isPlainObject(value.params)) {
    throw new TypeError("JSON-RPC notification params must be a plain object.");
  }
}

/** Validate a JSON-RPC v1 success response envelope. */
export function assertPlaytestJsonRpcSuccess(
  value: unknown
): asserts value is PlaytestJsonRpcSuccess {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["jsonrpc", "id", "result"])
  ) {
    throw new TypeError(
      "JSON-RPC success must contain only jsonrpc, id, and result."
    );
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC success must carry jsonrpc === "2.0".');
  }
  if (!isRequestId(value.id)) {
    throw new TypeError(
      "JSON-RPC success id must be a bounded non-empty string."
    );
  }
  if (!("result" in value)) {
    throw new TypeError("JSON-RPC success must include a `result` field.");
  }
}

/** Validate a JSON-RPC v1 error response envelope and application disposition. */
export function assertPlaytestJsonRpcError(
  value: unknown
): asserts value is PlaytestJsonRpcError {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["jsonrpc", "id", "error"])
  ) {
    throw new TypeError(
      "JSON-RPC error must contain only jsonrpc, id, and error."
    );
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC error must carry jsonrpc === "2.0".');
  }
  if (value.id !== null && !isRequestId(value.id)) {
    throw new TypeError("JSON-RPC error id must be a bounded string or null.");
  }
  const error = value.error;
  if (
    !isPlainObject(error) ||
    !hasOnlyKeys(error, ["code", "message", "data"])
  ) {
    throw new TypeError(
      "JSON-RPC error envelope must contain code, message, and optional data."
    );
  }
  if (
    typeof error.code !== "number" ||
    !Number.isInteger(error.code) ||
    !(PLAYTESTS_ADAPTER_ERROR_CODES as readonly number[]).includes(error.code)
  ) {
    throw new TypeError(
      `JSON-RPC error code must be one of ${PLAYTESTS_ADAPTER_ERROR_CODES.join(", ")}.`
    );
  }
  if (!isNonEmptyString(error.message)) {
    throw new TypeError("JSON-RPC error message must be a non-empty string.");
  }
  if (isApplicationErrorCode(error.code)) {
    if (value.id === null) {
      throw new TypeError(
        "Game-adapter application errors must retain their request id."
      );
    }
    const data = error.data;
    if (
      !isPlainObject(data) ||
      !hasOnlyKeys(data, ["category", "retryable", "episodeDisposition"])
    ) {
      throw new TypeError(
        "Application error data must declare category, retryable, and episodeDisposition."
      );
    }
    if (
      !isNonEmptyString(data.category) ||
      typeof data.retryable !== "boolean"
    ) {
      throw new TypeError(
        "Application error category and retryable fields are invalid."
      );
    }
    if (
      data.episodeDisposition !== "unchanged" &&
      data.episodeDisposition !== "aborted" &&
      data.episodeDisposition !== "unknown"
    ) {
      throw new TypeError("Application error episodeDisposition is invalid.");
    }
  }
}

/** Validate exactly one JSON-RPC v1 result or error response. */
export function assertPlaytestJsonRpcResponse(
  value: unknown
): asserts value is PlaytestJsonRpcResponse {
  if (!isPlainObject(value)) {
    throw new TypeError("JSON-RPC response must be a plain object.");
  }
  if ("result" in value && "error" in value) {
    throw new TypeError(
      "JSON-RPC response must not contain both result and error."
    );
  }
  if ("error" in value) {
    assertPlaytestJsonRpcError(value);
    return;
  }
  assertPlaytestJsonRpcSuccess(value);
}

function assertUniqueStringArray(
  value: unknown,
  field: string,
  predicate: (entry: unknown) => boolean
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(predicate)) {
    throw new TypeError(
      `Capability advertisement ${field} must be a non-empty valid array.`
    );
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(
      `Capability advertisement ${field} must not contain duplicates.`
    );
  }
}

function assertSchemaHash(value: unknown, field: string): void {
  if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) {
    throw new TypeError(
      `Capability advertisement ${field} must be a SHA-256 hex digest.`
    );
  }
}

/** Validate the complete, exact v1 capability negotiation payload. */
export function assertPlaytestCapabilityAdvertisement(
  value: unknown
): asserts value is PlaytestCapabilityAdvertisement {
  const allowedKeys = [
    "protocolVersion",
    "schemaHashAlgorithm",
    "engineBuild",
    "modes",
    "scenarioIds",
    "observationSchema",
    "actionSchema",
    "eventSchema",
    "observationSchemaHash",
    "actionSchemaHash",
    "eventSchemaHash",
    "optionalOperations",
    "quotas",
    "deterministic"
  ];
  if (!isPlainObject(value) || !hasOnlyKeys(value, allowedKeys)) {
    throw new TypeError(
      "Capability advertisement must match the complete v1 schema."
    );
  }
  if (value.protocolVersion !== PLAYTESTS_PROTOCOL_VERSION) {
    throw new TypeError(
      "Capability advertisement protocolVersion must be exactly 1."
    );
  }
  if (!isNonEmptyString(value.engineBuild)) {
    throw new TypeError(
      "Capability advertisement engineBuild must be non-empty."
    );
  }
  assertUniqueStringArray(value.modes, "modes", isPlaytestGameMode);
  assertUniqueStringArray(value.scenarioIds, "scenarioIds", isNonEmptyString);
  for (const schemaField of [
    "observationSchema",
    "actionSchema",
    "eventSchema"
  ] as const) {
    if (!isPlainObject(value[schemaField])) {
      throw new TypeError(
        `Capability advertisement ${schemaField} must be a JSON Schema object.`
      );
    }
  }
  assertSchemaHash(value.observationSchemaHash, "observationSchemaHash");
  assertSchemaHash(value.actionSchemaHash, "actionSchemaHash");
  assertSchemaHash(value.eventSchemaHash, "eventSchemaHash");
  if (!Array.isArray(value.optionalOperations)) {
    throw new TypeError(
      "Capability advertisement optionalOperations must be an array."
    );
  }
  if (!value.optionalOperations.every(isOptionalAdapterMethod)) {
    throw new TypeError(
      "Capability advertisement lists an unknown optional operation."
    );
  }
  if (
    new Set(value.optionalOperations).size !== value.optionalOperations.length
  ) {
    throw new TypeError(
      "Capability advertisement optionalOperations must not contain duplicates."
    );
  }
  if (
    !isPlainObject(value.quotas) ||
    !hasOnlyKeys(value.quotas, [
      "maxMessageBytes",
      "maxQueuedRequests",
      "ordinaryCallTimeoutMs",
      "resetReplayTimeoutMs"
    ])
  ) {
    throw new TypeError(
      "Capability advertisement quotas must match the v1 quota schema."
    );
  }
  const quotaBounds = {
    maxMessageBytes: PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.maxMessageBytes,
    maxQueuedRequests: PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.maxQueuedRequests,
    ordinaryCallTimeoutMs:
      PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.ordinaryCallTimeoutMs,
    resetReplayTimeoutMs: PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.resetReplayTimeoutMs
  } as const;
  for (const [key, maximum] of Object.entries(quotaBounds)) {
    const quota = value.quotas[key];
    if (!isNonNegativeInteger(quota) || quota < 1 || quota > maximum) {
      throw new TypeError(
        `Capability advertisement quota ${key} must be between 1 and ${String(maximum)}.`
      );
    }
  }
  if (
    !isPlainObject(value.deterministic) ||
    !hasOnlyKeys(value.deterministic, [
      "seededRuns",
      "rngVersion",
      "traceReplayable"
    ])
  ) {
    throw new TypeError(
      "Capability advertisement deterministic guarantees are invalid."
    );
  }
  if (
    typeof value.deterministic.seededRuns !== "boolean" ||
    typeof value.deterministic.traceReplayable !== "boolean" ||
    (value.deterministic.rngVersion !== null &&
      !isNonEmptyString(value.deterministic.rngVersion))
  ) {
    throw new TypeError(
      "Capability advertisement deterministic guarantee values are invalid."
    );
  }
  if (
    value.deterministic.seededRuns &&
    value.deterministic.rngVersion === null
  ) {
    throw new TypeError("Seeded deterministic runs must name the RNG version.");
  }
}

/**
 * Validate a structured evidence locator.
 *
 * Locators are the only way a review, finding or comparison can refer to
 * evidence. The validator rejects any locator whose `kind` is outside the
 * closed vocabulary, whose `id` is empty, or whose numeric sub-fields are
 * not finite integers; this is the first line of defence against
 * nonexistent/irrelevant locators becoming "verified".
 */
export function assertPlaytestEvidenceLocator(
  value: unknown
): asserts value is PlaytestEvidenceLocator {
  if (!isPlainObject(value)) {
    throw new TypeError("Evidence locator must be a plain object.");
  }
  if (!isPlaytestLocatorKind(value.kind)) {
    throw new TypeError(
      `Evidence locator kind must be one of ${PLAYTESTS_LOCATOR_KINDS.join(", ")}; received ${String(value.kind)}.`
    );
  }
  if (!isNonEmptyString(value.id)) {
    throw new TypeError("Evidence locator id must be a non-empty string.");
  }
  if (value.step !== undefined && !isNonNegativeInteger(value.step)) {
    throw new TypeError(
      "Evidence locator step must be a non-negative integer."
    );
  }
  if (value.revision !== undefined && !isNonNegativeInteger(value.revision)) {
    throw new TypeError(
      "Evidence locator revision must be a non-negative integer."
    );
  }
  if (
    value.frameIndex !== undefined &&
    !isNonNegativeInteger(value.frameIndex)
  ) {
    throw new TypeError(
      "Evidence locator frameIndex must be a non-negative integer."
    );
  }
  if (value.phaseId !== undefined && !isNonEmptyString(value.phaseId)) {
    throw new TypeError(
      "Evidence locator phaseId must be a non-empty string when present."
    );
  }
}

/** Stable schema version for diagnostic output. */

/**
 * Normalise a candidate native miniPXI Likert value. Returns the value when
 * it is an integer in the closed `[-3, 3]` range, otherwise returns `null`
 * and a stable reason so the caller can record missingness honestly.
 */
export function normaliseMiniPxiEnjValue(value: unknown): {
  value: number | null;
  missingReason: "missing-ENJ" | "wrong-instrument" | null;
} {
  if (value === null || value === undefined) {
    return { value: null, missingReason: "missing-ENJ" };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { value: null, missingReason: "wrong-instrument" };
  }
  if (value < PLAYTESTS_MINIPXI_ENJ_MIN || value > PLAYTESTS_MINIPXI_ENJ_MAX) {
    return { value: null, missingReason: "wrong-instrument" };
  }
  return { value, missingReason: null };
}

export { PLAYTESTS_SCHEMA_VERSION as PLAYTESTS_CURRENT_PROTOCOL_VERSION } from "./types.ts";
