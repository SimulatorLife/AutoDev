import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  assertWorkspacePlaytestApproval,
  type ControlApiWorkspacePlaytestApprovalResponse,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import { ConfigRepository } from "@simulatorlife/autodev-data";
import {
  WorkspacePlaytestApprovalConflictError,
  WorkspacePlaytestApprovalRepository,
  WorkspacePlaytestApprovalStoreError
} from "@simulatorlife/autodev-data/workspaces";

import { errorBody, sendJson } from "../router/proxy.ts";
import { readControlApiJsonObject } from "./body.ts";

const APPROVAL_ROUTE_PATTERN =
  /^\/control\/workspaces\/([^/]+)\/playtesting-approval(?:\/(revoke))?$/u;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const FILTER_VALUE_MAX_CHARS = 256;
const APPROVAL_BODY_KEYS = [
  "expectedRevision",
  "checkoutRoot",
  "buildSha",
  "gameBuild",
  "playtestConfigHash",
  "adapterImageDigest",
  "workingDirectory",
  "adapterCommand",
  "allowedScenarios",
  "allowedPolicies",
  "limits",
  "retentionDays",
  "issueReporting",
  "humanStudyAllowed"
] as const;
const REVOCATION_BODY_KEYS = [
  "expectedRevision",
  "approvalId",
  "reason"
] as const;

export interface WorkspacePlaytestApprovalControlApiOptions {
  readonly repositoryRoot?: string;
  readonly repository?: WorkspacePlaytestApprovalRepository;
  readonly audit?: (event: {
    readonly actor: string;
    readonly action: "approve_workspace_playtest" | "revoke_workspace_playtest";
    readonly workspaceId: string;
    readonly outcome: "ok" | "denied" | "error";
    readonly changes: Readonly<Record<string, unknown>> | null;
    readonly reason?: string;
  }) => void;
}

export interface WorkspaceApprovalActor {
  readonly actor: string;
  readonly role: "viewer" | "operator";
}

interface ApprovalRoute {
  readonly workspaceId: string;
  readonly revoke: boolean;
}

function sendWorkspaceApprovalError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_workspace_playtesting_error", { code }),
    { "cache-control": "no-store" }
  );
}

function onlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function routeFor(
  request: IncomingMessage,
  pathname: string
): ApprovalRoute | null {
  const url = new URL(request.url ?? pathname, "http://127.0.0.1");
  const match = url.pathname.match(APPROVAL_ROUTE_PATTERN);
  if (match === null) return null;
  let workspaceId: string;
  try {
    workspaceId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) return null;
  return { workspaceId, revoke: match[2] === "revoke" };
}

function expectedRevision(body: Record<string, unknown>): number | null {
  const value = body.expectedRevision;
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError(
      "expectedRevision must be a positive revision or null."
    );
  }
  return value as number | null;
}

function report(
  options: WorkspacePlaytestApprovalControlApiOptions,
  actor: WorkspaceApprovalActor,
  action: "approve_workspace_playtest" | "revoke_workspace_playtest",
  workspaceId: string,
  outcome: "ok" | "denied" | "error",
  changes: Readonly<Record<string, unknown>> | null,
  reason?: string
): void {
  options.audit?.({
    actor: actor.actor,
    action,
    workspaceId,
    outcome,
    changes,
    ...(reason === undefined ? {} : { reason })
  });
}

function readApprovalResponse(
  workspaceId: string,
  enabled: boolean,
  approval: WorkspacePlaytestApproval | null
): ControlApiWorkspacePlaytestApprovalResponse {
  return {
    schema: "autodev-control-workspace-playtest-approval-v1",
    workspaceId,
    workspaceEnabled: enabled,
    approval
  };
}

