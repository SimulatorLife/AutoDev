import type { RouterRuntimeStatus } from "@simulatorlife/autodev-runtime/router/status";
import { writeLine } from "@simulatorlife/autodev-runtime/shared/output";

import { ConfigError } from "../config/config-files.ts";
import { startRouterServer } from "@simulatorlife/autodev-runtime/router/server";
import { fetchRouterStatus } from "./router-status-client.ts";
import { UnmigratedRuntimeError } from "./runtime.ts";

export type RouterCommand = "run" | "ensure" | "status";

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
  if (command !== "run" && command !== "ensure" && command !== "status") {
    throw new ConfigError(
      `unsupported router command: ${command || "(missing)"}`
    );
  }
  if (command === "run") return backend.run();
  if (command === "ensure") return backend.ensure();
  return Promise.resolve(backend.status()).then((status) => {
    writeLine(JSON.stringify(status, null, 2));
    return 0;
  });
}
