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

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { autodevHome } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import {
  findAgyBinary,
  findCopilotBinary,
  findMcodeBinary,
  findRuntimePackageBin
} from "@simulatorlife/autodev-runtime/shared/executables";
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

/**
The ACP executor each provider is served by, as an operator would type it.
*/
const ACP_EXECUTOR_COMMANDS: Readonly<Record<AcpProviderId, string>> = {
  claude: "claude-agent-acp",
  antigravity: "agy",
  copilot: "copilot",
  mcode: "mcode",
  codex: "codex-acp"
};

export type AcpIsolationEnforcement =
  "enforced" | "runtime_permission_guard" | "unverified_gap";

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
  /**
  The executor's name, as an operator would type it.
  */
  readonly command: string;
  /**
  The file that is spawned. A Runtime-shipped adapter runs its package's
  entry script under the Runtime's own Node; a vendor CLI is the executable
  found through the same lookups the Runtime's CLI-version reader uses.
  When the executor is not installed this is `command` itself, and the
  spawn then fails the turn as a missing executor.
  */
  readonly program: string;
  /**
  What `program` needs before the executor's own arguments: the adapter's
  entry script when `program` is Node, otherwise nothing.
  */
  readonly programArgs: readonly string[];
  /**
  The executor's own command-line arguments.
  */
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

/**
The host variables an executor needs to start and find its own sign-in:
where it lives and runs, who runs it, and the locale. Nothing else from the
Runtime's environment is handed over -- backend credentials stay with the
gateway and Runtime tokens stay with the Runtime.
*/
const EXECUTOR_HOST_VARIABLES = [
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE"
] as const;

interface AcpExecutor {
  readonly program: string;
  readonly programArgs: readonly string[];
}

/**
How to start each provider's ACP executor, or null when it is not
installed. A Runtime-shipped adapter is read from the Runtime's own
dependency tree and run with the Runtime's Node, so neither a shell PATH
nor a package-manager shim chooses what runs. A vendor CLI is looked up the
way a login shell would find it, because launchd starts the Runtime with a
minimal PATH.
*/
function findAcpExecutor(
  provider: AcpProviderId,
  environment: NodeJS.ProcessEnv
): AcpExecutor | null {
  const runtimeAdapter = (packageName: string): AcpExecutor | null => {
    const entry = findRuntimePackageBin(
      packageName,
      ACP_EXECUTOR_COMMANDS[provider]
    );
    return entry && existsSync(entry)
      ? { program: process.execPath, programArgs: [entry] }
      : null;
  };
  const vendorCli = (program: string | null): AcpExecutor | null =>
    program ? { program, programArgs: [] } : null;
  const home = environment.HOME?.trim() || homedir();
  // The adapters pin the versions XACPX's adapter catalog names; the
  // Runtime package manifest owns them.
  const lookups: Record<AcpProviderId, () => AcpExecutor | null> = {
    claude: () => runtimeAdapter("@agentclientprotocol/claude-agent-acp"),
    codex: () => runtimeAdapter("@agentclientprotocol/codex-acp"),
    antigravity: () => vendorCli(findAgyBinary(environment)),
    copilot: () => vendorCli(findCopilotBinary(environment, home)),
    mcode: () => vendorCli(findMcodeBinary(environment, home))
  };
  return lookups[provider]();
}

/**
The host part of an executor's environment. The executor's own directory
leads PATH, so the tools installed beside it (its CLI, its helpers) resolve
the same way it did.
*/
function executorHostEnvironment(
  environment: NodeJS.ProcessEnv,
  program: string
): Record<string, string> {
  const host: Record<string, string> = {
    HOME: environment.HOME?.trim() || homedir()
  };
  for (const name of EXECUTOR_HOST_VARIABLES) {
    const value = environment[name];
    if (value) host[name] = value;
  }
  const searchPath = (environment.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const programDirectory = path.isAbsolute(program)
    ? path.dirname(program)
    : null;
  host.PATH = [
    ...(programDirectory ? [programDirectory] : []),
    ...searchPath.filter((directory) => directory !== programDirectory)
  ].join(path.delimiter);
  return host;
}

function sharedIsolationEnvironment(
  options: AcpProfileOptions,
  contract: ReturnType<typeof roleContract>,
  program: string
): Record<string, string> {
  const homeDirectory = autodevHome(options.env);
  return {
    ...executorHostEnvironment(options.env ?? process.env, program),
    AUTODEV_HOME: homeDirectory,
    AUTODEV_AGENT_ROLE: options.role,
    AUTODEV_PROVIDER: options.provider,
    AUTODEV_MODEL: options.model,
    AUTODEV_SESSION_ID: options.sessionId,
    AUTODEV_MCP_WORKSPACE: options.cwd,
    AUTODEV_ROLE_SHELL_ENABLED: contract.shell === false ? "0" : "1",
    AUTODEV_ROLE_HOOKS_ENABLED: contract.hooks === false ? "0" : "1",
    ...((contract.readOnly === true) && { AUTODEV_MCP_READ_ONLY: "1" }),
    AUTODEV_AGENT_EVENTS_URL:
      options.env?.AUTODEV_AGENT_EVENTS_URL ??
      "http://127.0.0.1:4100/v1/agent-events"
  };
}

/**
The gateway client of the executing Runtime generation.
*/
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
  const environment = options.env ?? process.env;
  const home = environment.HOME?.trim() || homedir();
  const handedOver = [
    { name: MCP_GRANT_ENV, value: grant },
    { name: "HOME", value: home },
    {
      name: "CODEX_HOME",
      value: environment.CODEX_HOME?.trim() || path.join(home, ".codex")
    }
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
  const isReadOnly = contract.readOnly === true;
  const isShell = contract.shell !== false;
  const isHooks = contract.hooks !== false;
  const command = ACP_EXECUTOR_COMMANDS[options.provider];
  const { program, programArgs } = findAcpExecutor(
    options.provider,
    options.env ?? process.env
  ) ?? { program: command, programArgs: [] };
  const baseEnvironment = sharedIsolationEnvironment(options, contract, program);
  const acpMcpServers = buildAcpMcpServers(options, contract);

  const sharedFields = {
    command,
    program,
    programArgs,
    role: options.role,
    model: options.model,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    readOnly: isReadOnly,
    shell: isShell,
    hooks: isHooks,
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
            'agy acp does not expose a CLI --tools "" or --system-prompt flag; native tool denial and system prompt injection are enforced at AutoDev\'s ACP permission/turn boundary'
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
        args: ["acp"],
        env: {
          ...baseEnvironment,
          // MiniMax Code reads its profile from MINIMAX_DATA_DIR; it never
          // reads MCODE_HOME, so the AutoDev-managed profile is handed over
          // here.
          MINIMAX_DATA_DIR: mcodeHome,
          ...(minimaxApiKey && { MINIMAX_API_KEY: minimaxApiKey })
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
