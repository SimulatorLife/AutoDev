import path from "node:path";

import {
  type ControlApiGithubResponse,
  type GithubActionsRuntimeStatus,
  type GithubWorkflowDefinition,
  type GithubWorkflowRun,
  type GithubWorkflowState
} from "@simulatorlife/autodev-core";
import {
  ConfigRepository,
  GithubActionsAdapter,
  GithubActionsApiError,
  type GithubActionsRuntimeSnapshot,
  type GithubApiWorkflow,
  GithubWorkflowRepository
} from "@simulatorlife/autodev-data";

import { resolveRuntimeSourceRoot } from "../shared/runtime-source-root.ts";

const GITHUB_CONTROL_API_SCHEMA = "autodev-control-github-v1";
const GITHUB_WORKFLOW_YAML_SOURCE = ".github/workflows";
const DEFAULT_REPO_ROOT = resolveRuntimeSourceRoot(
  import.meta.dirname,
  process.env.AUTODEV_REPO_ROOT
);

let githubActionsAdapterOverride: GithubActionsAdapter | null = null;
interface CachedGithubSnapshot {
  readonly timestamp: number;
  readonly snapshot: GithubActionsRuntimeSnapshot;
}
const GITHUB_SNAPSHOT_CACHE = new Map<string, CachedGithubSnapshot>();
const GITHUB_SNAPSHOT_CACHE_TTL_MS = 15_000;

export function clearGithubSnapshotCacheForTests(): void {
  GITHUB_SNAPSHOT_CACHE.clear();
}

export function setGithubActionsAdapterForTests(
  adapter: GithubActionsAdapter | null
): void {
  githubActionsAdapterOverride = adapter;
  clearGithubSnapshotCacheForTests();
}

export interface GithubWorkflowsViewOptions {
  readonly actionsAdapter?: GithubActionsAdapter;
  readonly token?: string;
  readonly repository?: string;
}

type GithubWorkflowCatalogStatus = "valid" | "invalid" | "unavailable";

interface GithubUnavailableResponseOptions {
  readonly catalogStatus: GithubWorkflowCatalogStatus;
  readonly totalWorkflows: number | null;
  readonly workflows: readonly GithubWorkflowDefinition[];
  readonly runtimeStatus: GithubActionsRuntimeStatus;
  readonly runtimeMessage: string;
  readonly repository: string | null;
}

function unavailableGithubResponse(
  options: GithubUnavailableResponseOptions
): Record<string, unknown> {
  return {
    schema: GITHUB_CONTROL_API_SCHEMA,
    source: GITHUB_WORKFLOW_YAML_SOURCE,
    readOnly: true,
    catalogStatus: options.catalogStatus,
    totalWorkflows: options.totalWorkflows,
    workflows: options.workflows,
    runtimeFactsAvailable: false,
    runtimeStatus: options.runtimeStatus,
    runtimeMessage: options.runtimeMessage,
    repository: options.repository,
    stats: null,
    // The Actions read did not happen, so the runs were never asked for. An
    // empty list here would say the workflows have never run, which is a claim
    // about the repository rather than about this read.
    recentRuns: null
  };
}

function unavailableWorkflowDefinitions(
  workflows: readonly GithubWorkflowDefinition[]
): GithubWorkflowDefinition[] {
  return workflows.map((workflow) => ({
    ...workflow,
    actionsState: "unavailable",
    actionsWorkflowId: null,
    actionsHtmlUrl: null,
    recentRunsCount: null,
    lastRunStatus: null,
    lastRunConclusion: null,
    lastRunCreatedAt: null,
    lastRunHtmlUrl: null
  }));
}

type GithubRuntimeBindingResolution =
  | {
      readonly available: true;
      readonly owner: string;
      readonly repo: string;
      readonly repository: string;
      readonly token: string | undefined;
      readonly unavailableWorkflows: readonly GithubWorkflowDefinition[];
    }
  | {
      readonly available: false;
      readonly response: Record<string, unknown>;
    };