async function approveWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  route: ApprovalRoute,
  actor: WorkspaceApprovalActor,
  enabled: boolean,
  options: WorkspacePlaytestApprovalControlApiOptions,
  repository: WorkspacePlaytestApprovalRepository
): Promise<void> {
  const action = "approve_workspace_playtest" as const;
  if (actor.role !== "operator") {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "denied",
      null,
      "operator_required"
    );
    sendWorkspaceApprovalError(
      response,
      403,
      "autodev_workspace_playtesting_forbidden",
      "Operator approval is required."
    );
    return;
  }
  if (!enabled) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "denied",
      null,
      "workspace_disabled"
    );
    sendWorkspaceApprovalError(
      response,
      409,
      "autodev_workspace_playtesting_disabled",
      "A disabled workspace cannot receive a playtesting approval."
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "denied",
      null,
      parsed.code
    );
    sendWorkspaceApprovalError(
      response,
      parsed.status,
      parsed.code,
      parsed.message
    );
    return;
  }
  if (!onlyKeys(parsed.body, APPROVAL_BODY_KEYS)) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "denied",
      null,
      "unsupported_fields"
    );
    sendWorkspaceApprovalError(
      response,
      400,
      "autodev_workspace_playtesting_invalid_body",
      "Approval body contains unsupported fields."
    );
    return;
  }

  try {
    const revision = expectedRevision(parsed.body);
    const candidate: WorkspacePlaytestApproval = {
      schema: "autodev-workspace-playtest-approval-v1",
      workspaceId: route.workspaceId,
      revision: 1,
      approvalId: randomUUID(),
      checkoutRoot: requiredString(parsed.body.checkoutRoot, "checkoutRoot"),
      buildSha: requiredString(parsed.body.buildSha, "buildSha"),
      gameBuild: requiredString(parsed.body.gameBuild, "gameBuild"),
      playtestConfigHash: requiredString(
        parsed.body.playtestConfigHash,
        "playtestConfigHash"
      ),
      adapterImageDigest: requiredString(
        parsed.body.adapterImageDigest,
        "adapterImageDigest"
      ),
      workingDirectory: requiredString(
        parsed.body.workingDirectory,
        "workingDirectory"
      ),
      adapterCommand: stringArray(parsed.body.adapterCommand, "adapterCommand"),
      allowedScenarios: stringArray(
        parsed.body.allowedScenarios,
        "allowedScenarios"
      ),
      allowedPolicies: stringArray(
        parsed.body.allowedPolicies,
        "allowedPolicies"
      ),
      limits: parsed.body.limits as WorkspacePlaytestApproval["limits"],
      retentionDays: parsed.body.retentionDays as number,
      issueReporting: parsed.body
        .issueReporting as WorkspacePlaytestApproval["issueReporting"],
      humanStudyAllowed: parsed.body.humanStudyAllowed as boolean,
      approvedAt: new Date().toISOString(),
      approvedBy: actor.actor,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null
    };
    assertWorkspacePlaytestApproval(candidate);
    const approved = repository.approve(candidate, revision);
    report(options, actor, action, route.workspaceId, "ok", {
      approvalId: approved.approvalId,
      revision: approved.revision,
      buildSha: approved.buildSha,
      adapterImageDigest: approved.adapterImageDigest
    });
    sendJson(
      response,
      200,
      readApprovalResponse(route.workspaceId, enabled, approved),
      { "cache-control": "no-store" }
    );
  } catch (error) {
    if (error instanceof WorkspacePlaytestApprovalConflictError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        "denied",
        null,
        "revision_conflict"
      );
      sendWorkspaceApprovalError(
        response,
        409,
        "autodev_workspace_playtesting_conflict",
        error.message
      );
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        "denied",
        null,
        "invalid_approval"
      );
      sendWorkspaceApprovalError(
        response,
        400,
        "autodev_workspace_playtesting_invalid_approval",
        error.message
      );
      return;
    }
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "error",
      null,
      "approval_store_unavailable"
    );
    sendWorkspaceApprovalError(
      response,
      503,
      "autodev_workspace_playtesting_store_unavailable",
      "Workspace approval storage is unavailable."
    );
  }
}

