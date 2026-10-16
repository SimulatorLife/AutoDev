/** Operator-owned visual game target approval, isolated from adapter approval. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  assertWorkspaceVisualPlaytestLimits,
  assertWorkspaceVisualPlaytestTargetApproval,
  type ControlApiWorkspaceVisualPlaytestTargetsResponse,
  WORKSPACE_VISUAL_PLAYTEST_TARGET_SCHEMA,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import { ConfigRepository } from "@simulatorlife/autodev-data";
import {
  WorkspaceVisualPlaytestTargetConflictError,
  WorkspaceVisualPlaytestTargetRepository
} from "@simulatorlife/autodev-data/workspaces";

import { errorBody, sendJson } from "../router/proxy.ts";
import { readControlApiJsonObject } from "./body.ts";

const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const APPROVAL_BODY_KEYS = [
  "expectedRevision",
  "targetId",
  "name",
  "entryUrl",
  "allowedOrigins",
  "inputCapabilities",
  "controlTimingClass",
  "entryRequirements",
  "limits"
] as const;
const REVOCATION_BODY_KEYS = [
  "expectedRevision",
  "approvalId",
  "reason"
] as const;

export interface WorkspaceVisualPlaytestTargetControlApiOptions {
  readonly repositoryRoot?: string;
  readonly repository?: WorkspaceVisualPlaytestTargetRepository;
  readonly now?: () => Date;
  readonly createApprovalId?: () => string;
  readonly audit?: (event: {
    readonly actor: string;
    readonly action:
      "approve_visual_playtest_target" | "revoke_visual_playtest_target";
    readonly workspaceId: string;
    readonly targetId: string | null;
    readonly outcome: "ok" | "denied" | "error";
    readonly changes: Readonly<Record<string, unknown>> | null;
    readonly reason?: string;
  }) => void;
}

export interface WorkspaceVisualPlaytestTargetActor {
  readonly actor: string;
  readonly role: "viewer" | "operator";
}

interface TargetRoute {
  readonly workspaceId: string;
  readonly targetId: string | null;
  readonly revoke: boolean;
}

function sendTargetError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_workspace_visual_playtest_target_error", {
      code
    }),
    { "cache-control": "no-store" }
  );
}

function onlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function routeFor(pathname: string): TargetRoute | null {
  const segments = pathname.split("/");
  if (
    (segments.length !== 5 && segments.length !== 7) ||
    segments[1] !== "control" ||
    segments[2] !== "workspaces" ||
    segments[4] !== "playtesting-visual-targets" ||
    (segments.length === 7 && segments[6] !== "revoke")
  ) {
    return null;
  }
  let workspaceId: string;
  let targetId: string | null = null;
  try {
    workspaceId = decodeURIComponent(segments[3]!);
    if (segments.length === 7) targetId = decodeURIComponent(segments[5]!);
  } catch {
    return null;
  }
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    (targetId !== null && !TARGET_ID_PATTERN.test(targetId))
  ) {
    return null;
  }
  return {
    workspaceId,
    targetId,
    revoke: targetId !== null
  };
}

function expectedRevision(
  body: Record<string, unknown>
): number | null | undefined {
  const value = body.expectedRevision;
  if (value === null) return null;
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function report(
  options: WorkspaceVisualPlaytestTargetControlApiOptions,
  actor: WorkspaceVisualPlaytestTargetActor,
  action: "approve_visual_playtest_target" | "revoke_visual_playtest_target",
  workspaceId: string,
  targetId: string | null,
  outcome: "ok" | "denied" | "error",
  changes: Readonly<Record<string, unknown>> | null,
  reason?: string
): void {
  options.audit?.({
    actor: actor.actor,
    action,
    workspaceId,
    targetId,
    outcome,
    changes,
    ...(reason === undefined ? {} : { reason })
  });
}

function responseFor(
  workspaceId: string,
  workspaceEnabled: boolean,
  targets: readonly WorkspaceVisualPlaytestTargetApproval[]
): ControlApiWorkspaceVisualPlaytestTargetsResponse {
  return {
    schema: "autodev-control-workspace-visual-playtest-targets-v1",
    workspaceId,
    workspaceEnabled,
    targets
  };
}

async function approveTarget(
  request: IncomingMessage,
  response: ServerResponse,
  route: TargetRoute,
  actor: WorkspaceVisualPlaytestTargetActor,
  workspaceEnabled: boolean,
  options: WorkspaceVisualPlaytestTargetControlApiOptions,
  repository: WorkspaceVisualPlaytestTargetRepository
): Promise<void> {
  const action = "approve_visual_playtest_target" as const;
  if (actor.role !== "operator") {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      null,
      "denied",
      null,
      "operator_required"
    );
    sendTargetError(
      response,
      403,
      "autodev_workspace_visual_target_forbidden",
      "Operator approval is required."
    );
    return;
  }
  if (!workspaceEnabled) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      null,
      "denied",
      null,
      "workspace_disabled"
    );
    sendTargetError(
      response,
      409,
      "autodev_workspace_visual_target_disabled",
      "A disabled workspace cannot receive a visual target approval."
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
      null,
      "denied",
      null,
      parsed.code
    );
    sendTargetError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  if (!onlyKeys(parsed.body, APPROVAL_BODY_KEYS)) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      null,
      "denied",
      null,
      "unsupported_fields"
    );
    sendTargetError(
      response,
      400,
      "autodev_workspace_visual_target_invalid_body",
      "Visual target approval contains unsupported fields."
    );
    return;
  }
  const revision = expectedRevision(parsed.body);
  if (revision === undefined) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      null,
      "denied",
      null,
      "invalid_revision"
    );
    sendTargetError(
      response,
      400,
      "autodev_workspace_visual_target_invalid_revision",
      "expectedRevision must be null or a positive revision."
    );
    return;
  }
  if (
    typeof parsed.body.targetId !== "string" ||
    typeof parsed.body.name !== "string" ||
    typeof parsed.body.entryUrl !== "string" ||
    !Array.isArray(parsed.body.allowedOrigins) ||
    !Array.isArray(parsed.body.inputCapabilities) ||
    typeof parsed.body.controlTimingClass !== "string" ||
    typeof parsed.body.entryRequirements !== "string"
  ) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      null,
      "denied",
      null,
      "invalid_fields"
    );
    sendTargetError(
      response,
      400,
      "autodev_workspace_visual_target_invalid_body",
      "Visual target approval is missing required fields."
    );
    return;
  }
  try {
    assertWorkspaceVisualPlaytestLimits(parsed.body.limits);
  } catch {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      parsed.body.targetId,
      "denied",
      null,
      "invalid_limits"
    );
    sendTargetError(
      response,
      400,
      "autodev_workspace_visual_target_invalid_body",
      "Visual target limits are invalid."
    );
    return;
  }

  const now = options.now?.() ?? new Date();
  const candidate: unknown = {
    schema: WORKSPACE_VISUAL_PLAYTEST_TARGET_SCHEMA,
    workspaceId: route.workspaceId,
    targetId: parsed.body.targetId,
    revision: revision === null ? 1 : revision + 1,
    approvalId: options.createApprovalId?.() ?? randomUUID(),
    name: parsed.body.name,
    entryUrl: parsed.body.entryUrl,
    allowedOrigins: parsed.body.allowedOrigins,
    inputCapabilities: parsed.body.inputCapabilities,
    controlTimingClass: parsed.body.controlTimingClass,
    entryRequirements: parsed.body.entryRequirements,
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: parsed.body.limits,
    approvedAt: now.toISOString(),
    approvedBy: actor.actor,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
  try {
    assertWorkspaceVisualPlaytestTargetApproval(candidate);
    const previousTargets = repository.list(route.workspaceId);
    const saved = repository.approve(candidate, revision);
    const targets = [
      ...previousTargets.filter((target) => target.targetId !== saved.targetId),
      saved
    ].sort((left, right) =>
      left.targetId < right.targetId
        ? -1
        : left.targetId > right.targetId
          ? 1
          : 0
    );
    report(options, actor, action, route.workspaceId, saved.targetId, "ok", {
      origin: new URL(saved.entryUrl).origin,
      allowedOrigins: saved.allowedOrigins,
      inputCapabilities: saved.inputCapabilities,
      controlTimingClass: saved.controlTimingClass,
      entryRequirements: saved.entryRequirements,
      limits: saved.limits,
      revision: saved.revision
    });
    sendJson(
      response,
      200,
      responseFor(route.workspaceId, workspaceEnabled, targets),
      { "cache-control": "no-store" }
    );
  } catch (error) {
    if (error instanceof WorkspaceVisualPlaytestTargetConflictError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        parsed.body.targetId,
        "denied",
        null,
        "revision_conflict"
      );
      sendTargetError(
        response,
        409,
        "autodev_workspace_visual_target_revision_conflict",
        error.message
      );
      return;
    }
    if (error instanceof TypeError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        parsed.body.targetId,
        "denied",
        null,
        "invalid_target"
      );
      sendTargetError(
        response,
        400,
        "autodev_workspace_visual_target_invalid_body",
        error.message
      );
      return;
    }
    report(
      options,
      actor,
      action,
      route.workspaceId,
      parsed.body.targetId,
      "error",
      null,
      "store_unavailable"
    );
    sendTargetError(
      response,
      503,
      "autodev_workspace_visual_target_store_unavailable",
      "Visual target approval storage is unavailable."
    );
  }
}

async function revokeTarget(
  request: IncomingMessage,
  response: ServerResponse,
  route: TargetRoute,
  actor: WorkspaceVisualPlaytestTargetActor,
  workspaceEnabled: boolean,
  options: WorkspaceVisualPlaytestTargetControlApiOptions,
  repository: WorkspaceVisualPlaytestTargetRepository
): Promise<void> {
  const action = "revoke_visual_playtest_target" as const;
  const targetId = route.targetId!;
  if (actor.role !== "operator") {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      targetId,
      "denied",
      null,
      "operator_required"
    );
    sendTargetError(
      response,
      403,
      "autodev_workspace_visual_target_forbidden",
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
      targetId,
      "denied",
      null,
      parsed.code
    );
    sendTargetError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  if (!onlyKeys(parsed.body, REVOCATION_BODY_KEYS)) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      targetId,
      "denied",
      null,
      "unsupported_fields"
    );
    sendTargetError(
      response,
      400,
      "autodev_workspace_visual_target_invalid_body",
      "Visual target revocation contains unsupported fields."
    );
    return;
  }
  const revision = expectedRevision(parsed.body);
  const { approvalId, reason } = parsed.body;
  if (
    revision === undefined ||
    revision === null ||
    typeof approvalId !== "string" ||
    typeof reason !== "string" ||
    reason.trim().length === 0 ||
    reason.length > 1024
  ) {
    report(
      options,
      actor,
      action,
      route.workspaceId,
      targetId,
      "denied",
      null,
      "invalid_fields"
    );
    sendTargetError(
      response,
      400,
      "autodev_workspace_visual_target_invalid_body",
      "Revocation requires a target revision, approval id, and reason."
    );
    return;
  }
  try {
    const previousTargets = repository.list(route.workspaceId);
    const existing = previousTargets.find(
      (target) => target.targetId === targetId
    );
    if (existing === undefined) {
      throw new WorkspaceVisualPlaytestTargetConflictError(revision, null);
    }
    const revokedAt = (options.now?.() ?? new Date()).toISOString();
    repository.revoke(
      route.workspaceId,
      targetId,
      approvalId,
      revision,
      revokedAt,
      actor.actor,
      reason.trim()
    );
    const revoked: WorkspaceVisualPlaytestTargetApproval = {
      ...existing,
      revision: revision + 1,
      revokedAt,
      revokedBy: actor.actor,
      revocationReason: reason.trim()
    };
    report(options, actor, action, route.workspaceId, targetId, "ok", {
      approvalId,
      revision: revision + 1
    });
    sendJson(
      response,
      200,
      responseFor(
        route.workspaceId,
        workspaceEnabled,
        previousTargets.map((target) =>
          target.targetId === targetId ? revoked : target
        )
      ),
      { "cache-control": "no-store" }
    );
  } catch (error) {
    if (error instanceof WorkspaceVisualPlaytestTargetConflictError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        targetId,
        "denied",
        null,
        "revision_conflict"
      );
      sendTargetError(
        response,
        409,
        "autodev_workspace_visual_target_revision_conflict",
        error.message
      );
      return;
    }
    if (error instanceof TypeError) {
      report(
        options,
        actor,
        action,
        route.workspaceId,
        targetId,
        "denied",
        null,
        "invalid_revocation"
      );
      sendTargetError(
        response,
        400,
        "autodev_workspace_visual_target_invalid_body",
        error.message
      );
      return;
    }
    report(
      options,
      actor,
      action,
      route.workspaceId,
      targetId,
      "error",
      null,
      "store_unavailable"
    );
    sendTargetError(
      response,
      503,
      "autodev_workspace_visual_target_store_unavailable",
      "Visual target approval storage is unavailable."
    );
  }
}

/** Handle the exact Workspaces-owned target list, approve, and revoke routes. */
export async function handleWorkspaceVisualPlaytestTargetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: WorkspaceVisualPlaytestTargetActor,
  options: WorkspaceVisualPlaytestTargetControlApiOptions = {}
): Promise<boolean> {
  const route = routeFor(pathname);
  if (route === null) return false;
  const url = new URL(request.url ?? pathname, "http://127.0.0.1");
  if ([...url.searchParams.keys()].length > 0) {
    sendTargetError(
      response,
      400,
      "autodev_workspace_visual_target_invalid_query",
      "Visual target routes do not accept query parameters."
    );
    return true;
  }
  if (!ACTOR_ID_PATTERN.test(actor.actor)) {
    sendTargetError(
      response,
      403,
      "autodev_workspace_visual_target_forbidden",
      "Visual target approval requires an authenticated actor."
    );
    return true;
  }
  const workspaces = new ConfigRepository(
    options.repositoryRoot
  ).readWorkspaceCatalog();
  if (workspaces.status !== "valid") {
    sendTargetError(
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
    sendTargetError(
      response,
      404,
      "autodev_workspace_not_found",
      "The requested workspace was not found."
    );
    return true;
  }
  const repository =
    options.repository ?? new WorkspaceVisualPlaytestTargetRepository();
  const method = request.method ?? "GET";
  if (route.revoke) {
    if (method !== "POST") {
      response.setHeader("allow", "POST");
      sendTargetError(
        response,
        405,
        "autodev_control_api_method_not_allowed",
        "Visual target revocation accepts POST only."
      );
      return true;
    }
    await revokeTarget(
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
      sendJson(
        response,
        200,
        responseFor(
          route.workspaceId,
          workspace.enabled,
          repository.list(route.workspaceId)
        ),
        { "cache-control": "no-store" }
      );
    } catch {
      sendTargetError(
        response,
        503,
        "autodev_workspace_visual_target_store_unavailable",
        "Visual target approval storage is unavailable."
      );
    }
    return true;
  }
  if (method !== "POST") {
    response.setHeader("allow", "GET, POST");
    sendTargetError(
      response,
      405,
      "autodev_control_api_method_not_allowed",
      "Visual target routes accept GET and POST."
    );
    return true;
  }
  await approveTarget(
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
