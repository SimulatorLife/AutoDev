import type {
  ControlApiErrorEnvelope,
  ControlApiGithubMutationResponse,
  GithubWorkflowMutationRequest,
  GithubWorkflowState
} from "@simulatorlife/autodev-core";
import {
  ConfigRepository,
  type GithubActionsAdapter,
  GithubActionsApiError,
  GithubWorkflowRepository
} from "@simulatorlife/autodev-data";

const MAX_IDEMPOTENCY_ENTRIES = 256;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const WORKFLOW_STATE_VALUES = new Set<GithubWorkflowState>([
  "active",
  "disabled_manually",
  "disabled_inactivity",
  "deleted",
  "unknown"
]);

/**
 * Runtime Control API mutation policy. Workflow YAML continues to own cron;
 * this allowlist only controls which existing schedules operators may stop or
 * resume, and which no-input workflow can be dispatched by this first slice.
 */
export const GITHUB_WORKFLOW_MUTATION_POLICY = {
  "_scheduler.yml": { enableDisable: true, dispatch: true },
  "metrics-dashboard.yml": { enableDisable: true, dispatch: false },
  "target-automerge.yml": { enableDisable: true, dispatch: false },
  "target-pr-janitor.yml": { enableDisable: true, dispatch: false }
} as const;

export interface GithubMutationAuditRecord {
  readonly action: string;
  readonly resource: string;
  readonly outcome: "ok" | "denied" | "error";
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

export interface GithubMutationContext {
  readonly repositoryRoot: string;
  readonly adapter: GithubActionsAdapter;
  readonly env?: NodeJS.ProcessEnv;
  readonly audit: (record: GithubMutationAuditRecord) => void;
  readonly now?: () => number;
}

export interface GithubMutationHttpResult {
  readonly status: number;
  readonly body: ControlApiGithubMutationResponse | ControlApiErrorEnvelope;
}

interface CachedMutation {
  readonly fingerprint: string;
  promise: Promise<GithubMutationHttpResult>;
  expiresAt: number;
  settled: boolean;
}

export class GithubWorkflowMutationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly auditOutcome: "denied" | "error";

  constructor(
    message: string,
    status: number,
    code: string,
    auditOutcome: "denied" | "error" = "denied"
  ) {
    super(message);
    this.name = "GithubWorkflowMutationError";
    this.status = status;
    this.code = code;
    this.auditOutcome = auditOutcome;
  }
}

const idempotencyEntries = new Map<string, CachedMutation>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseGithubWorkflowMutationRequest(
  value: unknown
): GithubWorkflowMutationRequest | null {
  if (!isRecord(value)) return null;
  const operation = value.operation;
  const workflow = value.workflow;
  const idempotencyKey = value.idempotencyKey;
  if (
    (operation !== "dispatch" &&
      operation !== "enable" &&
      operation !== "disable") ||
    typeof workflow !== "string" ||
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return null;
  }
  if (!Object.hasOwn(GITHUB_WORKFLOW_MUTATION_POLICY, workflow)) return null;

  const allowedKeys =
    operation === "dispatch"
      ? ["operation", "workflow", "idempotencyKey"]
      : ["operation", "workflow", "idempotencyKey", "expectedState"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return null;

  if (operation === "dispatch") {
    return { operation, workflow, idempotencyKey };
  }
  if (
    typeof value.expectedState !== "string" ||
    !WORKFLOW_STATE_VALUES.has(value.expectedState as GithubWorkflowState)
  ) {
    return null;
  }
  return {
    operation,
    workflow,
    idempotencyKey,
    expectedState: value.expectedState as GithubWorkflowState
  };
}

function mutationErrorBody(
  error: GithubWorkflowMutationError
): ControlApiErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      status: error.status
    }
  };
}

function resourceFor(workflow: string): string {
  return `/control/github/mutations/${workflow}`;
}

function auditRecord(
  context: GithubMutationContext,
  request: GithubWorkflowMutationRequest,
  outcome: "ok" | "denied" | "error",
  changes: Record<string, unknown> | null,
  reason?: string
): void {
  context.audit({
    action: `github_${request.operation}`,
    resource: resourceFor(request.workflow),
    outcome,
    changes,
    ...(reason ? { reason } : {})
  });
}

