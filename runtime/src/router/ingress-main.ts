#!/usr/bin/env node

/**
Stable launchd entrypoint. Install this file and its local ingress modules
in an immutable release; never run it from a mutable checkout in production.
Worker code is loaded only in independently spawned child processes.
*/
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";

import { RouterIngress } from "./ingress.ts";
import { RouterIngressSupervisor } from "./ingress-control.ts";

export async function startRouterIngressProcess(
  environment: NodeJS.ProcessEnv = process.env
): Promise<{ ingress: RouterIngress; supervisor: RouterIngressSupervisor }> {
  const controlSocket = environment.AUTODEV_ROUTER_INGRESS_CONTROL_SOCKET;
  const controlToken = environment.AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN;
  const releasesDirectory = environment.AUTODEV_ROUTER_RELEASES_DIRECTORY;
  if (!controlSocket || !controlToken || !releasesDirectory) {
    throw new Error(
      "Ingress requires CONTROL_SOCKET, CONTROL_TOKEN and RELEASES_DIRECTORY"
    );
  }
  const port = Number(environment.CODEX_MODEL_ROUTER_PORT ?? "4100");
  const host = environment.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Invalid ingress public port");
  }
  const drainTimeout = environment.AUTODEV_ROUTER_INGRESS_DRAIN_MS;
  const workerShutdownTimeout = environment.AUTODEV_ROUTER_INGRESS_WORKER_SHUTDOWN_MS;
  const ingress = new RouterIngress({
    ...(drainTimeout !== undefined && { retirementDrainTimeoutMs: Number(drainTimeout) })
  });
  const supervisor = new RouterIngressSupervisor({
    ingress,
    controlSocket,
    controlToken,
    releasesDirectory,
    ...(workerShutdownTimeout !== undefined && { workerShutdownTimeoutMs: Number(workerShutdownTimeout) })
  });
  await supervisor.listen();
  try {
    await ingress.listen(port, host);
  } catch (error) {
    supervisor.controlServer.close();
    throw error;
  }
  return { ingress, supervisor };
}

if (isEntryPoint(import.meta.url)) {
  void startRouterIngressProcess().catch((error: unknown) => {
    process.stderr.write(
      "Ingress startup failed: " +
        (error instanceof Error ? error.message : String(error)) +
        "\n"
    );
    process.exitCode = 1;
  });
}
