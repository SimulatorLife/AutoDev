/**
Provider-agnostic ACP isolation profiles and `github-worker` opencli dispatch specs.

Every ACP provider derives its authorized MCP servers, shell availability,
read-only tier, hooks flag, and skills from the single canonical execution
contract (`config/execution-contract.json`). Where a provider CLI lacks native
flags to disable built-in tools, prompts, skills, or MCPs, the profile records
the exact enforcement boundary truthfully (`enforced`, `runtime_permission_guard`,
or `unverified_gap`) instead of claiming uniform CLI-level isolation, and
AutoDev's ACP `session/request_permission` boundary enforces the canonical role
contract uniformly across all providers.
*/

import { existsSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { autodevHome } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveManagedSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

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

export type AcpIsolationEnforcement =
  | "enforced"
  | "runtime_permission_guard"
  | "unverified_gap";

export interface AcpProviderIsolationSurface {
  readonly nativeTools: AcpIsolationEnforcement;
  readonly nativePrompts: AcpIsolationEnforcement;
  readonly nativeSkills: AcpIsolationEnforcement;
  readonly nativeMcps: AcpIsolationEnforcement;
  readonly systemPromptInjection: "cli_flag" | "initial_turn";
  readonly gaps: readonly string[];
}

export interface AcpSupergatewayEndpoint {
  readonly url: string;
  readonly bearerToken?: string;
}

export interface AcpProfileOptions {
  readonly provider: AcpProviderId;
  readonly role: string;
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly sessionId: string;
  readonly mcpConfigPath?: string;
  readonly supergateway?: AcpSupergatewayEndpoint;
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
  readonly readOnly: boolean;
  readonly shell: boolean;
  readonly hooks: boolean;
  readonly skills: readonly string[];
  readonly mcpServers: readonly string[];
  readonly acpMcpServers: readonly McpServer[];
  readonly isolation: AcpProviderIsolationSurface;
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

const REMOTE_MCP_URLS: Readonly<Record<string, { url: string; secret?: string; header?: string }>> = {
  openaiDeveloperDocs: { url: "https://developers.openai.com/mcp" },
  context7: { url: "https://mcp.context7.com/mcp", secret: "CONTEXT7_API_KEY" },
  googleDeveloperKnowledge: {
    url: "https://developerknowledge.googleapis.com/mcp",
    secret: "GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY",
    header: "X-Goog-Api-Key"
  }
};

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
  contract: ReturnType<typeof roleContract>
): Record<string, string> {
  const homeDirectory = autodevHome(options.env);
  const mcpServers = contract.mcp;
  const context7ApiKey = mcpServers.includes("context7")
    ? resolveManagedSecret("CONTEXT7_API_KEY", options.env)
    : null;
  const googleDeveloperKnowledgeApiKey = mcpServers.includes(
    "googleDeveloperKnowledge"
  )
    ? resolveManagedSecret("GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY", options.env)
    : null;
  return {
    AUTODEV_HOME: homeDirectory,
    AUTODEV_AGENT_ROLE: options.role,
    AUTODEV_PROVIDER: options.provider,
    AUTODEV_MODEL: options.model,
    AUTODEV_SESSION_ID: options.sessionId,
    AUTODEV_MCP_WORKSPACE: options.cwd,
    AUTODEV_ROLE_SHELL_ENABLED: contract.shell === false ? "0" : "1",
    AUTODEV_ROLE_HOOKS_ENABLED: contract.hooks === false ? "0" : "1",
    ...(contract.readOnly === true ? { AUTODEV_MCP_READ_ONLY: "1" } : {}),
    AUTODEV_AGENT_EVENTS_URL:
      options.env?.AUTODEV_AGENT_EVENTS_URL ??
      "http://127.0.0.1:4100/v1/agent-events",
    ...(context7ApiKey ? { CONTEXT7_API_KEY: context7ApiKey } : {}),
    ...(googleDeveloperKnowledgeApiKey
      ? {
          GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY: googleDeveloperKnowledgeApiKey
        }
      : {})
  };
}

function resolveLauncherPath(env?: NodeJS.ProcessEnv): string {
  const repoRoot = resolveRuntimeSourceRoot(
    import.meta.dirname,
    env?.AUTODEV_REPO_ROOT
  );
  const checkout = path.join(repoRoot, "runtime/src/mcp/launcher.ts");
  if (existsSync(checkout)) return checkout;
  return path.join(repoRoot, "src/mcp/launcher.ts");
}

function buildAcpMcpServers(
  options: AcpProfileOptions,
  contract: ReturnType<typeof roleContract>,
  baseEnvironment: Readonly<Record<string, string>>
): McpServer[] {
  if (options.supergateway?.url) {
    return [
      {
        type: "http",
        name: "autodev",
        url: options.supergateway.url,
        headers: options.supergateway.bearerToken
          ? [
              {
                name: "Authorization",
                value: `Bearer ${options.supergateway.bearerToken}`
              }
            ]
          : []
      }
    ];
  }

  const launcherPath = resolveLauncherPath(options.env);
  const servers: McpServer[] = [];
  for (const name of contract.mcp) {
    const remote = REMOTE_MCP_URLS[name];
    if (remote) {
      const secretValue = remote.secret
        ? resolveManagedSecret(remote.secret, options.env)
        : null;
      const headers = secretValue
        ? [
            {
              name: remote.header ?? "Authorization",
              value: remote.header ? secretValue : `Bearer ${secretValue}`
            }
          ]
        : [];
      servers.push({
        type: "http",
        name,
        url: remote.url,
        headers
      });
      continue;
    }
    const envEntries: Array<{ name: string; value: string }> = [
      { name: "AUTODEV_HOME", value: baseEnvironment.AUTODEV_HOME! },
      { name: "AUTODEV_AGENT_ROLE", value: options.role },
      { name: "AUTODEV_MCP_WORKSPACE", value: options.cwd },
      ...(contract.readOnly === true
        ? [{ name: "AUTODEV_MCP_READ_ONLY", value: "1" }]
        : [])
    ];
    servers.push({
      name,
      command: process.execPath,
      args: [launcherPath, name],
      env: envEntries
    });
  }
  return servers;
}

/**
Build the ACP launch specification for one provider and role from the canonical
execution contract. Fails closed if `options.role` is undeclared.
*/
export function buildAcpProviderLaunchSpec(
  options: AcpProfileOptions
): AcpProviderLaunchSpec {
  const contract = roleContract(options.role);
  const mcpServers = [...contract.mcp];
  const skills = Array.isArray(contract.skills)
    ? contract.skills.filter((s): s is string => typeof s === "string")
    : [];
  const readOnly = contract.readOnly === true;
  const shell = contract.shell !== false;
  const hooks = contract.hooks !== false;
  const baseEnvironment = sharedIsolationEnvironment(options, contract);
  const acpMcpServers = buildAcpMcpServers(options, contract, baseEnvironment);

  const sharedFields = {
    role: options.role,
    model: options.model,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    readOnly,
    shell,
    hooks,
    skills,
    mcpServers,
    acpMcpServers,
    compactionManagedByProvider: true as const
  };

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
        ...sharedFields,
        provider: "claude",
        command: "claude-agent-acp",
        args: cliArguments,
        env: {
          ...baseEnvironment,
          CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1"
        },
        isolation: {
          nativeTools: "enforced",
          nativePrompts: "enforced",
          nativeSkills: "enforced",
          nativeMcps: "enforced",
          systemPromptInjection: "cli_flag",
          gaps: []
        }
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
        ...sharedFields,
        provider: "antigravity",
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
        isolation: {
          nativeTools: "runtime_permission_guard",
          nativePrompts: "runtime_permission_guard",
          nativeSkills: "enforced",
          nativeMcps: "enforced",
          systemPromptInjection: "initial_turn",
          gaps: [
            "agy acp does not expose a CLI --tools \"\" or --system-prompt flag; native tool denial and system prompt injection are enforced at AutoDev's ACP permission/turn boundary"
          ]
        }
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
        ...sharedFields,
        provider: "copilot",
        command: "copilot",
        args: cliArguments,
        env: baseEnvironment,
        isolation: {
          nativeTools: "runtime_permission_guard",
          nativePrompts: "enforced",
          nativeSkills: "unverified_gap",
          nativeMcps: "enforced",
          systemPromptInjection: "initial_turn",
          gaps: [
            "copilot --excluded-tools covers a fixed list of native file/task tools and lacks a --disable-bundled-skills or --system-prompt CLI flag; AutoDev enforces full role boundaries at ACP session/request_permission and initial turn"
          ]
        }
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
        ...sharedFields,
        provider: "mcode",
        command: "mcode",
        args: ["acp"],
        env: {
          ...baseEnvironment,
          MCODE_HOME: mcodeHome,
          ...(minimaxApiKey ? { MINIMAX_API_KEY: minimaxApiKey } : {})
        },
        isolation: {
          nativeTools: "runtime_permission_guard",
          nativePrompts: "runtime_permission_guard",
          nativeSkills: "runtime_permission_guard",
          nativeMcps: "runtime_permission_guard",
          systemPromptInjection: "initial_turn",
          gaps: [
            "mcode acp relies on isolated MCODE_HOME projection plus AutoDev's ACP permission/turn boundary rather than native CLI isolation flags"
          ]
        }
      };
    }
    case "codex": {
      return {
        ...sharedFields,
        provider: "codex",
        command: "codex-acp",
        args: [],
        env: baseEnvironment,
        isolation: {
          nativeTools: "runtime_permission_guard",
          nativePrompts: "runtime_permission_guard",
          nativeSkills: "runtime_permission_guard",
          nativeMcps: "runtime_permission_guard",
          systemPromptInjection: "initial_turn",
          gaps: [
            "codex-acp accepts no CLI tool/prompt isolation flags; AutoDev passes role-authorized MCP servers via ACP session/new and enforces role boundaries at ACP session/request_permission and initial turn"
          ]
        }
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
