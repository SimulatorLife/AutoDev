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
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { autodevHome } from "../shared/autodev-home.ts";
import { roleContract } from "../shared/execution-contract.ts";
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

function readPrivate(file: string): string | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null;
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
The local key and admission secret, or null when either is missing or exposed.
*/
export function readLocalAdmission(
  codexHome: string
): { key: string; secret: string } | null {
  const files = localAdmissionPaths(codexHome);
  const key = readPrivate(files.keyFile);
  const secret = readPrivate(files.secretFile);
  return key && secret ? { key, secret } : null;
}

/**
Create any missing admission file; existing keys are kept.
*/
export function ensureLocalAdmission(codexHome: string): void {
  const files = localAdmissionPaths(codexHome);
  mkdirSync(mcpGatewayDirectory(codexHome), { recursive: true, mode: 0o700 });
  for (const file of [files.keyFile, files.secretFile]) {
    if (readPrivate(file)) continue;
    writeFileSync(file, randomBytes(32).toString("hex") + "\n", {
      mode: 0o600
    });
    chmodSync(file, 0o600);
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
    const { mcpPort } = JSON.parse(
      readFileSync(
        path.join(mcpGatewayDirectory(codexHome), "gateway.json"),
        "utf8"
      )
    ) as { mcpPort?: unknown };
    return Number.isSafeInteger(mcpPort)
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
  /** The same reviewed workspace used by install-time policy discovery. */
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
        { role, readOnly: isReadOnly, runtimeSource: context.runtimeSource }
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
