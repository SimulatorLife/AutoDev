import { ConfigError } from "../config/toml.ts";
import { UnmigratedRuntimeError } from "./runtime.ts";

export type HookName =
  "session-start" | "subagent-start" | "root-delegation" | "skill-read";

export interface HookCommandBackend {
  run(hook: HookName): number;
}

const unmigratedHook: HookCommandBackend = {
  run: (hook) => {
    throw new UnmigratedRuntimeError(`hook ${hook}`);
  }
};

export function dispatchHookCommand(
  name: string,
  backend: HookCommandBackend = unmigratedHook
): number {
  if (
    name !== "session-start" &&
    name !== "subagent-start" &&
    name !== "root-delegation" &&
    name !== "skill-read"
  ) {
    throw new ConfigError(`unsupported hook: ${name || "(missing)"}`);
  }
  return backend.run(name);
}
