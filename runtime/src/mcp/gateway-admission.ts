/**
The shared MCP gateway's local admission: its private files and how a backend
is provisioned for an admitted workspace.

Local clients reach `/local/<role>/<server>/mcp` with the local key and attach
a session grant (`session-grant.ts`) to every call; the backend pool verifies
the grant with the admission secret and starts the role's server confined to
the grant's workspace through `provision`. The gateway service and its
install-time probe build the same admission from the same files, so the probe
exercises exactly what the service runs.
*/
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { autodevHome } from "../shared/autodev-home.ts";
import { roleContract } from "../shared/execution-contract.ts";
import {
  assertPrivateDirectory,
  ensurePrivateDirectory,
  privateRead
} from "../shared/private-service-files.ts";
import {
  MCP_FILESYSTEM_READ_ONLY_ENV,
  MCP_SERVER_XACPX
} from "../shared/tool-names.ts";
import type { GatewayAdmission } from "./chatgpt-backend-pool.ts";
import { externalMcpBackend } from "./chatgpt-filesystem-sandbox.ts";
import {
  admitWorkspace,
  issueSessionGrant,
  newGrantSession
} from "./session-grant.ts";

export const MCP_GATEWAY_DIRECTORY = "mcp-gateway";

export function mcpGatewayDirectory(codexHome: string): string {
  return path.join(codexHome, MCP_GATEWAY_DIRECTORY);
}

/**
The gateway's local admission files: the key every local surface requires
(never given to the ChatGPT tunnel) and the secret session grants are signed
with.
*/
export function localAdmissionPaths(codexHome: string): {
  keyFile: string;
  secretFile: string;
} {
  const directory = mcpGatewayDirectory(codexHome);
  return {
    keyFile: path.join(directory, "local.key"),
    secretFile: path.join(directory, "admission.key")
  };
}

const ADMISSION_KEY = /^[0-9a-f]{64}$/u;

function readAdmissionKey(file: string): string {
  const value = privateRead(file);
  if (!ADMISSION_KEY.test(value)) {
    throw new Error("Missing or invalid private gateway admission key.");
  }
  return value;
}

/**
The keys are usable only in the gateway's owned private directory.
*/
export function readLocalAdmission(
  codexHome: string
): { key: string; secret: string } | null {
  try {
    assertPrivateDirectory(mcpGatewayDirectory(codexHome));
    const files = localAdmissionPaths(codexHome);
    return {
      key: readAdmissionKey(files.keyFile),
      secret: readAdmissionKey(files.secretFile)
    };
  } catch {
    return null;
  }
}

/**
Generate missing keys exclusively; never rotate or repair an existing key silently.
*/
export function ensureLocalAdmission(codexHome: string): void {
  ensurePrivateDirectory(mcpGatewayDirectory(codexHome));
  const files = localAdmissionPaths(codexHome);
  for (const file of [files.keyFile, files.secretFile]) {
    try {
      lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        writeFileSync(file, randomBytes(32).toString("hex") + "\n", {
          mode: 0o600,
          flag: "wx"
        });
      } catch (creationError) {
        if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw creationError;
        }
      }
    }
    readAdmissionKey(file);
  }
}

/**
The local gateway URL of one role's server, from the installed gateway's
state; null when no gateway is installed.
*/
export function localSurfaceUrl(
  codexHome: string,
  role: string,
  server: string
): URL | null {
  try {
    if (
      !/^[a-z0-9-]+$/u.test(role) ||
      !/^[a-zA-Z0-9_.-]+$/u.test(server) ||
      server === "." ||
      server === ".."
    )
      return null;
    const directory = mcpGatewayDirectory(codexHome);
    assertPrivateDirectory(directory);
    const { mcpPort } = JSON.parse(
      privateRead(path.join(directory, "gateway.json"))
    ) as { mcpPort?: unknown };
    return typeof mcpPort === "number" &&
      Number.isSafeInteger(mcpPort) &&
      mcpPort > 0 &&
      mcpPort <= 65_535
      ? new URL(
          `http://127.0.0.1:${String(mcpPort)}/local/${role}/${server}/mcp`
        )
      : null;
  } catch {
    return null;
  }
}

/**
Admit a launch directory for one role's session and sign its grant. The
directory is trusted launch context: the client's own working directory, or
the workspace the launching Runtime resolved for its session.
*/
export function issueLaunchGrant(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly launchDirectory: string;
  readonly role: string;
  readonly session?: string;
}): { grant: string; renew(): string } {
  const home = options.env.HOME?.trim() || homedir();
  const codexHome = options.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const admission = readLocalAdmission(codexHome);
  if (!admission)
    throw new Error(
      "The AutoDev MCP gateway is not installed; run `pnpm run install:autodev`."
    );
  const admitted = admitWorkspace(options.launchDirectory, {
    home,
    configuration: [codexHome, autodevHome(options.env)]
  });
  if ("refused" in admitted)
    throw new Error(`AutoDev MCP is unavailable here: ${admitted.refused}`);
  const claims = {
    workspace: admitted.workspace,
    role: options.role,
    ...(options.session
      ? { session: options.session, runtimeSession: true as const }
      : { session: newGrantSession() })
  };
  const renew = () => issueSessionGrant(admission.secret, claims);
  return { grant: renew(), renew };
}

export interface GatewayAdmissionContext {
  readonly repositoryRoot: string;
  readonly node: string;
  readonly home: string;
  readonly codexHome: string;
  /**
  The same reviewed workspace used by install-time policy discovery.
  */
  readonly catalogueWorkspace: string;
  /**
  The installed Runtime source tree the backends run from.
  */
  readonly runtimeSource: string;
  /**
  Builds a server's confined launch; defaults to the macOS sandbox.
  */
  readonly backend?: typeof externalMcpBackend;
}

/**
The admission the backend pool enforces. A role's server in an admitted
workspace runs confined to that workspace under the role's contract; a
delegation backend acts as its own coordinator for the one session it serves.
*/
export function createGatewayAdmission(
  context: GatewayAdmissionContext
): GatewayAdmission {
  const admission = readLocalAdmission(context.codexHome);
  if (!admission)
    throw new Error("The MCP gateway's local admission files are missing");
  // Resolve once, not on each lazy provision. An installer can repoint
  // the installed src symlink while this gateway is still serving traffic.
  const runtimeSource = realpathSync(context.runtimeSource);
  // The separate catalogue controller cannot execute client tool calls.
  // Reuse the reviewed policy-discovery workspace: the gateway's own
  // private directory is explicitly inaccessible to confined backends.
  return {
    secret: admission.secret,
    catalogueWorkspace: context.catalogueWorkspace,
    provision(server, role, workspace, session) {
      const isReadOnly = roleContract(role).readOnly === true;
      const backend = (context.backend ?? externalMcpBackend)(
        server,
        context.repositoryRoot,
        workspace,
        context.node,
        context.home,
        context.codexHome,
        { role, readOnly: isReadOnly, runtimeSource }
      );
      return {
        server,
        command: backend.command,
        args: backend.args,
        cwd: workspace,
        env: {
          AUTODEV_AGENT_ROLE: role,
          AUTODEV_MCP_WORKSPACE: workspace,
          AUTODEV_XACPX_WORKSPACE: workspace,
          ...(isReadOnly && { [MCP_FILESYSTEM_READ_ONLY_ENV]: "1" }),
          ...(server === MCP_SERVER_XACPX && {
            AUTODEV_XACPX_COORDINATOR_SESSION: `local:${role}:${path.basename(workspace) || "workspace"}:${session ?? "catalogue"}`
          })
        }
      };
    }
  };
}
