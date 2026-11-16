#!/usr/bin/env node

/**
 * Stable launchd entrypoint. Install this file and its local ingress modules
 * in an immutable release; never run it from a mutable checkout in production.
 * Worker code is loaded only in independently spawned child processes.
 */
import { RouterIngress } from "./ingress.ts";
import { RouterIngressSupervisor } from "./ingress-control.ts";
import { pathToFileURL } from "node:url";

export async function startRouterIngressProcess(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ingress: RouterIngress; supervisor: RouterIngressSupervisor }> {
  const controlSocket = env.AUTODEV_ROUTER_INGRESS_CONTROL_SOCKET;
  const controlToken = env.AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN;
  const releasesDirectory = env.AUTODEV_ROUTER_RELEASES_DIRECTORY;
  if (!controlSocket || !controlToken || !releasesDirectory) {
    throw new Error(
      "Ingress requires CONTROL_SOCKET, CONTROL_TOKEN and RELEASES_DIRECTORY"
    );
  }
  const port = Number(env.CODEX_MODEL_ROUTER_PORT ?? "4100");
  const host = env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid ingress public port");
  }
  const ingress = new RouterIngress();
  const supervisor = new RouterIngressSupervisor({
    ingress,
    controlSocket,
    controlToken,
    releasesDirectory
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startRouterIngressProcess().catch((error: unknown) => {
    process.stderr.write(
      "Ingress startup failed: " +
        (error instanceof Error ? error.message : String(error)) +
        "\n"
    );
    process.exitCode = 1;
  });
}
