#!/usr/bin/env node
import { fileURLToPath } from "node:url";

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
import { servePlaytestMcpStdio } from "./stdio.ts";

export interface PlaytestStdioConfiguration {
  readonly workspaceId: string;
  readonly role: string;
  readonly actor: string;
  readonly taskId: string;
  readonly runId: string;
  readonly repositoryRoot: string | null;
}

export function assertPlaytestStdioSessionBinding(
  config: PlaytestStdioConfiguration,
  catalog: WorkspaceCatalogRead,
  configuredRoles: ReadonlySet<string>
): void {
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
  if (
    !configuredRoles.has(config.role) ||
    (workspace.agentRoles !== null &&
      !workspace.agentRoles.includes(config.role))
  ) {
    throw new Error(
      "The configured playtesting role is invalid for this workspace."
    );
  }
}

const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const SESSION_VALUE_PATTERN = /^[A-Za-z0-9@._:-]{1,256}$/u;

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

  return {
    workspaceId,
    role,
    actor,
    taskId,
    runId,
    repositoryRoot
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
    repositoryRoot: config.repositoryRoot
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
    new Set(configRepository.loadAgents().map((agent) => agent.id))
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
  artifactStoreForWorkspace(config.workspaceId);

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
