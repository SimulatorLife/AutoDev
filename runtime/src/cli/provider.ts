import { isChoice, unsupportedChoice } from "./command-choice.ts";
import { UnmigratedRuntimeError } from "./runtime.ts";

/** The provider vocabulary, owned here and consumed by validation and errors. */
export const PROVIDER_NAMES = [
  "claude",
  "minimax",
  "copilot",
  "antigravity"
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderCommandBackend {
  start(provider: ProviderName): number;
}

const unmigratedProvider: ProviderCommandBackend = {
  start: (provider) => {
    throw new UnmigratedRuntimeError(`provider ${provider}`);
  }
};

export function dispatchProviderCommand(
  name: string,
  backend: ProviderCommandBackend = unmigratedProvider
): number {
  if (!isChoice(name, PROVIDER_NAMES)) {
    throw unsupportedChoice("provider", name, PROVIDER_NAMES);
  }
  return backend.start(name);
}
