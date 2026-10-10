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
  type PlaytestAdapterCapability,
  type PlaytestAdapterErrorCode,
  type PlaytestAdapterMethod,
  type PlaytestCapabilityAdvertisement,
  type PlaytestEvidenceLocator,
  type PlaytestJsonRpcError,
  type PlaytestJsonRpcRequest,
  type PlaytestJsonRpcResponse,
  type PlaytestJsonRpcSuccess,
  type PlaytestLocatorKind,
  type PlaytestMiniPxiItem,
  type PlaytestObservationDescriptor,
  PLAYTESTS_ADAPTER_CAPABILITIES,
  PLAYTESTS_ADAPTER_ERROR_CODES,
  PLAYTESTS_ADAPTER_METHODS,
  PLAYTESTS_LOCATOR_KINDS,
  PLAYTESTS_MINIPXI_ENJ_MAX,
  PLAYTESTS_MINIPXI_ENJ_MIN,
  PLAYTESTS_MINIPXI_ITEMS,
  PLAYTESTS_PROTOCOL
} from "./types.ts";

/** Is `value` one of the documented JSON-RPC error codes? */
export function isPlaytestAdapterErrorCode(
  value: unknown
): value is PlaytestAdapterErrorCode {
  return (
    typeof value === "string" &&
    (PLAYTESTS_ADAPTER_ERROR_CODES as readonly string[]).includes(value)
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

/** Is `value` one of the documented adapter capabilities? */
export function isPlaytestAdapterCapability(
  value: unknown
): value is PlaytestAdapterCapability {
  return (
    typeof value === "string" &&
    (PLAYTESTS_ADAPTER_CAPABILITIES as readonly string[]).includes(value)
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

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** A request id must be either a non-negative integer or a non-empty string. */
function isRequestId(value: unknown): value is number | string {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value);
  }
  return false;
}

/** Validate a JSON-RPC v1 request envelope. */
export function assertPlaytestJsonRpcRequest(
  value: unknown
): asserts value is PlaytestJsonRpcRequest {
  if (!isPlainObject(value)) {
    throw new TypeError("JSON-RPC request must be a plain object.");
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC request must carry jsonrpc === "2.0".');
  }
  if (!isRequestId(value.id)) {
    throw new TypeError(
      "JSON-RPC request id must be a non-empty string or integer."
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

/** Validate a JSON-RPC v1 success response envelope. */
export function assertPlaytestJsonRpcSuccess(
  value: unknown
): asserts value is PlaytestJsonRpcSuccess {
  if (!isPlainObject(value)) {
    throw new TypeError("JSON-RPC success must be a plain object.");
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC success must carry jsonrpc === "2.0".');
  }
  if (!isRequestId(value.id)) {
    throw new TypeError(
      "JSON-RPC success id must be a non-empty string or integer."
    );
  }
  // The result is intentionally untyped: protocol validators do not know
  // which method it belongs to. Method-level validators handle that.
  if (!("result" in value)) {
    throw new TypeError("JSON-RPC success must include a `result` field.");
  }
}

/** Validate a JSON-RPC v1 error response envelope. */
export function assertPlaytestJsonRpcError(
  value: unknown
): asserts value is PlaytestJsonRpcError {
  if (!isPlainObject(value)) {
    throw new TypeError("JSON-RPC error must be a plain object.");
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC error must carry jsonrpc === "2.0".');
  }
  // Per JSON-RPC 2.0, an id may be null in an error envelope when the request
  // could not be parsed. Anything else is invalid.
  if (value.id !== null && !isRequestId(value.id)) {
    throw new TypeError(
      "JSON-RPC error id must be a non-empty string, integer, or null."
    );
  }
  const error = value.error;
  if (!isPlainObject(error)) {
    throw new TypeError(
      "JSON-RPC error envelope must include an `error` object."
    );
  }
  if (
    typeof error.code !== "number" &&
    !isPlaytestAdapterErrorCode(error.code)
  ) {
    throw new TypeError(
      `JSON-RPC error code must be a number or one of ${PLAYTESTS_ADAPTER_ERROR_CODES.join(", ")}.`
    );
  }
  if (!isNonEmptyString(error.message)) {
    throw new TypeError("JSON-RPC error message must be a non-empty string.");
  }
  // `data` is allowed but optional; no shape contract.
}

/** Validate any JSON-RPC v1 response envelope. */
export function assertPlaytestJsonRpcResponse(
  value: unknown
): asserts value is PlaytestJsonRpcResponse {
  if (!isPlainObject(value)) {
    throw new TypeError("JSON-RPC response must be a plain object.");
  }
  if (value.jsonrpc !== "2.0") {
    throw new TypeError('JSON-RPC response must carry jsonrpc === "2.0".');
  }
  if ("error" in value) {
    assertPlaytestJsonRpcError(value);
    return;
  }
  assertPlaytestJsonRpcSuccess(value);
}

/** Validate a capability advertisement returned by an adapter. */
export function assertPlaytestCapabilityAdvertisement(
  value: unknown
): asserts value is PlaytestCapabilityAdvertisement {
  if (!isPlainObject(value)) {
    throw new TypeError("Capability advertisement must be a plain object.");
  }
  if (value.protocol !== PLAYTESTS_PROTOCOL) {
    throw new TypeError(
      `Capability advertisement protocol must be "${PLAYTESTS_PROTOCOL}"; received ${String(value.protocol)}.`
    );
  }
  if (!Array.isArray(value.capabilities)) {
    throw new TypeError(
      "Capability advertisement must list `capabilities` as an array."
    );
  }
  for (const cap of value.capabilities) {
    if (!isPlaytestAdapterCapability(cap)) {
      throw new TypeError(
        `Capability advertisement contains unknown capability ${String(cap)}.`
      );
    }
  }
  if (!Array.isArray(value.supportedMethods)) {
    throw new TypeError(
      "Capability advertisement must list `supportedMethods` as an array."
    );
  }
  for (const method of value.supportedMethods) {
    if (!isPlaytestAdapterMethod(method)) {
      throw new TypeError(
        `Capability advertisement contains unknown method ${String(method)}.`
      );
    }
  }
  if (!isNonEmptyString(value.eventSchemaHash)) {
    throw new TypeError(
      "Capability advertisement must include a non-empty `eventSchemaHash`."
    );
  }
  if (!isNonEmptyString(value.observationSchemaHash)) {
    throw new TypeError(
      "Capability advertisement must include a non-empty `observationSchemaHash`."
    );
  }
  if (value.maxStep !== null && !isNonNegativeInteger(value.maxStep)) {
    throw new TypeError(
      "Capability advertisement `maxStep` must be a non-negative integer or null."
    );
  }
}

/** Validate an observation descriptor returned by an adapter. */
export function assertPlaytestObservationDescriptor(
  value: unknown
): asserts value is PlaytestObservationDescriptor {
  if (!isPlainObject(value)) {
    throw new TypeError("Observation descriptor must be a plain object.");
  }
  if (!isNonEmptyString(value.schemaHash)) {
    throw new TypeError(
      "Observation descriptor must include a non-empty `schemaHash`."
    );
  }
  if (!isStringArray(value.fields)) {
    throw new TypeError(
      "Observation descriptor `fields` must be an array of strings."
    );
  }
  if (
    value.visibilityMode !== "structured" &&
    value.visibilityMode !== "visual-only"
  ) {
    throw new TypeError(
      "Observation descriptor `visibilityMode` must be 'structured' or 'visual-only'."
    );
  }
  if (typeof value.supportsReplay !== "boolean") {
    throw new TypeError(
      "Observation descriptor `supportsReplay` must be a boolean."
    );
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
