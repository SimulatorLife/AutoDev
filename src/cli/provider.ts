import { ConfigError } from "../config/toml.ts";
import { UnmigratedRuntimeError } from "./runtime.ts";

export type ProviderName = "claude" | "minimax" | "copilot" | "antigravity";

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
  if (
    name !== "claude" &&
    name !== "minimax" &&
    name !== "copilot" &&
    name !== "antigravity"
  ) {
    throw new ConfigError(`unsupported provider: ${name || "(missing)"}`);
  }
  return backend.start(name);
}