function configuredWorkspace(context: GithubMutationContext): {
  owner: string;
  repo: string;
  repository: string;
  baseBranch: string;
  token: string;
} {
  const env = context.env ?? process.env;
  const repository = env.AUTODEV_GITHUB_REPOSITORY?.trim() ?? "";
  if (!repository) {
    throw new GithubWorkflowMutationError(
      "AUTODEV_GITHUB_REPOSITORY is not configured.",
      503,
      "github_repository_unavailable"
    );
  }
  const catalog = new ConfigRepository(
    context.repositoryRoot
  ).readWorkspaceCatalog();
  if (catalog.status !== "valid") {
    throw new GithubWorkflowMutationError(
      "The canonical workspace catalog is unavailable or invalid.",
      503,
      "github_workspace_catalog_unavailable"
    );
  }
  const workspace = catalog.workspaces.find((entry) => entry.id === repository);
  if (!workspace) {
    throw new GithubWorkflowMutationError(
      "The configured GitHub repository is not a recognized workspace.",
      400,
      "github_repository_out_of_scope"
    );
  }
  if (!workspace.enabled) {
    throw new GithubWorkflowMutationError(
      "The configured GitHub workspace is disabled.",
      409,
      "github_workspace_disabled"
    );
  }
  const token = env.AUTODEV_GITHUB_ACTIONS_WRITE_TOKEN?.trim() ?? "";
  if (!token) {
    throw new GithubWorkflowMutationError(
      "AUTODEV_GITHUB_ACTIONS_WRITE_TOKEN is not configured.",
      503,
      "github_write_token_unavailable"
    );
  }
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new GithubWorkflowMutationError(
      "The configured GitHub repository identifier is invalid.",
      400,
      "github_repository_invalid"
    );
  }
  return { owner, repo, repository, baseBranch: workspace.baseBranch, token };
}

function policyFor(
  request: GithubWorkflowMutationRequest
): (typeof GITHUB_WORKFLOW_MUTATION_POLICY)[keyof typeof GITHUB_WORKFLOW_MUTATION_POLICY] {
  if (!Object.hasOwn(GITHUB_WORKFLOW_MUTATION_POLICY, request.workflow)) {
    throw new GithubWorkflowMutationError(
      "This workflow is not allowlisted for GitHub Actions mutations.",
      404,
      "github_workflow_not_allowlisted"
    );
  }
  return GITHUB_WORKFLOW_MUTATION_POLICY[
    request.workflow as keyof typeof GITHUB_WORKFLOW_MUTATION_POLICY
  ];
}

function currentDefinition(
  request: GithubWorkflowMutationRequest,
  context: GithubMutationContext
) {
  const policy = policyFor(request);
  const catalog = new GithubWorkflowRepository(
    context.repositoryRoot
  ).readWorkflowCatalog();
  if (catalog.status !== "valid") {
    throw new GithubWorkflowMutationError(
      "Current workflow YAML is unavailable or invalid.",
      409,
      "github_workflow_yaml_invalid"
    );
  }
  const definition = catalog.workflows.find(
    (workflow) => workflow.id === request.workflow
  );
  if (!definition || definition.schedules.length === 0) {
    throw new GithubWorkflowMutationError(
      "The allowlisted workflow no longer declares a schedule.",
      409,
      "github_workflow_schema_changed"
    );
  }
  if (request.operation === "dispatch") {
    if (!policy.dispatch) {
      throw new GithubWorkflowMutationError(
        "Dispatch is not enabled for this workflow.",
        403,
        "github_dispatch_not_allowlisted"
      );
    }
    if (!definition.events.includes("workflow_dispatch")) {
      throw new GithubWorkflowMutationError(
        "The workflow no longer declares workflow_dispatch.",
        409,
        "github_workflow_schema_changed"
      );
    }
    const dispatchContract = new GithubWorkflowRepository(
      context.repositoryRoot
    ).readDispatchContract(request.workflow);
    if (dispatchContract.status !== "valid" || !dispatchContract.dispatchable) {
      throw new GithubWorkflowMutationError(
        "Dispatch is refused because the current workflow has required inputs or an invalid dispatch schema.",
        409,
        "github_dispatch_schema_not_supported"
      );
    }
  } else if (!policy.enableDisable) {
    throw new GithubWorkflowMutationError(
      "Enable/disable is not enabled for this workflow.",
      403,
      "github_state_change_not_allowlisted"
    );
  }
  return definition;
}

