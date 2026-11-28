import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
The native XACPX MCP client is a projection of the Router's authority, not
a second daemon. Give each launcher one immutable workspace/role catalogue
and its own empty vendor state. Shared read-modify-write files can lose
workspace registrations between simultaneous launches; old vendor sessions
can also conflict with a Router-owned coordinator identity.
*/
export async function withXacpxLaunchEnvironment<T>(
  workspace: string,
  environment: NodeJS.ProcessEnv,
  delegatedRoles: readonly string[],
  run: (environment: NodeJS.ProcessEnv) => T | Promise<T>
): Promise<T> {
  const physicalWorkspace = realpathSync(workspace);
  const directory = realpathSync(mkdtempSync("/tmp/autodev-xacpx-client-"));
  try {
    const config = path.join(directory, "config.json");
    const state = path.join(directory, "state.json");
    const agents = Object.fromEntries(
      delegatedRoles.map((role) => [role, { driver: "codex" }])
    );
    // The vendor CLI uses the workspace key for coordinator registration.
    // Use the canonical absolute path, not an alias that loses confinement.
    writeFileSync(
      config,
      JSON.stringify(
        {
          transport: { type: "acpx-bridge" },
          channel: { type: "weixin", replyMode: "verbose" },
          agents,
          workspaces: { [physicalWorkspace]: { cwd: physicalWorkspace } }
        },
        null,
        2
      ) + "\n",
      { mode: 0o600, flag: "wx" }
    );
    return await run({
      ...environment,
      AUTODEV_XACPX_WORKSPACE: physicalWorkspace,
      XACPX_CONFIG: config,
      XACPX_STATE: state
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
