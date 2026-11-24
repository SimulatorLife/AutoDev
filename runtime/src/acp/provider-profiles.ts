/**
Provider-agnostic ACP isolation profiles and `github-worker` opencli dispatch specs.

Every ACP provider runs with its native tools, built-in skills, default system
prompts, and ungranted MCP servers disabled so AutoDev's RuleSync-projected
prompts, skills, hooks, and role-scoped MCP servers are the sole execution surface.
Each ACP provider manages its own session history and native auto-compaction.
*/

import path from "node:path";

import { autodevHome } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveManagedSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

export const ACP_PROVIDER_IDS = [
  "claude",
  "antigravity",
  "copilot",
  "mcode",
  "codex"
] as const;

export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

export const GITHUB_WORKER_ROLE = "github-worker" as const;

export const GITHUB_WORKER_PROVIDER_IDS = [
  "opencli-chatgpt",
  "opencli-gemini"
] as const;

export type GithubWorkerProviderId =
  (typeof GITHUB_WORKER_PROVIDER_IDS)[number];

export interface AcpProfileOptions {
  readonly provider: AcpProviderId;
  readonly role: string;
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly sessionId: string;
  readonly mcpConfigPath?: string;
  readonly reasoningEffort?: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AcpProviderLaunchSpec {
  readonly provider: AcpProviderId;
  readonly role: string;
  readonly model: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly mcpServers: readonly string[];
  readonly nativeToolsDisabled: true;
  readonly nativePromptsDisabled: true;
  readonly nativeSkillsDisabled: true;
  readonly nativeMcpsDisabled: true;
  readonly compactionManagedByProvider: true;
}

export interface GithubWorkerTaskSpec {
  readonly role: typeof GITHUB_WORKER_ROLE;
  readonly provider: GithubWorkerProviderId;
  readonly model: string;
  readonly repository: string;
  readonly task: string;
  readonly prompt: string;
  readonly sessionId: string;
}

const COPILOT_EXCLUDED_NATIVE_TOOLS = [
  "view",
  "edit",
  "create",
  "apply_patch",
  "glob",
  "grep",
  "task"
] as const;

/**
Normalize an AutoDev routing provider id (e.g. `antigravity-gemini` or
`minimax`) onto its underlying ACP executor identity.
*/
export function resolveAcpProviderId(provider: string): AcpProviderId | null {
  if (provider === "claude") return "claude";
  if (provider === "antigravity" || provider.startsWith("antigravity-")) {
    return "antigravity";
  }
  if (provider === "copilot") return "copilot";
  if (provider === "mcode" || provider === "minimax") return "mcode";
  if (provider === "codex") return "codex";
  return null;
}

export function isGithubWorkerProvider(
  provider: string
): provider is GithubWorkerProviderId {
  return (GITHUB_WORKER_PROVIDER_IDS as readonly string[]).includes(provider);
}

function sharedIsolationEnvironment(
  options: AcpProfileOptions,
  mcpServers: readonly string[]
): Record<string, string> {
  const homeDirectory = autodevHome(options.env);
  const context7ApiKey = mcpServers.includes("context7")
    ? resolveManagedSecret("CONTEXT7_API_KEY", options.env)
    : null;
  return {
    AUTODEV_HOME: homeDirectory,
    AUTODEV_AGENT_ROLE: options.role,
    AUTODEV_PROVIDER: options.provider,
    AUTODEV_MODEL: options.model,
    AUTODEV_SESSION_ID: options.sessionId,
    AUTODEV_MCP_WORKSPACE: options.cwd,
    AUTODEV_AGENT_EVENTS_URL:
      options.env?.AUTODEV_AGENT_EVENTS_URL ??
      "http://127.0.0.1:4100/v1/agent-events",
    ...(context7ApiKey ? { CONTEXT7_API_KEY: context7ApiKey } : {})
  };
}

/**
Build the strict ACP isolation launch specification for one provider and role.
*/
export function buildAcpProviderLaunchSpec(
  options: AcpProfileOptions
): AcpProviderLaunchSpec {
  const contract = roleContract(options.role);
  const mcpServers = [...contract.mcp];
  const baseEnvironment = sharedIsolationEnvironment(options, mcpServers);

  switch (options.provider) {
    case "claude": {
      const cliArguments = [
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--system-prompt",
        options.systemPrompt,
        "--model",
        options.model
      ];
      if (options.mcpConfigPath) {
        cliArguments.push("--mcp-config", options.mcpConfigPath);
      }
      if (options.reasoningEffort) {
        cliArguments.push("--effort", options.reasoningEffort);
      }
      return {
        provider: "claude",
        role: options.role,
        model: options.model,
        command: "claude-agent-acp",
        args: cliArguments,
        env: {
          ...baseEnvironment,
          CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1"
        },
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        mcpServers,
        nativeToolsDisabled: true,
        nativePromptsDisabled: true,
        nativeSkillsDisabled: true,
        nativeMcpsDisabled: true,
        compactionManagedByProvider: true
      };
    }
    case "antigravity": {
      const agyAgent = `autodev-${options.role}`;
      const isolatedAppDirectory = path.join(
        baseEnvironment.AUTODEV_HOME!,
        "run",
        "acp",
        "antigravity",
        options.sessionId
      );
      return {
        provider: "antigravity",
        role: options.role,
        model: options.model,
        command: "agy",
        args: [
          "acp",
          "--stdio",
          "--agent",
          agyAgent,
          "--include-default-customizations=false",
          "--app-data-dir",
          isolatedAppDirectory
        ],
        env: baseEnvironment,
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        mcpServers,
        nativeToolsDisabled: true,
        nativePromptsDisabled: true,
        nativeSkillsDisabled: true,
        nativeMcpsDisabled: true,
        compactionManagedByProvider: true
      };
    }
    case "copilot": {
      const cliArguments = [
        "--acp",
        "--stdio",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--excluded-tools",
        COPILOT_EXCLUDED_NATIVE_TOOLS.join(",")
      ];
      if (options.mcpConfigPath) {
        cliArguments.push("--additional-mcp-config", options.mcpConfigPath);
      }
      if (options.reasoningEffort) {
        cliArguments.push("--reasoning-effort", options.reasoningEffort);
      }
      return {
        provider: "copilot",
        role: options.role,
        model: options.model,
        command: "copilot",
        args: cliArguments,
        env: baseEnvironment,
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        mcpServers,
        nativeToolsDisabled: true,
        nativePromptsDisabled: true,
        nativeSkillsDisabled: true,
        nativeMcpsDisabled: true,
        compactionManagedByProvider: true
      };
    }
    case "mcode": {
      const mcodeHome = path.join(
        baseEnvironment.AUTODEV_HOME!,
        "providers",
        "mcode"
      );
      const minimaxApiKey = resolveManagedSecret(
        "MINIMAX_API_KEY",
        options.env
      );
      return {
        provider: "mcode",
        role: options.role,
        model: options.model,
        command: "mcode",
        args: ["acp"],
        env: {
          ...baseEnvironment,
          MCODE_HOME: mcodeHome,
          ...(minimaxApiKey ? { MINIMAX_API_KEY: minimaxApiKey } : {})
        },
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        mcpServers,
        nativeToolsDisabled: true,
        nativePromptsDisabled: true,
        nativeSkillsDisabled: true,
        nativeMcpsDisabled: true,
        compactionManagedByProvider: true
      };
    }
    case "codex": {
      return {
        provider: "codex",
        role: options.role,
        model: options.model,
        command: "codex-acp",
        args: [],
        env: baseEnvironment,
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        mcpServers,
        nativeToolsDisabled: true,
        nativePromptsDisabled: true,
        nativeSkillsDisabled: true,
        nativeMcpsDisabled: true,
        compactionManagedByProvider: true
      };
    }
    default: {
      const unreachable: never = options.provider;
      throw new Error(`Unsupported ACP provider: ${String(unreachable)}`);
    }
  }
}

/**
Build a high-level autonomous task prompt for the `github-worker` subagent lane
served by `opencli-chatgpt` / `opencli-gemini` via their native GitHub integration.
*/
export function buildGithubWorkerTaskSpec(options: {
  readonly provider: GithubWorkerProviderId;
  readonly model: string;
  readonly repository: string;
  readonly task: string;
  readonly sessionId: string;
}): GithubWorkerTaskSpec {
  const prompt = [
    `Repository: ${options.repository}`,
    "",
    "You are AutoDev's `github-worker` subagent. Use your connected GitHub integration/tools directly to complete the full multi-step GitHub task below autonomously:",
    "",
    options.task.trim(),
    "",
    "Report the exact resulting pull request/issue URL, branch name, and final status. Never fabricate repository changes or URLs."
  ].join("\n");

  return {
    role: GITHUB_WORKER_ROLE,
    provider: options.provider,
    model: options.model,
    repository: options.repository,
    task: options.task,
    prompt,
    sessionId: options.sessionId
  };
}