function mapGithubError(error: unknown): GithubWorkflowMutationError {
  if (error instanceof GithubWorkflowMutationError) return error;
  if (error instanceof GithubActionsApiError) {
    return new GithubWorkflowMutationError(
      "GitHub Actions rejected or could not verify the operation.",
      error.status === 401 || error.status === 403 ? 502 : error.status,
      `github_${error.code}`,
      "error"
    );
  }
  return new GithubWorkflowMutationError(
    "GitHub Actions operation failed.",
    502,
    "github_mutation_failed",
    "error"
  );
}

async function performMutation(
  request: GithubWorkflowMutationRequest,
  context: GithubMutationContext
): Promise<GithubMutationHttpResult> {
  const changes: Record<string, unknown> = {
    operation: request.operation,
    workflow: request.workflow,
    ...(request.expectedState ? { expectedState: request.expectedState } : {})
  };
  try {
    const definition = currentDefinition(request, context);
    const binding = configuredWorkspace(context);
    const apiWorkflows = await context.adapter.listWorkflows(
      binding.owner,
      binding.repo,
      binding.token
    );
    const apiMatches = apiWorkflows.filter(
      (workflow) => workflow.path === `.github/workflows/${definition.id}`
    );
    if (apiMatches.length !== 1) {
      throw new GithubWorkflowMutationError(
        "The allowlisted workflow could not be uniquely matched in GitHub Actions.",
        409,
        "github_workflow_identity_mismatch"
      );
    }
    const apiWorkflow = apiMatches[0]!;

    if (request.operation === "dispatch") {
      if (apiWorkflow.state !== "active") {
        throw new GithubWorkflowMutationError(
          "Only an active workflow can be dispatched.",
          409,
          "github_workflow_not_active"
        );
      }
      if (
        await context.adapter.hasActiveWorkflowRuns(
          binding.owner,
          binding.repo,
          apiWorkflow.id,
          binding.token
        )
      ) {
        throw new GithubWorkflowMutationError(
          "Dispatch is refused while this workflow has a queued or in-progress run.",
          409,
          "github_workflow_run_active"
        );
      }
      await context.adapter.dispatchWorkflow(
        binding.owner,
        binding.repo,
        apiWorkflow.id,
        binding.baseBranch,
        binding.token
      );
      const result: ControlApiGithubMutationResponse = {
        schema: "autodev-control-github-mutation-v1",
        operation: request.operation,
        workflow: request.workflow,
        result: "applied"
      };
      changes.refSource = "workspace_base_branch";
      auditRecord(context, request, "ok", changes);
      return { status: 200, body: result };
    }

    const expectedState = request.expectedState;
    if (!expectedState) {
      throw new GithubWorkflowMutationError(
        "Enable/disable requires the expected workflow state.",
        400,
        "github_expected_state_required"
      );
    }
    const before = await context.adapter.getWorkflow(
      binding.owner,
      binding.repo,
      apiWorkflow.id,
      binding.token
    );
    if (before.state !== expectedState) {
      throw new GithubWorkflowMutationError(
        "The workflow state changed; refresh GitHub state before retrying.",
        409,
        "github_workflow_state_stale"
      );
    }
    if (request.operation === "disable" && before.state !== "active") {
      throw new GithubWorkflowMutationError(
        "Only an active workflow can be disabled.",
        409,
        "github_workflow_state_conflict"
      );
    }
    if (
      request.operation === "enable" &&
      before.state !== "disabled_manually" &&
      before.state !== "disabled_inactivity"
    ) {
      throw new GithubWorkflowMutationError(
        "Only a disabled workflow can be enabled.",
        409,
        "github_workflow_state_conflict"
      );
    }
    if (request.operation === "enable") {
      await context.adapter.enableWorkflow(
        binding.owner,
        binding.repo,
        apiWorkflow.id,
        binding.token
      );
    } else {
      await context.adapter.disableWorkflow(
        binding.owner,
        binding.repo,
        apiWorkflow.id,
        binding.token
      );
    }
    const after = await context.adapter.getWorkflow(
      binding.owner,
      binding.repo,
      apiWorkflow.id,
      binding.token
    );
    const desiredState =
      request.operation === "enable" ? "active" : "disabled_manually";
    if (after.state !== desiredState) {
      throw new GithubWorkflowMutationError(
        "GitHub Actions did not confirm the requested workflow state.",
        502,
        "github_workflow_state_verification_failed",
        "error"
      );
    }
    const result: ControlApiGithubMutationResponse = {
      schema: "autodev-control-github-mutation-v1",
      operation: request.operation,
      workflow: request.workflow,
      result: "applied",
      workflowState: desiredState
    };
    changes.previousState = before.state;
    changes.workflowState = desiredState;
    auditRecord(context, request, "ok", changes);
    return { status: 200, body: result };
  } catch (error_: unknown) {
    const error = mapGithubError(error_);
    auditRecord(context, request, error.auditOutcome, changes, error.code);
    return { status: error.status, body: mutationErrorBody(error) };
  }
}

