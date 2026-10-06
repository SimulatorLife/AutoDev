import { isChoice, unsupportedChoice } from "./command-choice.ts";
import { UnmigratedRuntimeError } from "./runtime.ts";

/** The hook vocabulary, owned here and consumed by validation and errors. */
export const HOOK_NAMES = [
  "session-start",
  "subagent-start",
  "root-delegation",
  "skill-read"
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

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
  if (!isChoice(name, HOOK_NAMES)) {
    throw unsupportedChoice("hook", name, HOOK_NAMES);
  }
  return backend.run(name);
}