function resolveGithubRuntimeBinding(
  root: string,
  workflows: readonly GithubWorkflowDefinition[],
  options: GithubWorkflowsViewOptions
): GithubRuntimeBindingResolution {
  const unavailableWorkflows = unavailableWorkflowDefinitions(workflows);
  const configuredToken = options.token ?? process.env.AUTODEV_GITHUB_TOKEN;
  const token = configuredToken?.trim() ? configuredToken.trim() : undefined;
  const repository =
    options.repository ??
    process.env.AUTODEV_GITHUB_REPOSITORY ??
    process.env.GITHUB_REPOSITORY ??
    null;

  const unavailable = (
    runtimeStatus: GithubActionsRuntimeStatus,
    runtimeMessage: string
  ): GithubRuntimeBindingResolution => ({
    available: false,
    response: unavailableGithubResponse({
      catalogStatus: "valid",
      totalWorkflows: workflows.length,
      workflows: unavailableWorkflows,
      runtimeStatus,
      runtimeMessage,
      repository
    })
  });

  if (!repository) {
    return unavailable(
      "unavailable",
      "AUTODEV_GITHUB_REPOSITORY is not configured; no repository is bound."
    );
  }

  const workspaceCatalog = new ConfigRepository(root).readWorkspaceCatalog();
  const workspace =
    workspaceCatalog.status === "valid"
      ? workspaceCatalog.workspaces.find((entry) => entry.id === repository)
      : undefined;
  if (!workspace) {
    return unavailable(
      "invalid",
      `Configured repository "${repository}" is not a recognized workspace in config/workspaces.json.`
    );
  }

  if (!workspace.enabled) {
    return unavailable(
      "invalid",
      `Configured workspace "${repository}" is disabled in config/workspaces.json.`
    );
  }

  const [owner, repo, extraSegment] = repository.split("/");
  if (!owner || !repo || extraSegment !== undefined) {
    return unavailable(
      "invalid",
      `Invalid repository identifier format: "${repository}". Expected "owner/repo".`
    );
  }

  return {
    available: true,
    owner,
    repo,
    repository,
    token,
    unavailableWorkflows
  };
}

function addToIndex<Key, Value>(
  index: Map<Key, Value[]>,
  key: Key,
  value: Value
): void {
  const values = index.get(key);
  if (values) {
    values.push(value);
  } else {
    index.set(key, [value]);
  }
}

function githubWorkflowState(state: string | undefined): GithubWorkflowState {
  if (
    state === "active" ||
    state === "disabled_manually" ||
    state === "disabled_inactivity" ||
    state === "deleted"
  ) {
    return state;
  }
  return "unknown";
}

interface ProjectedGithubWorkflows {
  readonly workflows: readonly GithubWorkflowDefinition[];
}

function projectGithubWorkflows(
  definitions: readonly GithubWorkflowDefinition[],
  snapshot: GithubActionsRuntimeSnapshot
): ProjectedGithubWorkflows {
  const apiWorkflowByPathOrFile = new Map<string, GithubApiWorkflow>();
  for (const workflow of snapshot.workflows) {
    apiWorkflowByPathOrFile.set(workflow.path, workflow);
    apiWorkflowByPathOrFile.set(path.basename(workflow.path), workflow);
  }

  const runsByWorkflowId = new Map<number, GithubWorkflowRun[]>();
  const runsByWorkflowPath = new Map<string, GithubWorkflowRun[]>();
  for (const run of snapshot.runs) {
    addToIndex(runsByWorkflowId, run.workflowId, run);
    if (run.workflowPath) {
      addToIndex(runsByWorkflowPath, run.workflowPath, run);
      addToIndex(runsByWorkflowPath, path.basename(run.workflowPath), run);
    }
  }

  const workflows = definitions.map((definition) => {
    const apiWorkflow =
      apiWorkflowByPathOrFile.get(definition.path) ??
      apiWorkflowByPathOrFile.get(definition.id);
    const matchedRuns = apiWorkflow
      ? (runsByWorkflowId.get(apiWorkflow.id) ?? [])
      : (runsByWorkflowPath.get(definition.path) ??
        runsByWorkflowPath.get(definition.id) ??
        []);
    const latestRun = matchedRuns[0];

    return {
      ...definition,
      actionsState: githubWorkflowState(apiWorkflow?.state),
      actionsWorkflowId: apiWorkflow?.id ?? null,
      actionsHtmlUrl: apiWorkflow?.htmlUrl ?? null,
      recentRunsCount: matchedRuns.length,
      lastRunStatus: latestRun?.status ?? null,
      lastRunConclusion: latestRun?.conclusion ?? null,
      lastRunCreatedAt: latestRun?.createdAt ?? null,
      lastRunHtmlUrl: latestRun?.htmlUrl ?? null
    };
  });
  return { workflows };
}

