import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  GithubWorkflowDefinition,
  GithubWorkflowMutationOperation,
  GithubWorkflowMutationRequest,
  GithubWorkflowState
} from "@simulatorlife/autodev-core";

import {
  type ControlApiConfig,
  mutateGithubWorkflow,
  readControlApiConfig
} from "./control-api.ts";

const FORM_TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_FORM_BODY_BYTES = 8_192;
const FORM_WORKFLOW_POLICY = {
  "_scheduler.yml": { enableDisable: true, dispatch: true },
  "metrics-dashboard.yml": { enableDisable: true, dispatch: false },
  "target-automerge.yml": { enableDisable: true, dispatch: false },
  "target-pr-janitor.yml": { enableDisable: true, dispatch: false }
} as const;
const KNOWN_STATES = new Set<GithubWorkflowState>([
  "active",
  "disabled_manually",
  "disabled_inactivity"
]);

export interface GithubMutationForm {
  readonly operation: GithubWorkflowMutationOperation;
  readonly workflow: string;
  readonly idempotencyKey: string;
  readonly formToken: string;
  readonly expectedState?: GithubWorkflowState;
}

export type GithubMutationForms = Readonly<
  Partial<
    Record<
      keyof typeof FORM_WORKFLOW_POLICY,
      { readonly dispatch?: GithubMutationForm; readonly toggle?: GithubMutationForm }
    >
  >
>;

interface FormTokenClaims extends GithubMutationForm {
  readonly issuedAt: number;
}

export function createGithubMutationFormToken(
  binding: Omit<GithubMutationForm, "formToken">,
  hmacSecret: string,
  now: number = Date.now()
): string {
  if (!isFormOperationAllowed(binding.operation, binding.workflow)) {
    throw new TypeError("Unsupported GitHub workflow form operation.");
  }
  const claims: Omit<FormTokenClaims, "formToken"> = {
    ...binding,
    issuedAt: now
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", hmacSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function isFormOperationAllowed(
  operation: string,
  workflow: string
): boolean {
  if (!Object.hasOwn(FORM_WORKFLOW_POLICY, workflow)) return false;
  const policy = FORM_WORKFLOW_POLICY[
    workflow as keyof typeof FORM_WORKFLOW_POLICY
  ];
  return operation === "dispatch"
    ? policy.dispatch
    : operation === "enable" || operation === "disable"
      ? policy.enableDisable
      : false;
}

function verifyGithubMutationFormToken(
  token: string,
  binding: Omit<GithubMutationForm, "formToken">,
  hmacSecret: string,
  now: number
): boolean {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  const expectedSignature = createHmac("sha256", hmacSecret)
    .update(payload)
    .digest();
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return false;
  }
  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!rawClaims || typeof rawClaims !== "object" || Array.isArray(rawClaims)) {
    return false;
  }
  const claims = rawClaims as Partial<FormTokenClaims>;
  if (
    !Number.isSafeInteger(claims.issuedAt) ||
    (claims.issuedAt as number) > now + 30_000 ||
    now - (claims.issuedAt as number) > FORM_TOKEN_TTL_MS
  ) {
    return false;
  }
  return (
    claims.operation === binding.operation &&
    claims.workflow === binding.workflow &&
    claims.idempotencyKey === binding.idempotencyKey &&
    claims.expectedState === binding.expectedState
  );
}

function createForm(
  operation: GithubWorkflowMutationOperation,
  workflow: string,
  secret: string,
  expectedState?: GithubWorkflowState,
  now: number = Date.now()
): GithubMutationForm {
  const binding = {
    operation,
    workflow,
    idempotencyKey: randomUUID(),
    ...(expectedState ? { expectedState } : {})
  };
  return {
    ...binding,
    formToken: createGithubMutationFormToken(binding, secret, now)
  };
}

