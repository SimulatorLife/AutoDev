import { homedir } from "node:os";
import path from "node:path";

import { ConfigError } from "@simulatorlife/autodev-runtime/config";
import {
  ensureModelRouter,
  ingressControlSocketPath,
  readIngressControlSecret
} from "@simulatorlife/autodev-runtime/platform";
import { startRouterServer } from "@simulatorlife/autodev-runtime/router/server";
import type { RouterRuntimeStatus } from "@simulatorlife/autodev-runtime/router/status";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import {
  type IngressActivationResponse,
  queryIngressStatus,
  rollbackIngressGeneration,
  uniqueGenerationId
} from "../router/ingress-client.ts";
import { isChoice, unsupportedChoice } from "./command-choice.ts";
import { fetchRouterStatus } from "./router-status-client.ts";

/**
The router vocabulary, owned here and consumed by validation, help, and errors.
*/
export const ROUTER_COMMANDS = ["run", "ensure", "status", "rollback"] as const;

export interface RouterCommandBackend {
  run(): number;
  ensure(): number | Promise<number>;
  status(): RouterRuntimeStatus | Promise<RouterRuntimeStatus>;
  rollback(): Promise<IngressActivationResponse>;
}

/**
Reactivate the ingress's retained prior release through its authenticated
control socket. The new generation is named after the release it restores,
so a later install of that same release is recognised as already active.
*/
async function rollbackRouterGeneration(
  environment: NodeJS.ProcessEnv = process.env
): Promise<IngressActivationResponse> {
  const codexHome =
    environment.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  const controlSocket = ingressControlSocketPath(codexHome);
  const token = readIngressControlSecret(codexHome);
  if (!token)
    throw new ConfigError(
      "the Router ingress control secret is not installed; rollback needs the zero-downtime ingress"
    );
  const status = await queryIngressStatus(controlSocket, token);
  if (!status)
    throw new ConfigError(
      `the Router ingress is not answering on ${controlSocket}`
    );
  if (!status.rollbackGenerationId)
    throw new ConfigError(
      "the Router ingress retains no prior generation to roll back to"
    );
  return rollbackIngressGeneration(
    controlSocket,
    token,
    uniqueGenerationId(status.rollbackGenerationId, status)
  );
}

const defaultRouterBackend: RouterCommandBackend = {
  run: () => {
    startRouterServer();
    return 0;
  },
  ensure: async () => {
    const result = await ensureModelRouter(process.env, process.pid);
    if (result.exitCode !== 0) {
      writeErrorLine(result.message ?? `model router ensure: ${result.status}`);
      const logTail = result.logTail ?? [];
      for (const line of logTail) writeErrorLine(line);
    }
    return result.exitCode;
  },
  status: fetchRouterStatus,
  rollback: () => rollbackRouterGeneration()
};

export function dispatchRouterCommand(
  command: string,
  backend: RouterCommandBackend = defaultRouterBackend
): number | Promise<number> {
  if (!isChoice(command, ROUTER_COMMANDS)) {
    throw unsupportedChoice("router command", command, ROUTER_COMMANDS);
  }
  if (command === "run") return backend.run();
  if (command === "ensure") return backend.ensure();
  return printReport(
    command === "status" ? backend.status() : backend.rollback()
  );
}

async function printReport(report: unknown): Promise<number> {
  writeLine(JSON.stringify(await report, null, 2));
  return 0;
}