/**
 * Observed GitHub Actions workflow *definitions* parsed from
 * `.github/workflows/*.yml` along with authoritative read-only GitHub Actions
 * runtime state and bounded recent run statistics.
 *
 * Runtime Control API owns authentication and validates configured
 * AUTODEV_GITHUB_REPOSITORY (or standard runner GITHUB_REPOSITORY). Public
 * repositories may be read without a GitHub token; private repositories need
 * a server-side AUTODEV_GITHUB_TOKEN with read-only Actions permission.
 * Returns an explicit unavailable/invalid state when configuration or API
 * access is absent/invalid.
 */
export async function githubWorkflowsView(
  repositoryRoot?: string,
  options: GithubWorkflowsViewOptions = {}
): Promise<Record<string, unknown>> {
  const root = repositoryRoot ?? DEFAULT_REPO_ROOT;
  const catalog = new GithubWorkflowRepository(root).readWorkflowCatalog();

  if (catalog.status !== "valid") {
    return unavailableGithubResponse({
      catalogStatus: catalog.status,
      totalWorkflows: null,
      workflows: [],
      runtimeStatus: catalog.status === "invalid" ? "invalid" : "unavailable",
      runtimeMessage:
        catalog.status === "invalid"
          ? "Workflow YAML definitions under .github/workflows could not be parsed."
          : ".github/workflows directory is missing or unreadable.",
      repository: null
    });
  }

  const binding = resolveGithubRuntimeBinding(root, catalog.workflows, options);
  if (!binding.available) {
    return binding.response;
  }

  const adapter =
    options.actionsAdapter ??
    githubActionsAdapterOverride ??
    new GithubActionsAdapter();

  const isTestOverride = Boolean(
    options.actionsAdapter || githubActionsAdapterOverride
  );
  const cacheKey = `${binding.owner}/${binding.repo}:${binding.token ? "auth" : "anon"}`;
  const now = Date.now();
  const cached = isTestOverride
    ? undefined
    : GITHUB_SNAPSHOT_CACHE.get(cacheKey);

  try {
    let snapshot: GithubActionsRuntimeSnapshot;
    if (cached && now - cached.timestamp < GITHUB_SNAPSHOT_CACHE_TTL_MS) {
      snapshot = cached.snapshot;
    } else {
      snapshot = await adapter.fetchRuntimeSnapshot(
        binding.owner,
        binding.repo,
        binding.token,
        { limit: 30 }
      );
      if (!isTestOverride) {
        // A slow external Actions read must not age out its own cache entry
        // before the snapshot is available to the next Console request.
        GITHUB_SNAPSHOT_CACHE.set(cacheKey, {
          timestamp: Date.now(),
          snapshot
        });
      }
    }
    const projected = projectGithubWorkflows(catalog.workflows, snapshot);

    return {
      schema: GITHUB_CONTROL_API_SCHEMA,
      source: GITHUB_WORKFLOW_YAML_SOURCE,
      readOnly: true,
      catalogStatus: "valid",
      totalWorkflows: catalog.workflows.length,
      workflows: projected.workflows,
      runtimeFactsAvailable: true,
      runtimeStatus: "available",
      runtimeMessage: null,
      repository: binding.repository,
      stats: snapshot.stats,
      recentRuns: snapshot.runs
    } satisfies ControlApiGithubResponse;
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const isAuthFailure =
      error instanceof GithubActionsApiError && error.status === 401;

    return unavailableGithubResponse({
      catalogStatus: "valid",
      totalWorkflows: binding.unavailableWorkflows.length,
      workflows: binding.unavailableWorkflows,
      runtimeStatus: isAuthFailure ? "invalid" : "unavailable",
      runtimeMessage: `GitHub Actions API error: ${rawMessage}`,
      repository: binding.repository
    });
  }
}
