import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  EVALUATION_LIMITS,
  type EvaluationDefinition,
  isEvaluationDefinitionId
} from "@simulatorlife/autodev-core";

import {
  type ControlApiConfig,
  type ControlApiResult,
  deleteEvaluationDefinition,
  putEvaluationDefinition,
  readControlApiConfig,
  startEvaluationRun
} from "./control-api.ts";
import {
  isSameOriginRequest,
  readBoundedRequestText,
  seeOther
} from "./request-guards.ts";

/** Operator edits can take a while; tokens stay short-lived but usable. */
const FORM_TOKEN_TTL_MS = 30 * 60 * 1000;
const FORM_TOKEN_CLOCK_SKEW_MS = 30_000;
const MAX_FORM_BODY_BYTES = 8192;
/** JSON envelope around a definition serialized within its byte bound. */
const MAX_SAVE_BODY_BYTES = EVALUATION_LIMITS.maxDefinitionBytes * 2 + 4096;
const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded(?:\s*;|$)/iu;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu;
const REVISION_PATTERN = /^[0-9a-f]{16}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

export type EvaluationFormAction = "save" | "run" | "delete";

/** Server-issued binding for one evaluation action form. */
export interface EvaluationFormBinding {
  readonly action: EvaluationFormAction;
  /** Empty when the form creates a new definition. */
  readonly definitionId: string;
  /** Empty when the action is not revision-checked or creates. */
  readonly expectedRevision: string;
  /** Empty unless the action starts a run. */
  readonly idempotencyKey: string;
}

export interface EvaluationForm extends EvaluationFormBinding {
  readonly formToken: string;
}

/** Fixed notices the Console renders after an action redirect. */
export const EVALUATION_NOTICES = {
  "run-accepted": "Run accepted; results appear as each case is judged.",
  "run-failed": "The run could not be started.",
  "delete-failed": "The definition could not be deleted.",
  deleted: "Definition deleted.",
  saved: "Definition saved."
} as const;
export type EvaluationNotice = keyof typeof EVALUATION_NOTICES;

export function isEvaluationNotice(value: unknown): value is EvaluationNotice {
  return typeof value === "string" && Object.hasOwn(EVALUATION_NOTICES, value);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createEvaluationForm(
  binding: Omit<EvaluationFormBinding, "idempotencyKey"> & {
    readonly idempotencyKey?: string;
  },
  secret: string,
  now: number = Date.now()
): EvaluationForm {
  const complete: EvaluationFormBinding = {
    action: binding.action,
    definitionId: binding.definitionId,
    expectedRevision: binding.expectedRevision,
    idempotencyKey:
      binding.idempotencyKey ?? (binding.action === "run" ? randomUUID() : "")
  };
  const payload = Buffer.from(
    JSON.stringify({ ...complete, issuedAt: now })
  ).toString("base64url");
  return { ...complete, formToken: `${payload}.${sign(payload, secret)}` };
}

export function verifyEvaluationFormToken(
  token: string,
  binding: EvaluationFormBinding,
  secret: string,
  now: number
): boolean {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  const expected = Buffer.from(sign(payload, secret), "base64url");
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return false;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims))
    return false;
  const record = claims as Record<string, unknown>;
  const issuedAt = record.issuedAt;
  return (
    typeof issuedAt === "number" &&
    Number.isSafeInteger(issuedAt) &&
    issuedAt <= now + FORM_TOKEN_CLOCK_SKEW_MS &&
    now - issuedAt <= FORM_TOKEN_TTL_MS &&
    record.action === binding.action &&
    record.definitionId === binding.definitionId &&
    record.expectedRevision === binding.expectedRevision &&
    record.idempotencyKey === binding.idempotencyKey
  );
}

export interface EvaluationActionDependencies {
  readonly config?: ControlApiConfig | null;
  readonly now?: () => number;
  readonly put?: typeof putEvaluationDefinition;
  readonly remove?: typeof deleteEvaluationDefinition;
  readonly run?: typeof startEvaluationRun;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false, code, message },
    { status, headers: { "cache-control": "no-store" } }
  );
}

function failure(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} {
  return result.kind === "unreachable"
    ? { status: 502, code: "autodev_unreachable", message: result.message }
    : { status: result.status, code: result.code, message: result.message };
}

/**
 * Save a definition from the client editor. The definition travels as JSON
 * text so the server reports parse errors instead of the browser.
 */
