import { homedir } from "node:os";
import path from "node:path";

import { ConfigError } from "@simulatorlife/autodev-runtime/config";
import {
  checkGatewayTaskListing,
  type GatewayTaskListingReport
} from "@simulatorlife/autodev-runtime/platform";
import { writeLine } from "@simulatorlife/autodev-runtime/shared/output";

import { isChoice, unsupportedChoice } from "./command-choice.ts";

export const GATEWAY_COMMANDS = ["check-tasks"] as const;

export interface GatewayCommandBackend {
  checkTasks(): Promise<readonly GatewayTaskListingReport[]>;
}

const defaultGatewayBackend: GatewayCommandBackend = {
  checkTasks: () => {
    const home = process.env.HOME?.trim() || homedir();
    return checkGatewayTaskListing(
      process.env.CODEX_HOME?.trim() || path.join(home, ".codex")
    );
  }
};

export function dispatchGatewayCommand(
  command: string,
  arguments_: readonly string[],
  backend: GatewayCommandBackend = defaultGatewayBackend
): Promise<number> {
  if (!isChoice(command, GATEWAY_COMMANDS))
    throw unsupportedChoice("gateway command", command, GATEWAY_COMMANDS);
  if (arguments_.length > 0)
    throw new ConfigError("gateway commands do not accept positional arguments");
  return printTaskListingReport(backend);
}

async function printTaskListingReport(
  backend: GatewayCommandBackend
): Promise<number> {
  const roles = await backend.checkTasks();
  const ok = roles.length > 0 && roles.every((role) => role.status === "ok");
  writeLine(JSON.stringify({ ok, roles }, null, 2));
  return ok ? 0 : 1;
}
