#!/usr/bin/env node

/**
Stable launchd entrypoint. Install this file and its local ingress modules
in an immutable release; never run it from a mutable checkout in production.
Worker code is loaded only in independently spawned child processes.
*/
import { createServer, type Server } from "node:http";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { configuredControlApiListener } from "./control-plane-config.ts";
import { RouterIngress } from "./ingress.ts";
import { RouterIngressSupervisor } from "./ingress-control.ts";
import { recordRouterIngressEvent } from "./telemetry.ts";
import { resolvePublicXacpxSocketPath } from "./xacpx-ipc-proxy.ts";

export interface RouterIngressProcessHandle {
  ingress: RouterIngress;
  supervisor: RouterIngressSupervisor;
  controlApiServer: Server | null;
  close(): Promise<void>;
}

export async function startRouterIngressProcess(
  environment: NodeJS.ProcessEnv = process.env
): Promise<RouterIngressProcessHandle> {
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
  // Every configuration error is raised before anything listens, so a bad
  // setting cannot leave the supervisor's control socket open behind it.
  const controlListener = configuredControlApiListener(port, environment);
  const drainTimeout = environment.AUTODEV_ROUTER_INGRESS_DRAIN_MS;
  const workerShutdownTimeout =
    environment.AUTODEV_ROUTER_INGRESS_WORKER_SHUTDOWN_MS;
  const configuredXacpx =
    environment.AUTODEV_XACPX_ORCHESTRATION_SOCKET?.trim();
  const xacpxSocketPath =
    configuredXacpx === "none"
      ? null
      : resolvePublicXacpxSocketPath(undefined, environment);
  const ingress = new RouterIngress({
    onEvent: recordRouterIngressEvent,
    ...(drainTimeout !== undefined && {
      retirementDrainTimeoutMs: Number(drainTimeout)
    })
  });
  const supervisor = new RouterIngressSupervisor({
    ingress,
    controlSocket,
    controlToken,
    releasesDirectory,
    xacpxSocketPath,
    ...(workerShutdownTimeout !== undefined && {
      workerShutdownTimeoutMs: Number(workerShutdownTimeout)
    })
  });
  await supervisor.listen();

  let controlApiServer: Server | null = null;
  try {
    await ingress.listen(port, host);
    if (controlListener) {
      const boundControlApiServer = createServer((request, response) =>
        ingress.forwardActiveOnly(request, response)
      );
      boundControlApiServer.keepAliveTimeout = 65_000;
      boundControlApiServer.headersTimeout = 66_000;
      await new Promise<void>((resolve, reject) => {
        boundControlApiServer.once("error", reject);
        boundControlApiServer.listen(
          controlListener.port,
          controlListener.host,
          () => {
            boundControlApiServer.off("error", reject);
            resolve();
          }
        );
      });
      controlApiServer = boundControlApiServer;
      writeErrorLine(
        `AutoDev Control API ingress listening at http://${controlListener.host}:${controlListener.port}`
      );
    }
  } catch (error) {
    if (controlApiServer?.listening) {
      controlApiServer.closeAllConnections();
      await new Promise<void>((resolve) =>
        controlApiServer!.close(() => resolve())
      );
    }
    if (ingress.server.listening) {
      ingress.server.closeAllConnections();
      await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
    }
    await supervisor.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (controlApiServer?.listening) {
      controlApiServer.closeAllConnections();
      await new Promise<void>((resolve) =>
        controlApiServer!.close(() => resolve())
      );
    }
    if (ingress.server.listening) {
      ingress.server.closeAllConnections();
      await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
    }
    await supervisor.close();
  };

  if (isEntryPoint(import.meta.url)) {
    const shutdown = () => {
      void close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  const initialGenerationId =
    environment.AUTODEV_ROUTER_INITIAL_GENERATION_ID?.trim();
  const initialWorkerEntry =
    environment.AUTODEV_ROUTER_INITIAL_WORKER_ENTRY?.trim();
  if (initialGenerationId && initialWorkerEntry) {
    try {
      await supervisor.activate(initialGenerationId, initialWorkerEntry);
    } catch (error) {
      await close().catch(() => undefined);
      throw error;
    }
  }

  return { ingress, supervisor, controlApiServer, close };
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