export function createGithubMutationForms(
  workflows: readonly GithubWorkflowDefinition[],
  hmacSecret: string,
  now: number = Date.now()
): GithubMutationForms {
  const forms: Partial<
    Record<
      keyof typeof FORM_WORKFLOW_POLICY,
      { dispatch?: GithubMutationForm; toggle?: GithubMutationForm }
    >
  > = {};
  for (const workflow of workflows) {
    if (!Object.hasOwn(FORM_WORKFLOW_POLICY, workflow.id)) continue;
    const policy = FORM_WORKFLOW_POLICY[
      workflow.id as keyof typeof FORM_WORKFLOW_POLICY
    ];
    const row: { dispatch?: GithubMutationForm; toggle?: GithubMutationForm } = {};
    if (
      workflow.id === "_scheduler.yml" &&
      policy.dispatch &&
      workflow.events.includes("workflow_dispatch") &&
      workflow.actionsState === "active"
    ) {
      row.dispatch = createForm("dispatch", workflow.id, hmacSecret, undefined, now);
    }
    if (policy.enableDisable && workflow.actionsState === "active") {
      row.toggle = createForm("disable", workflow.id, hmacSecret, "active", now);
    } else if (
      policy.enableDisable &&
      (workflow.actionsState === "disabled_manually" ||
        workflow.actionsState === "disabled_inactivity")
    ) {
      row.toggle = createForm(
        "enable",
        workflow.id,
        hmacSecret,
        workflow.actionsState,
        now
      );
    }
    if (row.dispatch || row.toggle) {
      forms[workflow.id as keyof typeof FORM_WORKFLOW_POLICY] = row;
    }
  }
  return forms;
}

async function readBoundedFormBody(request: Request): Promise<string | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FORM_BODY_BYTES) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_FORM_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ error: { status, code } }, { status });
}

function mutationRedirect(request: Request, state: "applied" | "failed"): Response {
  const destination = new URL("/github", request.url);
  destination.searchParams.set("githubMutation", state);
  return Response.redirect(destination, 303);
}

export interface GithubMutationFormDependencies {
  readonly config?: ControlApiConfig | null;
  readonly now?: () => number;
  readonly submit?: (
    request: GithubWorkflowMutationRequest,
    config: ControlApiConfig
  ) => Promise<{ readonly kind: string }>;
}

export async function handleGithubMutationForm(
  request: Request,
  dependencies: GithubMutationFormDependencies = {}
): Promise<Response> {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== new URL(request.url).origin || fetchSite !== "same-origin") {
    return errorResponse(403, "github_mutation_cross_origin");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(contentType)) {
    return errorResponse(415, "github_mutation_form_required");
  }
  const body = await readBoundedFormBody(request);
  if (body === null) return errorResponse(413, "github_mutation_form_too_large");
  const fields = new URLSearchParams(body);
  const expectedNames = new Set([
    "operation",
    "workflow",
    "idempotencyKey",
    "formToken",
    "expectedState",
    "confirm"
  ]);
  if (
    Array.from(fields.keys()).some((name) => !expectedNames.has(name)) ||
    Array.from(expectedNames).some((name) => fields.getAll(name).length > 1)
  ) {
    return errorResponse(400, "github_mutation_form_invalid");
  }
  const operation = fields.get("operation");
  const workflow = fields.get("workflow");
  const idempotencyKey = fields.get("idempotencyKey");
  const formToken = fields.get("formToken");
  const confirm = fields.get("confirm");
  const rawState = fields.get("expectedState");
  if (
    !operation ||
    !workflow ||
    !idempotencyKey ||
    !formToken ||
    confirm !== "yes" ||
    !isFormOperationAllowed(operation, workflow)
  ) {
    return errorResponse(400, "github_mutation_confirmation_required");
  }
  const mutatingState = operation === "enable" || operation === "disable";
  if (
    (mutatingState && (!rawState || !KNOWN_STATES.has(rawState as GithubWorkflowState))) ||
    (!mutatingState && rawState !== null)
  ) {
    return errorResponse(400, "github_mutation_form_invalid");
  }
  const typedRequest: GithubWorkflowMutationRequest = {
    operation: operation as GithubWorkflowMutationOperation,
    workflow,
    idempotencyKey,
    ...(mutatingState
      ? { expectedState: rawState as GithubWorkflowState }
      : {})
  };
  const config = dependencies.config ?? readControlApiConfig();
  if (!config) return mutationRedirect(request, "failed");
  if (
    !verifyGithubMutationFormToken(
      formToken,
      typedRequest,
      config.serviceToken,
      (dependencies.now ?? Date.now)()
    )
  ) {
    return errorResponse(403, "github_mutation_form_token_invalid");
  }
  const result = await (dependencies.submit ?? mutateGithubWorkflow)(
    typedRequest,
    config
  );
  return mutationRedirect(request, result.kind === "ok" ? "applied" : "failed");
}
