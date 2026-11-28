import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { XacpxSessionManager } from "./manager.ts";
import { startXacpxOrchestrationIpcServer } from "./orchestration-ipc.ts";

/**
Install-time discovery must never register a coordinator against the live
Router. Both gateway probes use this private, disposable instance of the
canonical orchestration IPC server. A short physical path also fits macOS's
Unix socket path limit.
*/
export async function withXacpxDiscoveryProbe<T>(
  workspace: string,
  repositoryRoot: string,
  environment: Record<string, string>,
  run: (environment: Record<string, string>) => Promise<T>
): Promise<T> {
  const directory = realpathSync(mkdtempSync("/tmp/autodev-xacpx-probe-"));
  try {
    const socketPath = path.join(directory, "ipc.sock");
    const ipc = await startXacpxOrchestrationIpcServer({
      socketPath,
      manager: new XacpxSessionManager(),
      authorizedWorkspaceRoot: workspace,
      repositoryRoot
    });
    try {
      return await run({
        ...environment,
        XACPX_ORCHESTRATION_SOCKET: socketPath,
        AUTODEV_XACPX_WORKSPACE: workspace,
        AUTODEV_XACPX_COORDINATOR_SESSION: "gateway:policy-probe"
      });
    } finally {
      await ipc.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
