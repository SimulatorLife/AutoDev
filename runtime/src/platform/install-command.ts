import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { ConfigError } from "@simulatorlife/autodev-runtime/config";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import type { KeychainDeps } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";
import {
  resolveRuntimeSourcePath,
  resolveRuntimeSourceRoot
} from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { createCodexMcpSource } from "./codex-mcp-source.ts";
import {
  installCocoIndex,
  installCodeGraphContext,
  installPythonLanguageServer,
  resolveDependencyOptions
} from "./dependencies.ts";
import { materializeInstallation } from "./install-materializer.ts";
import {
  checkRequiredKeychainSecrets,
  ensureBridgeRouterAuth,
  ensureRouterAuth,
  REQUIRED_INSTALL_KEYCHAIN_SECRETS
} from "./install-state.ts";
import { installOpencliBrowser } from "./opencli-browser-install.ts";
import {
  CHATGPT_TUNNEL_API_KEY_ENV,
  type ChatgptTunnelMode
} from "./chatgpt-tunnel-install.ts";

export interface InstallCommandOptions {
  readonly repositoryRoot?: string;
  readonly home?: string;
  readonly codexHome?: string;
  readonly keychainDeps?: KeychainDeps;
}

interface InstallFlags {
  materializeOnly: boolean;
  routerAuth: boolean;
  chatgptTunnel: ChatgptTunnelMode;
}

function parseFlags(args: readonly string[]): InstallFlags {
  const flags: InstallFlags = {
    materializeOnly: false,
    routerAuth: false,
    chatgptTunnel: "reconcile"
  };
  for (const arg of args) {
    if (arg === "--materialize-only") flags.materializeOnly = true;
    else if (arg === "--enable-router-auth") flags.routerAuth = true;
    else if (
      arg === "--enable-chatgpt-tunnel" ||
      arg === "--disable-chatgpt-tunnel"
    ) {
      if (flags.chatgptTunnel !== "reconcile")
        throw new ConfigError("Choose only one ChatGPT tunnel option");
      flags.chatgptTunnel =
        arg === "--enable-chatgpt-tunnel" ? "enable" : "disable";
    } else if (arg === "--check") {
      throw new ConfigError(
        "autodev install --check is still owned by the installer check boundary; run scripts/install.sh --check"
      );
    } else {
      throw new ConfigError(
        arg === "--restart"
          ? "unsupported install option: --restart; normal installs restart services, use --materialize-only for a live session"
          : `unsupported install option: ${arg}`
      );
    }
  }
  if (flags.materializeOnly && flags.chatgptTunnel !== "reconcile")
    throw new ConfigError("ChatGPT tunnel setup requires a normal install");
  return flags;
}

function runNodeModule(
  modulePath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): void {
  try {
    execFileSync(process.execPath, [modulePath, ...args], {
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
  } catch (error) {
    throw new ConfigError(`${modulePath} failed: ${errorMessage(error)}`);
  }
}

/** Typed normal-install coordinator; `autodev install --check` is owned by the typed install-check boundary. */
export function runInstallCommand(
  args: readonly string[] = [],
  overrides: InstallCommandOptions = {}
): number {
  const flags = parseFlags(args);
  const repositoryRoot = path.resolve(
    overrides.repositoryRoot ??
      process.env.AUTODEV_REPO_ROOT ??
      resolveRuntimeSourceRoot(import.meta.dirname)
  );
  const home = overrides.home ?? (process.env.HOME?.trim() || homedir());
  const codexHome =
    overrides.codexHome ??
    (process.env.CODEX_HOME?.trim() || path.join(home, ".codex"));
  const env = {
    AUTODEV_REPO_ROOT: repositoryRoot,
    CODEX_HOME: codexHome,
    HOME: home
  };
  // Credentials belong only to the components that consume or provision them,
  // never ordinary package managers, materializers, or unrelated restarts.
  const isolatedSecrets = Object.fromEntries(
    [
      "OPENAI_ADMIN_KEY",
      CHATGPT_TUNNEL_API_KEY_ENV,
      "MINIMAX_API_KEY",
      "CONTEXT7_API_KEY"
    ].map((key) => [key, process.env[key]])
  );
  for (const key of Object.keys(isolatedSecrets)) delete process.env[key];
  let projection: ReturnType<typeof createCodexMcpSource> | undefined;
  try {
    if (flags.chatgptTunnel === "disable") {
      runNodeModule(
        resolveRuntimeSourcePath(
          repositoryRoot,
          "platform/chatgpt-tunnel-install.ts"
        ),
        ["disable", repositoryRoot, home, codexHome],
        env
      );
      return 0;
    }
    const codexEnvFile =
      process.env.CODEX_ENV_FILE?.trim() || path.join(codexHome, ".env");
    projection = createCodexMcpSource(repositoryRoot);
    ensureBridgeRouterAuth(path.join(codexHome, ".env"));
    if (flags.routerAuth) ensureRouterAuth(codexEnvFile, env);
    if (!flags.materializeOnly) {
      const missingSecrets = checkRequiredKeychainSecrets(
        REQUIRED_INSTALL_KEYCHAIN_SECRETS,
        process.env,
        overrides.keychainDeps
      );
      if (missingSecrets.length > 0) {
        throw new ConfigError(
          `Missing required API key(s) in macOS Keychain: ${missingSecrets.join(", ")}. Store them in your login Keychain before running install.`
        );
      }
      const dependencyOptions = resolveDependencyOptions(process.env);
      if (installCocoIndex(dependencyOptions) !== 0) return 1;
      if (installCodeGraphContext(dependencyOptions) !== 0) return 1;
      if (installPythonLanguageServer(dependencyOptions) !== 0) return 1;
      if (installOpencliBrowser({ repositoryRoot, codexHome }) !== 0) return 1;
    }
    materializeInstallation({
      repositoryRoot,
      home,
      codexHome,
      materializeOnly: flags.materializeOnly,
      codexMcpSource: projection.source
    });
    if (flags.materializeOnly) {
      writeErrorLine(
        "Materialized AutoDev integration without restarting services."
      );
    } else {
      runNodeModule(
        resolveRuntimeSourcePath(
          repositoryRoot,
          "platform/chatgpt-tunnel-install.ts"
        ),
        [flags.chatgptTunnel, repositoryRoot, home, codexHome],
        {
          ...env,
          OPENAI_ADMIN_KEY: isolatedSecrets.OPENAI_ADMIN_KEY,
          [CHATGPT_TUNNEL_API_KEY_ENV]:
            isolatedSecrets[CHATGPT_TUNNEL_API_KEY_ENV]
        }
      );
      runNodeModule(
        resolveRuntimeSourcePath(repositoryRoot, "platform/service-restart.ts"),
        [],
        env
      );
    }
    return 0;
  } finally {
    if (projection) rmSync(projection.root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(isolatedSecrets)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}
