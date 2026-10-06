import { startRouterServer } from "@simulatorlife/autodev-runtime/router/server";
import type { RouterRuntimeStatus } from "@simulatorlife/autodev-runtime/router/status";
import { writeLine } from "@simulatorlife/autodev-runtime/shared/output";

import { isChoice, unsupportedChoice } from "./command-choice.ts";
import { fetchRouterStatus } from "./router-status-client.ts";
import { UnmigratedRuntimeError } from "./runtime.ts";

/** The router vocabulary, owned here and consumed by validation, help, and errors. */
export const ROUTER_COMMANDS = ["run", "ensure", "status"] as const;

export type RouterCommand = (typeof ROUTER_COMMANDS)[number];

export interface RouterCommandBackend {
  run(): number;
  ensure(): number;
  status(): RouterRuntimeStatus | Promise<RouterRuntimeStatus>;
}

const defaultRouterBackend: RouterCommandBackend = {
  run: () => {
    startRouterServer();
    return 0;
  },
  ensure: () => {
    throw new UnmigratedRuntimeError("router ensure");
  },
  status: fetchRouterStatus
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
  return Promise.resolve(backend.status()).then((status) => {
    writeLine(JSON.stringify(status, null, 2));
    return 0;
  });
}
