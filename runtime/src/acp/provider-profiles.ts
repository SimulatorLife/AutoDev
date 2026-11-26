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

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { autodevHome } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveManagedSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

import { issueLaunchGrant } from "../mcp/gateway-admission.ts";
import { MCP_GRANT_ENV } from "../mcp/gateway-client.ts";

export const ACP_PROVIDER_IDS = [
  "claude",
  "antigravity",
  "copilot",
  "mcode",
  "codex"
] as const;

export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

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

export interface AcpProfileOptions {
  readonly provider: AcpProviderId;
  readonly role: string;
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly sessionId: string;
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

function sharedIsolationEnvironment(
  options: AcpProfileOptions,
  contract: ReturnType<typeof roleContract>
): Record<string, string> {
  const homeDirectory = autodevHome(options.env);
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
      "http://127.0.0.1:4100/v1/agent-events"
  };
}

/** The gateway client of the executing Runtime generation. */
function resolveGatewayClientPath(): string {
  return realpathSync(new URL("../mcp/gateway-client.ts", import.meta.url));
}

/**
The role's MCP servers, each reached through the shared gateway by the
gateway client under this session's own grant: the session is admitted in its
workspace and role, and the provider process never holds a backend launch,
a remote URL or a backend credential.
*/
function buildAcpMcpServers(
  options: AcpProfileOptions,
  contract: ReturnType<typeof roleContract>
): McpServer[] {
  if (contract.mcp.length === 0) return [];
  const { grant } = issueLaunchGrant({
    env: options.env ?? process.env,
    launchDirectory: options.cwd,
    role: options.role,
    session: options.sessionId
  });
  const client = resolveGatewayClientPath();
  const env = options.env ?? process.env;
  const home = env.HOME?.trim() || homedir();
  const handedOver = [
    { name: MCP_GRANT_ENV, value: grant },
    { name: "HOME", value: home },
    { name: "CODEX_HOME", value: env.CODEX_HOME?.trim() || path.join(home, ".codex") }
  ];
  return contract.mcp.map((name) => ({
    name,
    command: process.execPath,
    args: [client, name],
    env: handedOver
  }));
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
  const acpMcpServers = buildAcpMcpServers(options, contract);

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
          // MiniMax Code reads its profile from MINIMAX_DATA_DIR; it never
          // reads MCODE_HOME, so the AutoDev-managed profile is handed over
          // here.
          MINIMAX_DATA_DIR: mcodeHome,
          ...(minimaxApiKey ? { MINIMAX_API_KEY: minimaxApiKey } : {})
        },
        isolation: {
          nativeTools: "runtime_permission_guard",
          nativePrompts: "runtime_permission_guard",
          nativeSkills: "runtime_permission_guard",
          nativeMcps: "runtime_permission_guard",
          systemPromptInjection: "initial_turn",
          gaps: [
            "mcode acp runs against the AutoDev-managed MINIMAX_DATA_DIR profile, whose native AGENTS.md, hooks.json and permission.json are generated by RuleSync; role boundaries are enforced at AutoDev's ACP permission/turn boundary and by the profile's native hooks"
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