async function revokeWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  route: ApprovalRoute,
  actor: WorkspaceApprovalActor,
  enabled: boolean,
  options: WorkspacePlaytestApprovalControlApiOptions,
  repository: WorkspacePlaytestApprovalRepository
): Promise<void> {
  const action = "revoke_workspace_playtest" as const;
  if (actor.role !== "operator") {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "denied",
      null,
      "operator_required"
    );
    sendWorkspaceApprovalError(
      response,
      403,
      "autodev_workspace_playtesting_forbidden",
      "Operator revocation is required."
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "denied",
      null,
      parsed.code
    );
    sendWorkspaceApprovalError(
      response,
      parsed.status,
      parsed.code,
      parsed.message
    );
    return;
  }
  if (!onlyKeys(parsed.body, REVOCATION_BODY_KEYS)) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "denied",
      null,
      "unsupported_fields"
    );
    sendWorkspaceApprovalError(
      response,
      400,
      "autodev_workspace_playtesting_invalid_body",
      "Revocation body contains unsupported fields."
    );
    return;
  }

  try {
    const revision = expectedRevision(parsed.body);
    if (revision === null)
      throw new TypeError("Revocation requires an expectedRevision.");
    const approvalId = requiredString(parsed.body.approvalId, "approvalId");
    const reason = requiredString(parsed.body.reason, "reason", 1024);
    const revoked = repository.revoke(
      route.workspaceId,
      approvalId,
      revision,
      new Date().toISOString(),
      actor.actor,
      reason
    );
    report(options, actor, action, route.workspaceId, "ok", {
      approvalId: revoked.approvalId,
      revision: revoked.revision,
      revokedAt: revoked.revokedAt,
      reason
    });
    sendJson(
      response,
      200,
      readApprovalResponse(route.workspaceId, enabled, revoked),
      { "cache-control": "no-store" }
    );
  } catch (error) {
    if (error instanceof WorkspacePlaytestApprovalConflictError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        "denied",
        null,
        "revision_conflict"
      );
      sendWorkspaceApprovalError(
        response,
        409,
        "autodev_workspace_playtesting_conflict",
        error.message
      );
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        "denied",
        null,
        "invalid_revocation"
      );
      sendWorkspaceApprovalError(
        response,
        400,
        "autodev_workspace_playtesting_invalid_revocation",
        error.message
      );
      return;
    }
    report(
      options,
      actor,
      action,
      route.workspaceId,
      "error",
      null,
      "approval_store_unavailable"
    );
    sendWorkspaceApprovalError(
      response,
      503,
      "autodev_workspace_playtesting_store_unavailable",
      "Workspace approval storage is unavailable."
    );
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requiredString(
  value: unknown,
  field: string,
  maximum = FILTER_VALUE_MAX_CHARS
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`Approval field '${field}' is invalid.`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 128 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0 ||
        item.length > 4096 ||
        hasControlCharacters(item)
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(
      `Approval field '${field}' must be a bounded unique string array.`
    );
  }
  return value.map((item) => (item as string).trim());
}

/** Handle the Workspaces-owned exact approval and revocation routes. */
export async function handleWorkspacePlaytestingApprovalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: WorkspaceApprovalActor,
  options: WorkspacePlaytestApprovalControlApiOptions = {}
): Promise<boolean> {
  const url = new URL(request.url ?? pathname, "http://127.0.0.1");
  const route = routeFor(request, pathname);
  if (route === null) return false;
  if ([...url.searchParams.keys()].length > 0) {
    sendWorkspaceApprovalError(
      response,
      400,
      "autodev_workspace_playtesting_invalid_query",
      "Workspace approval routes do not accept query parameters."
    );
    return true;
  }
  if (!ACTOR_ID_PATTERN.test(actor.actor)) {
    sendWorkspaceApprovalError(
      response,
      403,
      "autodev_workspace_playtesting_forbidden",
      "Workspace approval requires an authenticated actor."
    );
    return true;
  }
  const repositoryRoot = options.repositoryRoot;
  const workspaces = new ConfigRepository(
    repositoryRoot
  ).readWorkspaceCatalog();
  if (workspaces.status !== "valid") {
    sendWorkspaceApprovalError(
      response,
      503,
      "autodev_workspace_catalog_unavailable",
      "The canonical workspace catalog is unavailable."
    );
    return true;
  }
  const workspace = workspaces.workspaces.find(
    (entry) => entry.id === route.workspaceId
  );
  if (workspace === undefined) {
    sendWorkspaceApprovalError(
      response,
      404,
      "autodev_workspace_not_found",
      "The requested workspace was not found."
    );
    return true;
  }
  const repository =
    options.repository ?? new WorkspacePlaytestApprovalRepository();
  const method = request.method ?? "GET";
  if (route.revoke) {
    if (method !== "POST") {
      response.setHeader("allow", "POST");
      sendWorkspaceApprovalError(
        response,
        405,
        "autodev_control_api_method_not_allowed",
        "Workspace approval revocation accepts POST only."
      );
      return true;
    }
    await revokeWorkspace(
      request,
      response,
      route,
      actor,
      workspace.enabled,
      options,
      repository
    );
    return true;
  }
  if (method === "GET") {
    try {
      const approval = repository.read(route.workspaceId);
      sendJson(
        response,
        200,
        readApprovalResponse(route.workspaceId, workspace.enabled, approval),
        { "cache-control": "no-store" }
      );
    } catch {
      sendWorkspaceApprovalError(
        response,
        503,
        "autodev_workspace_playtesting_store_unavailable",
        "Workspace approval storage is unavailable."
      );
    }
    return true;
  }
  if (method !== "POST") {
    response.setHeader("allow", "GET, POST");
    sendWorkspaceApprovalError(
      response,
      405,
      "autodev_control_api_method_not_allowed",
      "Workspace approval routes accept GET and POST."
    );
    return true;
  }
  await approveWorkspace(
    request,
    response,
    route,
    actor,
    workspace.enabled,
    options,
    repository
  );
  return true;
}