async function handleSave(
  request: Request,
  dependencies: EvaluationActionDependencies,
  config: ControlApiConfig
): Promise<Response> {
  const text = await readBoundedRequestText(request, MAX_SAVE_BODY_BYTES);
  if (text === null)
    return jsonError(
      413,
      "evaluation_action_too_large",
      "Definition is too large."
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonError(
      400,
      "evaluation_action_invalid",
      "Request body must be JSON."
    );
  }
  const keys = [
    "action",
    "definitionId",
    "expectedRevision",
    "formToken",
    "definition"
  ];
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(body, key))
  ) {
    return jsonError(
      400,
      "evaluation_action_invalid",
      "Unexpected save payload."
    );
  }
  const fields = body as Record<string, unknown>;
  const { definitionId, expectedRevision, formToken, definition } = fields;
  if (
    fields.action !== "save" ||
    typeof definitionId !== "string" ||
    typeof expectedRevision !== "string" ||
    typeof formToken !== "string" ||
    typeof definition !== "string" ||
    (definitionId !== "" && !isEvaluationDefinitionId(definitionId)) ||
    (expectedRevision !== "" && !REVISION_PATTERN.test(expectedRevision)) ||
    (definitionId === "") !== (expectedRevision === "")
  ) {
    return jsonError(
      400,
      "evaluation_action_invalid",
      "Unexpected save payload."
    );
  }
  if (
    !verifyEvaluationFormToken(
      formToken,
      { action: "save", definitionId, expectedRevision, idempotencyKey: "" },
      config.serviceToken,
      (dependencies.now ?? Date.now)()
    )
  ) {
    return jsonError(
      403,
      "evaluation_action_token_invalid",
      "The editor session expired. Reload the page and re-apply your changes."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return jsonError(
      400,
      "autodev_control_api_invalid_evaluation",
      "Definition is not valid JSON."
    );
  }
  const targetId =
    definitionId ||
    (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { id?: unknown }).id
      : undefined);
  if (!isEvaluationDefinitionId(targetId)) {
    return jsonError(
      400,
      "autodev_control_api_invalid_evaluation",
      "Definition id must be a lowercase slug that is not a reserved route name."
    );
  }
  const result = await (dependencies.put ?? putEvaluationDefinition)(
    targetId,
    {
      // The Control API owns structural and reference validation.
      definition: parsed as EvaluationDefinition,
      expectedRevision: expectedRevision || null
    },
    config
  );
  if (result.kind !== "ok") {
    const { status, code, message } = failure(result);
    return jsonError(status, code, message);
  }
  return Response.json(
    {
      ok: true,
      definitionId: result.data.definitionId,
      revision: result.data.revision
    },
    { headers: { "cache-control": "no-store" } }
  );
}

/** Run and delete are plain HTML forms that redirect back with a notice. */
async function handleForm(
  request: Request,
  dependencies: EvaluationActionDependencies,
  config: ControlApiConfig
): Promise<Response> {
  const text = await readBoundedRequestText(request, MAX_FORM_BODY_BYTES);
  if (text === null)
    return jsonError(413, "evaluation_action_too_large", "Form is too large.");
  const fields = new URLSearchParams(text);
  const allowed = new Set([
    "action",
    "definitionId",
    "expectedRevision",
    "idempotencyKey",
    "formToken",
    "confirm"
  ]);
  if (
    [...fields.keys()].some(
      (name) => !allowed.has(name) || fields.getAll(name).length > 1
    )
  ) {
    return jsonError(
      400,
      "evaluation_action_invalid",
      "Unexpected form fields."
    );
  }
  const action = fields.get("action");
  const definitionId = fields.get("definitionId") ?? "";
  const expectedRevision = fields.get("expectedRevision") ?? "";
  const idempotencyKey = fields.get("idempotencyKey") ?? "";
  const formToken = fields.get("formToken") ?? "";
  if (
    (action !== "run" && action !== "delete") ||
    !isEvaluationDefinitionId(definitionId) ||
    (action === "run" &&
      (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) || expectedRevision)) ||
    (action === "delete" &&
      (!REVISION_PATTERN.test(expectedRevision) ||
        idempotencyKey ||
        fields.get("confirm") !== "yes"))
  ) {
    return jsonError(
      400,
      "evaluation_action_confirmation_required",
      "The form is incomplete or was not confirmed."
    );
  }
  if (
    !verifyEvaluationFormToken(
      formToken,
      { action, definitionId, expectedRevision, idempotencyKey },
      config.serviceToken,
      (dependencies.now ?? Date.now)()
    )
  ) {
    return jsonError(
      403,
      "evaluation_action_token_invalid",
      "The form expired. Reload the page and try again."
    );
  }
  const detail = `/evaluations/${encodeURIComponent(definitionId)}`;
  if (action === "run") {
    const result = await (dependencies.run ?? startEvaluationRun)(
      definitionId,
      { idempotencyKey },
      config
    );
    if (result.kind !== "ok") {
      return seeOther(
        `${detail}?${new URLSearchParams({ notice: "run-failed", code: failure(result).code }).toString()}`
      );
    }
    return seeOther(
      `${detail}?${new URLSearchParams({ notice: "run-accepted", run: result.data.run.runId }).toString()}`
    );
  }
  const result = await (dependencies.remove ?? deleteEvaluationDefinition)(
    definitionId,
    { expectedRevision },
    config
  );
  if (result.kind !== "ok") {
    return seeOther(
      `${detail}?${new URLSearchParams({ notice: "delete-failed", code: failure(result).code }).toString()}`
    );
  }
  return seeOther("/evaluations?notice=deleted");
}

/**
 * Same-origin entry point for every evaluation action. It never forwards
 * browser headers; the Control API credential and actor are server-side.
 */
export function handleEvaluationAction(
  request: Request,
  dependencies: EvaluationActionDependencies = {}
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Promise.resolve(
      jsonError(
        403,
        "evaluation_action_cross_origin",
        "Evaluation actions must come from the AutoDev Console."
      )
    );
  }
  const config =
    dependencies.config === undefined
      ? readControlApiConfig()
      : dependencies.config;
  if (!config) {
    return Promise.resolve(
      jsonError(
        503,
        "autodev_control_api_disabled",
        "The Console has no Control API credential."
      )
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (JSON_CONTENT_TYPE.test(contentType))
    return handleSave(request, dependencies, config);
  if (FORM_CONTENT_TYPE.test(contentType))
    return handleForm(request, dependencies, config);
  return Promise.resolve(
    jsonError(
      415,
      "evaluation_action_content_type",
      "Unsupported evaluation action content type."
    )
  );
}