function expireEntries(now: number): void {
  for (const [key, entry] of idempotencyEntries) {
    if (entry.expiresAt <= now && entry.settled) idempotencyEntries.delete(key);
  }
}

function capacityError(): GithubWorkflowMutationError {
  return new GithubWorkflowMutationError(
    "GitHub mutation idempotency capacity is temporarily full.",
    503,
    "github_idempotency_capacity",
    "error"
  );
}

export async function handleGithubWorkflowMutation(
  rawRequest: unknown,
  actor: string,
  context: GithubMutationContext
): Promise<GithubMutationHttpResult> {
  const request = parseGithubWorkflowMutationRequest(rawRequest);
  if (!request) {
    context.audit({
      action: "github_mutation",
      resource: "/control/github/mutations",
      outcome: "denied",
      changes: null,
      reason: "invalid_body"
    });
    const error = new GithubWorkflowMutationError(
      "GitHub mutation body is invalid.",
      400,
      "github_mutation_bad_body"
    );
    return { status: error.status, body: mutationErrorBody(error) };
  }

  const now = (context.now ?? Date.now)();
  expireEntries(now);
  const mapKey = `${actor}\u0000${request.idempotencyKey}`;
  const fingerprint = JSON.stringify({
    operation: request.operation,
    workflow: request.workflow,
    expectedState: request.expectedState ?? null
  });
  const existing = idempotencyEntries.get(mapKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      const error = new GithubWorkflowMutationError(
        "The idempotency key was already used for a different operation.",
        409,
        "github_idempotency_key_conflict"
      );
      auditRecord(context, request, "denied", null, error.code);
      return { status: error.status, body: mutationErrorBody(error) };
    }
    const replay = await existing.promise;
    const replayedBody =
      "schema" in replay.body
        ? { ...replay.body, result: "replayed" as const }
        : replay.body;
    const outcome = replay.status < 400 ? "ok" : "error";
    auditRecord(
      context,
      request,
      outcome,
      {
        operation: request.operation,
        workflow: request.workflow,
        replayed: true
      },
      "idempotent_replay"
    );
    return { status: replay.status, body: replayedBody };
  }

  if (idempotencyEntries.size >= MAX_IDEMPOTENCY_ENTRIES) {
    const oldestSettled = Array.from(idempotencyEntries).find(
      ([, entry]) => entry.settled
    );
    if (oldestSettled) idempotencyEntries.delete(oldestSettled[0]);
  }
  if (idempotencyEntries.size >= MAX_IDEMPOTENCY_ENTRIES) {
    const error = capacityError();
    auditRecord(context, request, "error", null, error.code);
    return { status: error.status, body: mutationErrorBody(error) };
  }

  const promise = Promise.resolve().then(() =>
    performMutation(request, context)
  );
  const entry: CachedMutation = {
    fingerprint,
    promise,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
    settled: false
  };
  idempotencyEntries.set(mapKey, entry);
  const result = await promise;
  entry.settled = true;
  entry.expiresAt = (context.now ?? Date.now)() + IDEMPOTENCY_TTL_MS;
  return result;
}
