#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import {
  assertPlaytestCrossSessionMetricAggregation,
  type PlaytestCrossSessionMetricAggregation,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS
} from "@simulatorlife/autodev-core";
import {
  ConfigRepository,
  type WorkspaceCatalogRead
} from "@simulatorlife/autodev-data";
import { PlaytestRepository } from "@simulatorlife/autodev-data/playtesting";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";

import { errorMessage } from "../shared/error-message.ts";
import { writeErrorLine } from "../shared/output.ts";
import { PlaytestArtifactStore } from "./artifact-store.ts";
import { playtestControlApiRunClientFromEnvironment } from "./control-api-run-control-client.ts";
import {
  createPlaytestMcpServer,
  type PlaytestMcpSession,
  type PlaytestMcpSessionProvider
} from "./mcp.ts";
import { reconcilePendingPlaytestPackets } from "./packet-artifact-reconciliation.ts";
import { servePlaytestMcpStdio } from "./stdio.ts";

export interface PlaytestStdioConfiguration {
  readonly workspaceId: string;
  readonly role: string;
  readonly actor: string;
  readonly taskId: string;
  readonly runId: string;
  readonly repositoryRoot: string | null;
  readonly analysisId?: string;
  readonly selectedEpisodeIds?: readonly string[];
  readonly analysisKind?: "confirmatory" | "discovery";
  readonly metricAggregation?: PlaytestCrossSessionMetricAggregation;
}

export function assertPlaytestStdioSessionBinding(
  config: PlaytestStdioConfiguration,
  catalog: WorkspaceCatalogRead,
  configuredRoles: ReadonlySet<string>
): void {
  if (
    config.role === ANALYST_ROLE &&
    (!config.analysisId ||
      !SESSION_VALUE_PATTERN.test(config.analysisId) ||
      !isValidSelectedEpisodeIds(config.selectedEpisodeIds) ||
      (config.analysisKind !== "confirmatory" &&
        config.analysisKind !== "discovery") ||
      (config.analysisKind === "confirmatory" && !config.metricAggregation) ||
      (config.analysisKind === "discovery" &&
        config.metricAggregation !== undefined))
  ) {
    throw new Error(ANALYST_SELECTION_ERROR);
  }
  if (config.role === ANALYST_ROLE && config.analysisKind === "confirmatory") {
    try {
      assertPlaytestCrossSessionMetricAggregation(
        config.metricAggregation,
        config.workspaceId,
        config.analysisId!,
        config.selectedEpisodeIds!
      );
    } catch {
      throw new Error(ANALYST_SELECTION_ERROR);
    }
  }
  if (catalog.status !== "valid") {
    throw new Error("The canonical workspace catalog is unavailable.");
  }
  const workspace = catalog.workspaces.find(
    (entry) => entry.id === config.workspaceId
  );
  if (!workspace) {
    throw new Error(
      "The configured workspace is not in the canonical catalog."
    );
  }
  const privilegedControlRole = PRIVILEGED_CONTROL_ROLES.has(config.role);
  if (
    (!configuredRoles.has(config.role) && !privilegedControlRole) ||
    (!privilegedControlRole &&
      workspace.agentRoles !== null &&
      !workspace.agentRoles.includes(config.role))
  ) {
    throw new Error(
      "The configured playtesting role is invalid for this workspace."
    );
  }
}

const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const SESSION_VALUE_PATTERN = /^[A-Za-z0-9@._:-]{1,256}$/u;
const EPISODE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const ANALYST_ROLE = "playtest-analyst" as const;
const ANALYST_SELECTION_ERROR =
  "The trusted analyst session selection is missing or invalid.";
const PRIVILEGED_CONTROL_ROLES = new Set(["root", "operator"]);

function requiredSessionValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  const valid =
    key === "AUTODEV_PLAYTEST_WORKSPACE_ID"
      ? value !== undefined && WORKSPACE_ID_PATTERN.test(value)
      : value !== undefined && SESSION_VALUE_PATTERN.test(value);
  if (!value || !valid) {
    throw new Error(
      "Required trusted playtesting session context is missing or invalid."
    );
  }
  return value;
}

function isValidSelectedEpisodeIds(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= PLAYTESTS_MAX_ANALYSIS_SESSIONS &&
    value.every(
      (episodeId) =>
        typeof episodeId === "string" && EPISODE_ID_PATTERN.test(episodeId)
    ) &&
    new Set(value).size === value.length
  );
}

function selectedEpisodeIdsFromEnvironment(
  env: NodeJS.ProcessEnv
): readonly string[] {
  const raw = env.AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS?.trim();
  const maximumEncodedLength =
    2 +
    PLAYTESTS_MAX_ANALYSIS_SESSIONS * 258 +
    (PLAYTESTS_MAX_ANALYSIS_SESSIONS - 1);
  if (!raw || raw.length > maximumEncodedLength) {
    throw new Error(ANALYST_SELECTION_ERROR);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(ANALYST_SELECTION_ERROR);
  }
  if (!isValidSelectedEpisodeIds(parsed)) {
    throw new Error(ANALYST_SELECTION_ERROR);
  }
  return parsed;
}

function metricAggregationFromEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceId: string;
  readonly analysisId: string;
  readonly episodeIds: readonly string[];
}): PlaytestCrossSessionMetricAggregation {
  const raw = input.env.AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION?.trim();
  if (!raw || new TextEncoder().encode(raw).byteLength > 64 * 1024) {
    throw new Error(ANALYST_SELECTION_ERROR);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    assertPlaytestCrossSessionMetricAggregation(
      parsed,
      input.workspaceId,
      input.analysisId,
      input.episodeIds
    );
  } catch {
    throw new Error(ANALYST_SELECTION_ERROR);
  }
  return parsed;
}

export function playtestStdioConfiguration(
  env: NodeJS.ProcessEnv = process.env
): PlaytestStdioConfiguration {
  const workspaceId = requiredSessionValue(
    env,
    "AUTODEV_PLAYTEST_WORKSPACE_ID"
  );
  const role = requiredSessionValue(env, "AUTODEV_PLAYTEST_ROLE");
  const actor = requiredSessionValue(env, "AUTODEV_PLAYTEST_ACTOR_ID");
  const taskId = requiredSessionValue(env, "AUTODEV_PLAYTEST_TASK_ID");
  const runId = requiredSessionValue(env, "AUTODEV_PLAYTEST_RUN_ID");
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("The trusted playtesting workspace identity is invalid.");
  }
  const repositoryRoot = env.AUTODEV_PLAYTEST_REPOSITORY_ROOT?.trim() || null;
  const analysisId =
    role === ANALYST_ROLE
      ? requiredSessionValue(env, "AUTODEV_PLAYTEST_ANALYSIS_ID")
      : undefined;
  const selectedEpisodeIds =
    role === ANALYST_ROLE ? selectedEpisodeIdsFromEnvironment(env) : undefined;
  const analysisKind =
    role === ANALYST_ROLE
      ? env.AUTODEV_PLAYTEST_ANALYSIS_KIND?.trim()
      : undefined;
  if (
    role === ANALYST_ROLE &&
    analysisKind !== "confirmatory" &&
    analysisKind !== "discovery"
  ) {
    throw new Error(ANALYST_SELECTION_ERROR);
  }
  const metricAggregation =
    role === ANALYST_ROLE && analysisKind === "confirmatory"
      ? metricAggregationFromEnvironment({
          env,
          workspaceId,
          analysisId: analysisId!,
          episodeIds: selectedEpisodeIds!
        })
      : undefined;

  return {
    workspaceId,
    role,
    actor,
    taskId,
    runId,
    repositoryRoot,
    ...(analysisId === undefined ? {} : { analysisId }),
    ...(selectedEpisodeIds === undefined ? {} : { selectedEpisodeIds }),
    ...(analysisKind === undefined
      ? {}
      : { analysisKind: analysisKind as "confirmatory" | "discovery" }),
    ...(metricAggregation === undefined ? {} : { metricAggregation })
  };
}

export function playtestMcpSessionProvider(
  config: PlaytestStdioConfiguration
): PlaytestMcpSessionProvider {
  const session: PlaytestMcpSession = {
    workspaceId: config.workspaceId,
    role: config.role,
    actor: config.actor,
    taskId: config.taskId,
    runId: config.runId,
    repositoryRoot: config.repositoryRoot,
    ...(config.analysisId === undefined
      ? {}
      : { analysisId: config.analysisId }),
    ...(config.selectedEpisodeIds === undefined
      ? {}
      : { selectedEpisodeIds: config.selectedEpisodeIds }),
    ...(config.analysisKind === undefined
      ? {}
      : { analysisKind: config.analysisKind }),
    ...(config.metricAggregation === undefined
      ? {}
      : { metricAggregation: config.metricAggregation })
  };
  return {
    current: () => session
  };
}

export async function main(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = playtestStdioConfiguration(env);
  const sessionProvider = playtestMcpSessionProvider(config);
  const configRepository = new ConfigRepository(
    config.repositoryRoot ?? undefined
  );
  const catalog = configRepository.readWorkspaceCatalog();
  assertPlaytestStdioSessionBinding(
    config,
    catalog,
    new Set(configRepository.loadAgentRoles())
  );

  const approvalRepository = new WorkspacePlaytestApprovalRepository();
  // Read once to fail closed on corrupt/unreadable approval storage, but an
  // absent or revoked approval is a capabilities state, not a server error.
  approvalRepository.read(config.workspaceId);
  const playtestRepository = new PlaytestRepository();

  const artifactStores = new Map<string, PlaytestArtifactStore>();
  const artifactStoreForWorkspace = (
    workspaceId: string
  ): PlaytestArtifactStore => {
    let store = artifactStores.get(workspaceId);
    if (!store) {
      store = new PlaytestArtifactStore({ workspaceId });
      artifactStores.set(workspaceId, store);
    }
    return store;
  };
  const artifactStore = artifactStoreForWorkspace(config.workspaceId);
  await reconcilePendingPlaytestPackets({
    workspaceId: config.workspaceId,
    artifacts: artifactStore,
    repository: playtestRepository
  });

  const server = createPlaytestMcpServer({
    sessionProvider,
    artifactStoreForWorkspace,
    playtestRunControl: playtestControlApiRunClientFromEnvironment(env),
    approvalRepository,
    playtestRepository,
    readWorkspaceCatalog: () => configRepository.readWorkspaceCatalog()
  });

  await servePlaytestMcpStdio(server);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeErrorLine("playtest-mcp: " + errorMessage(error));
    process.exitCode = 1;
  });
}
