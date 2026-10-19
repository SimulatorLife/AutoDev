/** Role-scoped environment for MCP servers started by provider bridges. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { readRuntimeSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface RoleMcpEnvironmentContext {
  readonly role: string | null;
  readonly server: string;
  readonly requestId?: string | null;
  readonly workspaceId?: string | null;
  readonly workspaceRoot?: string | null;
  readonly repositoryRoot: string;
  readonly codeHome: string;
}

/**
 * Builds only the environment variables declared for this role/server pair.
 * Playtest credentials are never returned: the MCP process reads the dedicated
 * credential from the protected CODEX_HOME secret file itself.
 */
export function roleMcpEnvironment(
  context: RoleMcpEnvironmentContext,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const role = context.role?.trim().toLowerCase() ?? "";
  const allowed = roleContract(role).mcpEnvVars?.[context.server] ?? [];
  if (allowed.length === 0) return {};
  const allowedSet = new Set(allowed);
  const values: Record<string, string> = {};
  for (const name of allowed) {
    const value = env[name]?.trim();
    if (value) values[name] = value;
  }
  const setAllowed = (name: string, value: string | null | undefined): void => {
    if (allowedSet.has(name) && value?.trim()) values[name] = value.trim();
  };

  setAllowed("HOME", env.HOME?.trim() || homedir());
  setAllowed("CODEX_HOME", context.codeHome);
  setAllowed("AUTODEV_REPO_ROOT", context.repositoryRoot);
  setAllowed("AUTODEV_NODE_BIN", env.AUTODEV_NODE_BIN || process.execPath);

  if (context.server === "playtest" && role === "playtester") {
    const secretEnvironment = { ...env, CODEX_HOME: context.codeHome };
    if (
      !readRuntimeSecret(
        "AUTODEV_PLAYTEST_CONTROL_API_TOKEN",
        secretEnvironment
      )
    ) {
      throw new Error(
        "The trusted Playtester MCP runner credential is unavailable in the Runtime secret store."
      );
    }
    const workspaceId =
      env.AUTODEV_PLAYTEST_WORKSPACE_ID?.trim() || context.workspaceId?.trim();
    const workspaceRoot =
      env.AUTODEV_PLAYTEST_REPOSITORY_ROOT?.trim() ||
      context.workspaceRoot?.trim();
    if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new Error(
        "The Playtester MCP requires a trusted canonical workspace identity."
      );
    }
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new Error(
        "The Playtester MCP requires a trusted absolute workspace repository root."
      );
    }
    const requestId = REQUEST_ID_PATTERN.test(context.requestId ?? "")
      ? context.requestId!.trim()
      : randomUUID();
    const actorId = `provider-playtester-${randomUUID()}`;
    const taskId = `provider-task-${requestId}`;
    const runId = `provider-run-${requestId}`;
    const apiPort = env.AUTODEV_CONTROL_API_LISTEN_PORT?.trim() || "4101";
    setAllowed("AUTODEV_PLAYTEST_WORKSPACE_ID", workspaceId);
    setAllowed("AUTODEV_PLAYTEST_ROLE", "playtester");
    setAllowed("AUTODEV_PLAYTEST_ACTOR_ID", actorId);
    setAllowed("AUTODEV_PLAYTEST_TASK_ID", taskId);
    setAllowed("AUTODEV_PLAYTEST_RUN_ID", runId);
    setAllowed("AUTODEV_PLAYTEST_REPOSITORY_ROOT", workspaceRoot);
    setAllowed(
      "AUTODEV_CONTROL_API_BASE_URL",
      env.AUTODEV_CONTROL_API_BASE_URL?.trim() || `http://127.0.0.1:${apiPort}`
    );
    setAllowed(
      "AUTODEV_CONTROL_API_LISTEN_HOST",
      env.AUTODEV_CONTROL_API_LISTEN_HOST
    );
    setAllowed("AUTODEV_CONTROL_API_LISTEN_PORT", apiPort);
    setAllowed(
      "AUTODEV_PLAYTEST_CONTROL_API_ACTOR",
      env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR?.trim() ||
        "autodev-playtester-runtime"
    );
    setAllowed("AUTODEV_PLAYTEST_CONTROL_API_ROLE", "playtester");
    setAllowed(
      "AUTODEV_OPENLIT_SECRET_FILE",
      env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
        path.join(context.codeHome, "openlit-secrets.env")
    );
    delete values.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
  }

  return Object.fromEntries(
    allowed.flatMap((name) =>
      values[name] === undefined ? [] : [[name, values[name]!]]
    )
  );
}
