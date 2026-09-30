import { ConfigError } from "../config/config-files.ts";
import { startRouterServer } from "../router/server.ts";
import type { RouterRuntimeStatus } from "../router/status.ts";
import { writeLine } from "../shared/output.ts";
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
