import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseTomlFile,
  type TomlValue
} from "@simulatorlife/autodev-runtime/config";
import {
  createDefaultRouterEnsureDeps,
  resolveRouterEnsureOptions,
  runRouterEnsure
} from "@simulatorlife/autodev-runtime/platform";
import { resolveCodexBinary } from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { readRuntimeSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";
import {
  resolveRuntimeSourcePath,
  resolveRuntimeSourceRoot
} from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import { gitCommitIdentityEnv } from "@simulatorlife/autodev-runtime/telemetry";

const repositoryRoot = path.resolve(
  resolveRuntimeSourceRoot(import.meta.dirname)
);
const CODEX_CONFIG_FILE = "config.toml";
const BROWSER_TESTER_ROLE = "browser-tester";
const PLAYTESTER_ROLE = "playtester";
const PLAYTEST_ANALYST_ROLE = "playtest-analyst";
const SUPPORTED_ROLES = [
  "default",
  "docs-researcher",
  BROWSER_TESTER_ROLE,
  "explorer",
  "worker",
  "validator",
  "smart",
  PLAYTEST_ANALYST_ROLE,
  PLAYTESTER_ROLE
] as const;
const LINE_BREAK = /\r?\n/u;
const TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
export type ProviderAgentRole = (typeof SUPPORTED_ROLES)[number];

export interface ProviderAgentOptions {
  readonly role: ProviderAgentRole;
  readonly workspace: string;
  readonly prompt: string;
  readonly checkOnly: boolean;
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly codexBinary: string;
  readonly roleFile: string;
}

export interface RoleExecutionSettings {
  readonly developerInstructions: string;
  readonly reasoningEffort: string;
  readonly reasoningSummary: string;
  readonly sandboxMode: string;
}

export interface ProviderAgentDeps {
  readonly ensureRouter?: (environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly runCodex?: (
    binary: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    checkOnly: boolean
  ) => number | Promise<number>;
}

const MEMORY_MCP_CONFIG_KEY = "mcp_servers.autodev_memory";

interface MemoryMcpLaunch {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Give ordinary JIT runs a run-bound Memory MCP server. Controlled cohorts
 * cannot use this explicit path to bypass router injection assignment.
 */
function configureMemoryMcp(
  options: ProviderAgentOptions,
  environment: NodeJS.ProcessEnv
): MemoryMcpLaunch {
  const mode = environment.AUTODEV_MEMORY_MODE?.trim() || "jit";
  const boundRepositoryRoot =
    environment.AUTODEV_MEMORY_REPOSITORY_ROOT?.trim();
  const workspaceId = environment.AUTODEV_MEMORY_WORKSPACE_ID?.trim();
  const repositoryId = environment.AUTODEV_MEMORY_REPOSITORY_ID?.trim();
  const databaseUrl = environment.AUTODEV_MEMORY_DATABASE_URL?.trim();
  const cohortControlsMcp =
    environment.AUTODEV_MEMORY_ABLATION === "1" ||
    Boolean(environment.AUTODEV_MEMORY_EXPERIMENT_ID?.trim());
  const trustedWorkspace =
    boundRepositoryRoot &&
    path.isAbsolute(boundRepositoryRoot) &&
    path.resolve(boundRepositoryRoot) === options.workspace;
  const validScope =
    workspaceId &&
    workspaceId !== "unknown" &&
    repositoryId &&
    repositoryId !== "unknown" &&
    databaseUrl;

  if (mode !== "jit" || cohortControlsMcp || !trustedWorkspace || !validScope) {
    // The server exists only through the enable overrides below. Emitting a
    // bare `enabled=false` would define a transport-less server table that
    // Codex strict config rejects, so a disabled run simply omits it.
    return { args: [], environment };
  }

  const taskId = `provider-task-${randomUUID()}`;
  const runId = `provider-run-${randomUUID()}`;
  const actorId = `provider-${options.role}-${randomUUID()}`;
  const mcpEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    AUTODEV_MEMORY_WORKSPACE_ID: workspaceId,
    AUTODEV_MEMORY_REPOSITORY_ID: repositoryId,
    AUTODEV_MEMORY_REPOSITORY_ROOT: options.workspace,
    AUTODEV_MEMORY_ROLE: options.role,
    AUTODEV_MEMORY_ACTOR_ID: actorId,
    AUTODEV_MEMORY_AUTHORITY: "worker",
    AUTODEV_MEMORY_TASK_ID: taskId,
    AUTODEV_MEMORY_RUN_ID: runId,
    AUTODEV_MEMORY_MODE: "jit"
  };
  // A general-purpose provider process never inherits operator-only grants or
  // an unrelated task description from its launcher environment.
  delete mcpEnvironment.AUTODEV_MEMORY_READ_GLOBAL;
  delete mcpEnvironment.AUTODEV_MEMORY_READ_TASK_HISTORY;
  delete mcpEnvironment.AUTODEV_MEMORY_TASK_TEXT;

  const mcpEntryPoint = path.join(
    boundRepositoryRoot,
    "runtime",
    "src",
    "router",
    "memory-mcp-main.ts"
  );
  return {
    args: [
      "-c",
      `${MEMORY_MCP_CONFIG_KEY}.enabled=true`,
      "-c",
      `${MEMORY_MCP_CONFIG_KEY}.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `${MEMORY_MCP_CONFIG_KEY}.args=${JSON.stringify([mcpEntryPoint])}`
    ],
    environment: mcpEnvironment
  };
}

function usage(): string {
  return `Usage: run-provider-agent.sh --role ROLE [options]

The role is model-agnostic. The local model router chooses providers in its
configured priority order and falls back when a provider is unavailable,
quota-limited, or session-limited.

Options:
  --role ROLE          Role label (default: default)
  --prompt TEXT        Prompt to send to the role
  --prompt-file FILE   Read the prompt from FILE; use - for stdin
  --cwd DIR            Run the role against DIR instead of AutoDev
  --check              Validate the role and local router launcher only`;
}

function isRole(value: string): value is ProviderAgentRole {
  return (SUPPORTED_ROLES as readonly string[]).includes(value);
}

function stringValue(value: TomlValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function readRoleExecutionSettings(
  roleFile: string
): RoleExecutionSettings {
  const config = parseTomlFile(roleFile, "role configuration");
  return {
    developerInstructions: stringValue(config.developer_instructions),
    reasoningEffort: stringValue(config.model_reasoning_effort),
    reasoningSummary: stringValue(config.model_reasoning_summary),
    sandboxMode: stringValue(config.sandbox_mode)
  };
}

function readPromptFile(file: string): string {
  return readFileSync(file === "-" ? 0 : file, "utf8");
}

interface AnalystCodexHomes {
  readonly home: string;
  readonly codexHome: string;
  readonly sourceHome: string;
  readonly sourceCodexHome: string;
}

function resolveAnalystCodexHomes(
  environment: NodeJS.ProcessEnv
): AnalystCodexHomes {
  const requestedHome = environment.AUTODEV_PLAYTEST_ANALYST_HOME?.trim();
  const requestedCodexHome =
    environment.AUTODEV_PLAYTEST_ANALYST_CODEX_HOME?.trim();
  if (
    !requestedHome ||
    !requestedCodexHome ||
    !path.isAbsolute(requestedHome) ||
    !path.isAbsolute(requestedCodexHome)
  ) {
    throw new Error(
      "Playtest analyst dispatch requires isolated absolute HOME and CODEX_HOME paths."
    );
  }
  const relativeCodexHome = path.relative(
    path.resolve(requestedHome),
    path.resolve(requestedCodexHome)
  );
  if (
    relativeCodexHome === ".." ||
    relativeCodexHome.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCodexHome)
  ) {
    throw new Error(
      "The playtest analyst CODEX_HOME must be inside its isolated HOME."
    );
  }
  const sourceHome =
    environment.AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME?.trim() ||
    environment.HOME?.trim() ||
    homedir();
  return {
    home: path.resolve(requestedHome),
    codexHome: path.resolve(requestedCodexHome),
    sourceHome,
    sourceCodexHome:
      environment.AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME?.trim() ||
      environment.CODEX_HOME?.trim() ||
      path.join(sourceHome, ".codex")
  };
}

function copyRegularFileIfPresent(
  source: string,
  destination: string,
  description: string,
  required = false
): void {
  if (!existsSync(source)) {
    if (required) throw new Error(`${description} is unavailable.`);
    return;
  }
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`${description} is not a regular file.`);
  }
  copyFileSync(source, destination);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Copy a managed model catalog through a symlink only when it stays trusted. */
function copyAnalystModelCatalog(
  sourceCodexHome: string,
  destinationCodexHome: string,
  trustedRepositoryRoot: string
): void {
  const source = path.join(sourceCodexHome, "codex-model-catalog.json");
  if (!existsSync(source)) return;
  const sourceStat = lstatSync(source);
  let materializedSource = source;
  if (sourceStat.isSymbolicLink()) {
    materializedSource = realpathSync(source);
    if (
      !pathIsWithin(sourceCodexHome, materializedSource) &&
      !pathIsWithin(trustedRepositoryRoot, materializedSource)
    ) {
      throw new Error(
        "The source Codex model catalog link escapes trusted directories."
      );
    }
  } else if (!sourceStat.isFile()) {
    throw new Error("The source Codex model catalog is not a regular file.");
  }
  if (!statSync(materializedSource).isFile()) {
    throw new Error("The source Codex model catalog is not a regular file.");
  }
  copyFileSync(
    materializedSource,
    path.join(destinationCodexHome, "codex-model-catalog.json")
  );
}

function copyAnalystRole(homes: AnalystCodexHomes): void {
  const sourceAgents = path.join(homes.sourceCodexHome, "agents");
  const requiredRole = path.join(sourceAgents, "playtest-analyst.toml");
  copyRegularFileIfPresent(
    requiredRole,
    path.join(homes.codexHome, "agents", "playtest-analyst.toml"),
    "The materialized playtest-analyst role",
    true
  );
}

function copyAnalystSkill(
  environment: NodeJS.ProcessEnv,
  homes: AnalystCodexHomes,
  trustedRepositoryRoot: string
): void {
  const skillCandidates = [
    path.join(
      trustedRepositoryRoot,
      ".rulesync",
      "skills",
      "playtest-analysis"
    ),
    path.join(homes.sourceCodexHome, "skills", "playtest-analysis")
  ];
  const skillSource = skillCandidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isDirectory()
  );
  if (!skillSource) {
    throw new Error(
      "The playtest-analysis skill is unavailable for analyst dispatch."
    );
  }
  const isolatedSkill = path.join(
    homes.codexHome,
    "skills",
    "playtest-analysis"
  );
  mkdirSync(path.dirname(isolatedSkill), { recursive: true, mode: 0o700 });
  cpSync(skillSource, isolatedSkill, { recursive: true, dereference: true });
}

function prepareAnalystCodexHome(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  // The runtime source root and AutoDev's managed configuration live in
  // different trees once the Runtime is materialized into CODEX_HOME: the
  // Runtime runs from the installed copy, while the model catalog and the
  // analysis skill are the checkout's. Both are trusted, and the launcher's
  // configuration root names the second one.
  const trustedRepositoryRoot = resolveRuntimeSourceRoot(
    import.meta.dirname,
    environment.AUTODEV_CONFIGURATION_ROOT?.trim() ||
      environment.AUTODEV_REPO_ROOT
  );
  const homes = resolveAnalystCodexHomes(environment);
  mkdirSync(path.join(homes.codexHome, "agents"), {
    recursive: true,
    mode: 0o700
  });
  chmodSync(homes.home, 0o700);
  chmodSync(homes.codexHome, 0o700);
  copyAnalystRole(homes);
  copyRegularFileIfPresent(
    path.join(homes.sourceCodexHome, CODEX_CONFIG_FILE),
    path.join(homes.codexHome, CODEX_CONFIG_FILE),
    "The source Codex configuration",
    true
  );
  copyAnalystModelCatalog(
    homes.sourceCodexHome,
    homes.codexHome,
    trustedRepositoryRoot
  );
  copyAnalystSkill(environment, homes, trustedRepositoryRoot);
  return {
    ...environment,
    HOME: homes.home,
    CODEX_HOME: homes.codexHome,
    AUTODEV_PLAYTEST_ANALYSIS_MODE: "1",
    AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME: homes.sourceHome,
    AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME: homes.sourceCodexHome
  };
}

export function parseProviderAgentArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): ProviderAgentOptions {
  let role = "default";
  let workspace = env.AUTODEV_REPO_ROOT?.trim() || repositoryRoot;
  let prompt = "";
  let promptFile = "";
  let checkOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--role": {
        role = argv[(index += 1)] ?? "";
        break;
      }
      case "--prompt": {
        prompt = argv[(index += 1)] ?? "";
        break;
      }
      case "--prompt-file": {
        promptFile = argv[(index += 1)] ?? "";
        break;
      }
      case "--cwd":
      case "-C": {
        workspace = argv[(index += 1)] ?? "";
        break;
      }
      case "--check": {
        checkOnly = true;
        break;
      }
      case "--help":
      case "-h": {
        throw new Error(usage());
      }
      case "--provider": {
        throw new Error(
          "--provider is obsolete; select a capability role with --role instead."
        );
      }
      default: {
        throw new Error(`Unknown option: ${argument ?? ""}\n${usage()}`);
      }
    }
  }
  if (!isRole(role)) throw new Error(`Unsupported role: ${role}\n${usage()}`);
  if (promptFile) prompt = readPromptFile(promptFile);
  if (!workspace || !existsSync(workspace))
    throw new Error(`Workspace is not a directory: ${workspace}`);
  const normalizedWorkspace = path.resolve(workspace);
  const analystDispatch = env.AUTODEV_PLAYTEST_ANALYSIS_MODE === "1";
  const sourceHome =
    env.AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME?.trim() ||
    env.HOME?.trim() ||
    homedir();
  const home = analystDispatch
    ? env.AUTODEV_PLAYTEST_ANALYST_HOME?.trim() || ""
    : sourceHome;
  const codexHome = analystDispatch
    ? env.AUTODEV_PLAYTEST_ANALYST_CODEX_HOME?.trim() || ""
    : env.CODEX_HOME?.trim() || path.join(home, ".codex");
  if (
    analystDispatch &&
    (!path.isAbsolute(home) || !path.isAbsolute(codexHome))
  ) {
    throw new Error(
      "Playtest analyst dispatch requires isolated absolute HOME and CODEX_HOME paths."
    );
  }
  const roleFile = path.join(codexHome, "agents", `${role}.toml`);
  if (!existsSync(roleFile))
    throw new Error(`Missing materialized role: ${roleFile}`);
  return {
    role,
    workspace: normalizedWorkspace,
    prompt,
    checkOnly,
    repositoryRoot: env.AUTODEV_REPO_ROOT?.trim() || repositoryRoot,
    codexHome,
    codexBinary: resolveCodexBinary(env, sourceHome),
    roleFile
  };
}

function loadEnvironmentFile(
  file: string,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (!existsSync(file)) return environment;
  const result = { ...environment };
  for (const rawLine of readFileSync(file, "utf8").split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7) : line;
    const separator = assignment.indexOf("=");
    if (separator < 1) continue;
    const key = assignment.slice(0, separator).trim();
    let value = assignment.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (result[key] === undefined || result[key] === "") {
      result[key] = value;
    }
  }
  return result;
}

function tomlRecord(value: TomlValue | undefined): Record<string, TomlValue> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
    ? (value as Record<string, TomlValue>)
    : {};
}

function stringArray(value: TomlValue | undefined): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function analystMcpEnvironmentVariables(roleFile: string): string[] {
  const role = parseTomlFile(roleFile, "playtest analyst role");
  const playtest = tomlRecord(tomlRecord(role.mcp_servers).playtest);
  const variables = stringArray(playtest.env_vars);
  if (variables.length === 0 || new Set(variables).size !== variables.length) {
    throw new Error(
      "The playtest analyst role must declare a unique MCP environment allowlist."
    );
  }
  return variables;
}

function roleSkillsConfigOverride(value: TomlValue, roleName: string): string {
  if (!Array.isArray(value)) {
    throw new TypeError(`The ${roleName} skills.config must be an array.`);
  }
  const names = new Set<string>();
  const entries = value.map((item) => {
    const skill = tomlRecord(item);
    const name = skill.name;
    const enabled = skill.enabled;
    if (
      Object.keys(skill).some((key) => key !== "name" && key !== "enabled") ||
      typeof name !== "string" ||
      name.trim().length === 0 ||
      typeof enabled !== "boolean" ||
      names.has(name)
    ) {
      throw new Error(
        `The ${roleName} skills.config must contain unique name/enabled entries.`
      );
    }
    names.add(name);
    return `{name=${JSON.stringify(name)},enabled=${String(enabled)}}`;
  });
  return `skills.config=[${entries.join(",")}]`;
}

function analystCodexOverrides(
  roleFile: string,
  sourceCodexHome: string,
  autoDevRoot: string
): readonly string[] {
  const role = parseTomlFile(roleFile, "playtest analyst role");
  const roleMcpServers = tomlRecord(role.mcp_servers);
  const playtestServer = tomlRecord(roleMcpServers.playtest);
  const enabledTools = stringArray(playtestServer.enabled_tools);
  if (
    role.sandbox_mode !== "read-only" ||
    enabledTools.length === 0 ||
    new Set(enabledTools).size !== enabledTools.length ||
    enabledTools.some((tool) => !tool.startsWith("playtest."))
  ) {
    throw new Error(
      "The playtest analyst role must be read-only and allowlist only Playtesting tools."
    );
  }
  const baseConfig = parseTomlFile(
    path.join(sourceCodexHome, CODEX_CONFIG_FILE),
    "base Codex configuration",
    false
  );
  const configuredServers = new Set([
    ...Object.keys(tomlRecord(baseConfig.mcp_servers)),
    ...Object.keys(roleMcpServers)
  ]);
  configuredServers.delete("playtest");
  const configKey = (name: string): string =>
    TOML_BARE_KEY_PATTERN.test(name) ? name : JSON.stringify(name);
  const mcpEntry = resolveRuntimeSourcePath(
    autoDevRoot,
    "playtesting/mcp-main.ts"
  );
  const args = [
    "features.shell_tool=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "features.hooks=false",
    'web_search="disabled"',
    'shell_environment_policy.inherit="none"'
  ];
  for (const name of configuredServers) {
    args.push(`mcp_servers.${configKey(name)}.enabled=false`);
  }
  args.push(
    "mcp_servers.playtest.enabled=true",
    `mcp_servers.playtest.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.playtest.args=${JSON.stringify([mcpEntry])}`,
    'mcp_servers.playtest.default_tools_approval_mode="approve"',
    `mcp_servers.playtest.enabled_tools=${JSON.stringify(enabledTools)}`,
    // Codex itself runs in the isolated home, but the trusted Playtesting MCP
    // must read the Runtime's real approval, artifact and OpenLIT stores, which
    // all root at the source CODEX_HOME. Bind it explicitly instead of letting
    // the isolated (and possibly symlinked, e.g. macOS /tmp) home pass through.
    `mcp_servers.playtest.env_vars=${JSON.stringify(
      analystMcpEnvironmentVariables(roleFile).filter(
        (name) => name !== "CODEX_HOME"
      )
    )}`,
    `mcp_servers.playtest.env={CODEX_HOME=${JSON.stringify(sourceCodexHome)}}`
  );
  const rolePlugins = tomlRecord(role.plugins);
  if (Object.keys(rolePlugins).length > 0) {
    const configuredPlugins = tomlRecord(baseConfig.plugins);
    const pluginNames = new Set([
      ...Object.keys(configuredPlugins),
      ...Object.keys(rolePlugins)
    ]);
    for (const plugin of [...pluginNames].sort()) {
      const rolePlugin = tomlRecord(rolePlugins[plugin]);
      args.push(
        `plugins.${configKey(plugin)}.enabled=${rolePlugin?.enabled === true}`
      );
    }
  }
  const roleSkills = tomlRecord(role.skills);
  if (typeof roleSkills.include_instructions === "boolean") {
    args.push(`skills.include_instructions=${roleSkills.include_instructions}`);
  }
  const bundledSkills = tomlRecord(roleSkills.bundled);
  if (typeof bundledSkills.enabled === "boolean") {
    args.push(`skills.bundled.enabled=${bundledSkills.enabled}`);
  }
  if (roleSkills.config !== undefined) {
    args.push(roleSkillsConfigOverride(roleSkills.config, "playtest analyst"));
  }
  return args;
}

const PLAYTEST_ANALYST_ENVIRONMENT_KEYS = [
  "PATH",
  "CODEX_BIN",
  "AUTODEV_NODE_BIN",
  "NODE_OPTIONS",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CODEX_ROUTER_AUTH_TOKEN",
  "AUTODEV_REPO_ROOT",
  "CLICKHOUSE_URL",
  "OPENLIT_DB_USER",
  "OPENLIT_DB_NAME",
  "AUTODEV_PLAYTEST_WORKSPACE_ID",
  "AUTODEV_PLAYTEST_ROLE",
  "AUTODEV_PLAYTEST_ACTOR_ID",
  "AUTODEV_PLAYTEST_TASK_ID",
  "AUTODEV_PLAYTEST_RUN_ID",
  "AUTODEV_PLAYTEST_ANALYSIS_ID",
  "AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS",
  "AUTODEV_PLAYTEST_ANALYSIS_KIND",
  "AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION",
  "AUTODEV_PLAYTEST_REPOSITORY_ROOT"
] as const;

function analystCodexEnvironment(
  environment: NodeJS.ProcessEnv,
  options: ProviderAgentOptions
): NodeJS.ProcessEnv {
  const sourceCodexHome =
    environment.AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME?.trim() ||
    environment.CODEX_HOME?.trim() ||
    path.join(
      environment.AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME?.trim() ||
        environment.HOME?.trim() ||
        homedir(),
      ".codex"
    );
  const loaded = loadEnvironmentFile(
    environment.CODEX_ENV_FILE?.trim() || path.join(sourceCodexHome, ".env"),
    environment
  );
  const result: NodeJS.ProcessEnv = {};
  for (const key of PLAYTEST_ANALYST_ENVIRONMENT_KEYS) {
    const value = loaded[key];
    if (value !== undefined) result[key] = value;
  }
  result.HOME =
    environment.AUTODEV_PLAYTEST_ANALYST_HOME?.trim() ||
    path.dirname(options.codexHome);
  result.CODEX_HOME = options.codexHome;
  // Code-mode follow-up requests still need an explicit Router project root.
  // This role's working directory is the private empty workspace, not the game
  // checkout, so bind attribution to that same isolated directory.
  result.CODEX_PROJECT_ROOT = options.workspace;
  result.AUTODEV_REPO_ROOT = options.repositoryRoot;
  result.AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME =
    environment.AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME?.trim() ||
    environment.HOME?.trim() ||
    homedir();
  result.AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME = sourceCodexHome;
  return result;
}

function bindPlaytesterMcpContext(
  environment: NodeJS.ProcessEnv,
  options: ProviderAgentOptions
): NodeJS.ProcessEnv {
  const existingRole = environment.AUTODEV_PLAYTEST_ROLE?.trim();
  const existingControlRole =
    environment.AUTODEV_PLAYTEST_CONTROL_API_ROLE?.trim();
  if (
    (existingRole && existingRole !== PLAYTESTER_ROLE) ||
    (existingControlRole && existingControlRole !== PLAYTESTER_ROLE)
  ) {
    throw new Error("Playtester MCP context is bound to another role.");
  }
  const required = [
    "AUTODEV_PLAYTEST_WORKSPACE_ID",
    "AUTODEV_PLAYTEST_ACTOR_ID",
    "AUTODEV_PLAYTEST_TASK_ID",
    "AUTODEV_PLAYTEST_RUN_ID",
    "AUTODEV_PLAYTEST_CONTROL_API_ACTOR"
  ] as const;
  const missing = required.filter((name) => !environment[name]?.trim());
  const secretFileEnvironment = { ...environment };
  delete secretFileEnvironment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
  const runnerToken = readRuntimeSecret(
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN",
    secretFileEnvironment
  );
  if (
    missing.length > 0 ||
    !runnerToken ||
    (!environment.AUTODEV_CONTROL_API_BASE_URL?.trim() &&
      !environment.AUTODEV_CONTROL_API_LISTEN_HOST?.trim())
  ) {
    throw new Error(
      "Playtester dispatch requires trusted workspace/session context and the dedicated Control API runner credential."
    );
  }
  const boundEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    AUTODEV_PLAYTEST_ROLE: PLAYTESTER_ROLE,
    AUTODEV_PLAYTEST_CONTROL_API_ROLE: PLAYTESTER_ROLE,
    CODEX_HOME: options.codexHome,
    AUTODEV_REPO_ROOT: options.repositoryRoot,
    AUTODEV_PLAYTEST_REPOSITORY_ROOT:
      environment.AUTODEV_PLAYTEST_REPOSITORY_ROOT?.trim() || options.workspace
  };
  // The MCP child reads the separate runner token from CODEX_HOME's protected
  // secret file. Do not put that credential into the model process environment.
  delete boundEnvironment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
  return boundEnvironment;
}

/** The sanitized process environment for an isolated Browser Tester run. */
function browserTesterEnvironment(
  options: ProviderAgentOptions,
  providerEnvironment: NodeJS.ProcessEnv,
  executionEnvironment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of BROWSER_TESTER_PROCESS_ENVIRONMENT_VARIABLES) {
    const value = providerEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.HOME = executionEnvironment.HOME?.trim() || homedir();
  environment.CODEX_HOME = options.codexHome;
  environment.AUTODEV_REPO_ROOT = options.repositoryRoot;
  environment.CODEX_PROJECT_ROOT = options.workspace;
  environment.AUTODEV_NODE_BIN =
    executionEnvironment.AUTODEV_NODE_BIN?.trim() || process.execPath;
  return environment;
}

function providerCodexEnvironment(
  options: ProviderAgentOptions,
  executionEnvironment: NodeJS.ProcessEnv,
  analystDispatch: boolean
): MemoryMcpLaunch {
  const providerEnvironment = analystDispatch
    ? analystCodexEnvironment(executionEnvironment, options)
    : {
        ...loadEnvironmentFile(
          executionEnvironment.CODEX_ENV_FILE?.trim() ||
            path.join(options.codexHome, ".env"),
          executionEnvironment
        )
      };
  // Control credentials are never sent to the model process. Playtest MCP
  // reads its dedicated runner token directly from the protected secret file.
  delete providerEnvironment.AUTODEV_CONTROL_API_TOKEN;
  delete providerEnvironment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
  delete providerEnvironment.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN;
  if (options.role === BROWSER_TESTER_ROLE) {
    return {
      args: [],
      environment: browserTesterEnvironment(
        options,
        providerEnvironment,
        executionEnvironment
      )
    };
  }
  if (options.role === PLAYTESTER_ROLE) {
    const environment = bindPlaytesterMcpContext(providerEnvironment, options);
    for (const key of Object.keys(environment)) {
      if (key.startsWith("AUTODEV_MEMORY_")) delete environment[key];
    }
    return { args: [], environment };
  }
  if (options.role === PLAYTEST_ANALYST_ROLE) {
    for (const key of Object.keys(providerEnvironment)) {
      if (key.startsWith("AUTODEV_MEMORY_")) delete providerEnvironment[key];
    }
  }
  const gitIdentity =
    options.role === PLAYTEST_ANALYST_ROLE
      ? {}
      : gitCommitIdentityEnv({ role: options.role, provider: "codex" });
  return configureMemoryMcp(options, {
    ...providerEnvironment,
    ...gitIdentity
  });
}

const BROWSER_TESTER_ENABLED_TOOLS = [
  "browser_navigate",
  "browser_tabs",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_find",
  "browser_hover",
  "browser_select_option",
  "browser_drag",
  "browser_handle_dialog",
  "browser_resize",
  "browser_close"
] as const;

const BROWSER_TESTER_MCP_ENVIRONMENT_VARIABLES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "AUTODEV_REPO_ROOT",
  "AUTODEV_NODE_BIN",
  "PLAYWRIGHT_BROWSERS_PATH"
] as const;

const BROWSER_TESTER_PROCESS_ENVIRONMENT_VARIABLES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CODEX_ROUTER_AUTH_TOKEN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "PLAYWRIGHT_BROWSERS_PATH"
] as const;

const PLAYTESTER_ENABLED_TOOLS = [
  "playtest.capabilities",
  "playtest.run",
  "playtest.lookupRequest",
  "playtest.wait",
  "playtest.activeRuns",
  "playtest.cancel",
  "playtest.listEpisodes",
  "playtest.readEpisode",
  "playtest.readWindow"
] as const;

const PLAYTESTER_MCP_ENVIRONMENT_VARIABLES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "AUTODEV_NODE_BIN",
  "AUTODEV_PLAYTEST_WORKSPACE_ID",
  "AUTODEV_PLAYTEST_ROLE",
  "AUTODEV_PLAYTEST_ACTOR_ID",
  "AUTODEV_PLAYTEST_TASK_ID",
  "AUTODEV_PLAYTEST_RUN_ID",
  "AUTODEV_PLAYTEST_REPOSITORY_ROOT",
  "AUTODEV_REPO_ROOT",
  "CODEX_HOME",
  "AUTODEV_OPENLIT_SECRET_FILE",
  "CLICKHOUSE_URL",
  "OPENLIT_DB_USER",
  "OPENLIT_DB_NAME",
  "AUTODEV_CONTROL_API_BASE_URL",
  "AUTODEV_CONTROL_API_LISTEN_HOST",
  "AUTODEV_CONTROL_API_LISTEN_PORT",
  "AUTODEV_PLAYTEST_CONTROL_API_ACTOR",
  "AUTODEV_PLAYTEST_CONTROL_API_ROLE"
] as const;

/**
 * The bounded playtester role gets the local, trusted Playtesting MCP
 * transport only. This mirrors the analyst's defense-in-depth re-assertion:
 * the role file (playtester.toml) already declares the exact bounded runner
 * tool set, read-only sandbox, disabled shell, and the trusted
 * session/credential environment allowlist, but Codex's own strict-config
 * command-line overrides win regardless of file drift, and every other
 * configured MCP server is explicitly disabled rather than assumed off.
 * Playtest MCP enablement never happens globally; it is only ever injected
 * for this one role's own Codex invocation.
 */
function browserTesterCodexOverrides(
  options: ProviderAgentOptions
): readonly string[] {
  const role = parseTomlFile(options.roleFile, "browser-tester role");
  const roleMcpServers = tomlRecord(role.mcp_servers);
  const playwrightServer = tomlRecord(roleMcpServers.playwright);
  const enabledTools = stringArray(playwrightServer.enabled_tools);
  const expectedTools = new Set<string>(BROWSER_TESTER_ENABLED_TOOLS);
  const envVars = stringArray(playwrightServer.env_vars);
  const expectedEnvVars = new Set<string>(
    BROWSER_TESTER_MCP_ENVIRONMENT_VARIABLES
  );
  const features = tomlRecord(role.features);
  const tools = tomlRecord(role.tools);
  const shellEnvironmentPolicy = tomlRecord(role.shell_environment_policy);
  const rolePlugins = tomlRecord(role.plugins);
  if (
    role.name !== BROWSER_TESTER_ROLE ||
    playwrightServer.enabled !== true ||
    role.sandbox_mode !== "read-only" ||
    features.shell_tool !== false ||
    features.multi_agent !== false ||
    features.multi_agent_v2 !== false ||
    features.hooks !== false ||
    features.memories !== false ||
    tools.web_search !== false ||
    shellEnvironmentPolicy.inherit !== "none" ||
    Object.values(rolePlugins).some(
      (plugin) => tomlRecord(plugin).enabled !== false
    ) ||
    enabledTools.length !== expectedTools.size ||
    new Set(enabledTools).size !== enabledTools.length ||
    !enabledTools.every((tool) => expectedTools.has(tool)) ||
    envVars.length !== expectedEnvVars.size ||
    new Set(envVars).size !== envVars.length ||
    !envVars.every((name) => expectedEnvVars.has(name))
  ) {
    throw new Error(
      "The browser-tester role must be read-only, shell-disabled, and allowlist only its exact Playwright tools and environment."
    );
  }

  const baseConfig = parseTomlFile(
    path.join(options.codexHome, CODEX_CONFIG_FILE),
    "base Codex configuration",
    false
  );
  const configuredServers = new Set([
    ...Object.keys(tomlRecord(baseConfig.mcp_servers)),
    ...Object.keys(roleMcpServers)
  ]);
  configuredServers.delete("playwright");
  const configKey = (name: string): string =>
    TOML_BARE_KEY_PATTERN.test(name) ? name : JSON.stringify(name);
  const mcpEntry = resolveRuntimeSourcePath(
    options.repositoryRoot,
    "mcp/launcher.ts"
  );
  const args = [
    "features.shell_tool=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "features.hooks=false",
    "features.memories=false",
    'web_search="disabled"',
    'shell_environment_policy.inherit="none"'
  ];
  for (const name of configuredServers) {
    args.push(`mcp_servers.${configKey(name)}.enabled=false`);
  }
  args.push(
    "mcp_servers.playwright.enabled=true",
    `mcp_servers.playwright.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.playwright.args=${JSON.stringify([mcpEntry, "playwright"])}`,
    'mcp_servers.playwright.default_tools_approval_mode="approve"',
    `mcp_servers.playwright.enabled_tools=${JSON.stringify(BROWSER_TESTER_ENABLED_TOOLS)}`,
    `mcp_servers.playwright.env_vars=${JSON.stringify(BROWSER_TESTER_MCP_ENVIRONMENT_VARIABLES)}`,
    `mcp_servers.playwright.env={CODEX_HOME=${JSON.stringify(options.codexHome)},AUTODEV_REPO_ROOT=${JSON.stringify(options.repositoryRoot)},AUTODEV_NODE_BIN=${JSON.stringify(process.execPath)}}`
  );

  const configuredPlugins = new Set([
    ...Object.keys(tomlRecord(baseConfig.plugins)),
    ...Object.keys(rolePlugins)
  ]);
  for (const name of [...configuredPlugins].sort()) {
    const rolePlugin = tomlRecord(rolePlugins[name]);
    args.push(
      `plugins.${configKey(name)}.enabled=${rolePlugin?.enabled === true}`
    );
  }
  const roleSkills = tomlRecord(role.skills);
  if (typeof roleSkills.include_instructions === "boolean") {
    args.push(`skills.include_instructions=${roleSkills.include_instructions}`);
  }
  const bundledSkills = tomlRecord(roleSkills.bundled);
  if (typeof bundledSkills.enabled === "boolean") {
    args.push(`skills.bundled.enabled=${bundledSkills.enabled}`);
  }
  if (roleSkills.config !== undefined) {
    args.push(roleSkillsConfigOverride(roleSkills.config, BROWSER_TESTER_ROLE));
  }
  return args;
}

function playtesterCodexOverrides(
  options: ProviderAgentOptions
): readonly string[] {
  const role = parseTomlFile(options.roleFile, "playtester role");
  const roleMcpServers = tomlRecord(role.mcp_servers);
  const playtestServer = tomlRecord(roleMcpServers.playtest);
  const enabledTools = stringArray(playtestServer.enabled_tools);
  const expectedTools = new Set<string>(PLAYTESTER_ENABLED_TOOLS);
  const features = tomlRecord(role.features);
  const tools = tomlRecord(role.tools);
  const shellEnvironmentPolicy = tomlRecord(role.shell_environment_policy);
  const rolePlugins = tomlRecord(role.plugins);
  if (
    role.name !== PLAYTESTER_ROLE ||
    playtestServer.enabled !== true ||
    role.sandbox_mode !== "read-only" ||
    features.shell_tool !== false ||
    features.multi_agent !== false ||
    features.multi_agent_v2 !== false ||
    features.hooks !== false ||
    features.memories !== false ||
    tools.web_search !== false ||
    shellEnvironmentPolicy.inherit !== "none" ||
    Object.values(tomlRecord(role.plugins)).some(
      (plugin) => tomlRecord(plugin).enabled !== false
    ) ||
    enabledTools.length !== expectedTools.size ||
    new Set(enabledTools).size !== enabledTools.length ||
    !enabledTools.every((tool) => expectedTools.has(tool))
  ) {
    throw new Error(
      "The playtester role must be read-only, shell-disabled, and allowlist only the exact approved runner Playtesting tools."
    );
  }
  const envVars = stringArray(playtestServer.env_vars);
  const expectedEnvVars = new Set<string>(PLAYTESTER_MCP_ENVIRONMENT_VARIABLES);
  if (
    envVars.length !== expectedEnvVars.size ||
    new Set(envVars).size !== envVars.length ||
    !envVars.every((name) => expectedEnvVars.has(name))
  ) {
    throw new Error(
      "The playtester role must declare the exact trusted Playtesting MCP environment allowlist."
    );
  }
  const baseConfig = parseTomlFile(
    path.join(options.codexHome, CODEX_CONFIG_FILE),
    "base Codex configuration",
    false
  );
  const configuredServers = new Set([
    ...Object.keys(tomlRecord(baseConfig.mcp_servers)),
    ...Object.keys(roleMcpServers)
  ]);
  configuredServers.delete("playtest");
  const configKey = (name: string): string =>
    TOML_BARE_KEY_PATTERN.test(name) ? name : JSON.stringify(name);
  const mcpEntry = resolveRuntimeSourcePath(
    options.repositoryRoot,
    "playtesting/mcp-main.ts"
  );
  const args = [
    "features.shell_tool=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "features.hooks=false",
    "features.memories=false",
    'web_search="disabled"',
    'shell_environment_policy.inherit="none"'
  ];
  for (const name of configuredServers) {
    args.push(`mcp_servers.${configKey(name)}.enabled=false`);
  }
  args.push(
    "mcp_servers.playtest.enabled=true",
    `mcp_servers.playtest.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.playtest.args=${JSON.stringify([mcpEntry])}`,
    'mcp_servers.playtest.default_tools_approval_mode="approve"',
    `mcp_servers.playtest.enabled_tools=${JSON.stringify(PLAYTESTER_ENABLED_TOOLS)}`,
    `mcp_servers.playtest.env_vars=${JSON.stringify(PLAYTESTER_MCP_ENVIRONMENT_VARIABLES)}`
  );
  const configuredPlugins = new Set([
    ...Object.keys(tomlRecord(baseConfig.plugins)),
    ...Object.keys(rolePlugins)
  ]);
  for (const name of [...configuredPlugins].sort()) {
    const rolePlugin = tomlRecord(rolePlugins[name]);
    args.push(
      `plugins.${configKey(name)}.enabled=${rolePlugin?.enabled === true}`
    );
  }
  const roleSkills = tomlRecord(role.skills);
  if (typeof roleSkills.include_instructions === "boolean") {
    args.push(`skills.include_instructions=${roleSkills.include_instructions}`);
  }
  const bundledSkills = tomlRecord(roleSkills.bundled);
  if (typeof bundledSkills.enabled === "boolean") {
    args.push(`skills.bundled.enabled=${bundledSkills.enabled}`);
  }
  if (roleSkills.config !== undefined) {
    args.push(roleSkillsConfigOverride(roleSkills.config, PLAYTESTER_ROLE));
  }
  return args;
}

function providerCodexArguments(
  options: ProviderAgentOptions,
  settings: RoleExecutionSettings,
  memory: MemoryMcpLaunch,
  analystDispatch: boolean,
  executionEnvironment: NodeJS.ProcessEnv
): string[] {
  const args = ["--strict-config", "-C", options.workspace];
  if (settings.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${settings.reasoningEffort}`);
  }
  if (settings.reasoningSummary) {
    args.push("-c", `model_reasoning_summary=${settings.reasoningSummary}`);
  }
  if (settings.sandboxMode) {
    args.push("-c", `sandbox_mode=${settings.sandboxMode}`);
  }
  if (analystDispatch) {
    const sourceCodexHome =
      executionEnvironment.AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME?.trim() ||
      executionEnvironment.CODEX_HOME?.trim() ||
      path.join(
        executionEnvironment.AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME?.trim() ||
          homedir(),
        ".codex"
      );
    args.push(
      ...analystCodexOverrides(
        options.roleFile,
        sourceCodexHome,
        options.repositoryRoot
      ).flatMap((override) => ["-c", override])
    );
  }
  if (options.role === BROWSER_TESTER_ROLE) {
    args.push(
      ...browserTesterCodexOverrides(options).flatMap((override) => [
        "-c",
        override
      ])
    );
  }
  if (options.role === PLAYTESTER_ROLE) {
    args.push(
      ...playtesterCodexOverrides(options).flatMap((override) => [
        "-c",
        override
      ])
    );
  }
  args.push(
    ...memory.args,
    "-c",
    `shell_environment_policy.filters.AUTODEV_MEMORY_DATABASE_URL=${JSON.stringify("exclude")}`,
    "exec",
    "--model",
    `autodev/${options.role}`,
    "--ephemeral",
    "--json",
    "--skip-git-repo-check",
    buildProviderPrompt(options.prompt, settings)
  );
  return args;
}

async function checkProviderAgentRole(
  options: ProviderAgentOptions,
  environment: NodeJS.ProcessEnv,
  execute: NonNullable<ProviderAgentDeps["runCodex"]>
): Promise<number> {
  const result = await execute(
    options.codexBinary,
    [
      "--strict-config",
      "-C",
      options.repositoryRoot,
      "exec",
      "--model",
      `autodev/${options.role}`,
      "--help"
    ],
    environment,
    true
  );
  if (result !== 0) {
    throw new Error(`Codex role validation failed for ${options.role}`);
  }
  process.stdout.write(
    `role=${options.role} model=autodev/${options.role} router=http://127.0.0.1:4100/v1 status=ready\n`
  );
  return 0;
}

async function ensureRouter(environment: NodeJS.ProcessEnv): Promise<void> {
  const options = resolveRouterEnsureOptions(environment, process.pid);
  const result = await runRouterEnsure(
    createDefaultRouterEnsureDeps(options),
    options
  );
  if (result.exitCode !== 0)
    throw new Error(result.message ?? "model router ensure failed");
}

export function buildProviderPrompt(
  prompt: string,
  settings: RoleExecutionSettings
): string {
  return [
    "Provider-neutral role instructions:",
    settings.developerInstructions,
    "Tool invocation:",
    "This Runtime launches roles in AutoDev Code Mode. When MCP tools are provided in Code Mode, call them only from the `exec` JavaScript tool using exact `tools.mcp__<server>__<tool>` names advertised in `ALL_TOOLS`. Provider-managed bridge roles may instead expose their role-scoped MCP tools through the provider's native MCP interface; use only tools actually exposed there. Dotted names in role instructions describe operations and are not necessarily callable syntax. Never infer tool absence from the parent session's tool list, and never compensate by enabling or probing an unrelated/global MCP server. If neither authorized surface exposes the role's tools, report that boundary and stop. Do not invoke shell, filesystem, network, or unconfigured tools.",
    "Bounded task:",
    prompt
  ].join("\n");
}

export function runCodex(
  binary: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  checkOnly: boolean
): Promise<number> {
  if (checkOnly) {
    return Promise.resolve(
      spawnSync(binary, args, {
        stdio: "ignore",
        env: environment
      }).status ?? 1
    );
  }
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: environment
    });
    let interruptedBy: NodeJS.Signals | null = null;
    let forceKill: NodeJS.Timeout | undefined;
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (forceKill) clearTimeout(forceKill);
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
      resolve(
        interruptedBy === null
          ? (exitCode ?? 1)
          : interruptedBy === "SIGINT"
            ? 130
            : interruptedBy === "SIGHUP"
              ? 129
              : 143
      );
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = (): void => {
        if (interruptedBy !== null) return;
        interruptedBy = signal;
        child.kill(signal);
        forceKill = setTimeout(() => child.kill("SIGKILL"), 3000);
        forceKill.unref();
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    child.once("error", () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
      if (!settled) {
        settled = true;
        if (forceKill) clearTimeout(forceKill);
        reject(new Error("Codex role process could not be started."));
      }
    });
    child.once("close", (exitCode) => finish(exitCode));
  });
}

interface ProviderAgentRuntimeEnvironment {
  readonly analystDispatch: boolean;
  readonly execution: NodeJS.ProcessEnv;
  readonly router: NodeJS.ProcessEnv;
}

function requestedProviderAgentRole(argv: readonly string[]): string {
  let role = "default";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--role") role = argv[index + 1] ?? "";
  }
  return role;
}

function providerAgentRuntimeEnvironment(
  environment: NodeJS.ProcessEnv
): ProviderAgentRuntimeEnvironment {
  if (environment.AUTODEV_PLAYTEST_ANALYSIS_MODE !== "1") {
    const sourceHome = environment.HOME?.trim() || homedir();
    const sourceCodexHome =
      environment.CODEX_HOME?.trim() || path.join(sourceHome, ".codex");
    const loaded = loadEnvironmentFile(
      environment.CODEX_ENV_FILE?.trim() || path.join(sourceCodexHome, ".env"),
      environment
    );
    // Control credentials belong to Runtime-owned MCP processes, not this
    // provider-agent process or the router readiness probe. Playtest's
    // dedicated token is read from the protected secret file by the MCP.
    delete loaded.AUTODEV_CONTROL_API_TOKEN;
    delete loaded.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
    delete loaded.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN;
    return {
      analystDispatch: false,
      execution: loaded,
      router: loaded
    };
  }
  const sourceHome =
    environment.AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME?.trim() ||
    environment.HOME?.trim() ||
    homedir();
  const sourceCodexHome =
    environment.AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME?.trim() ||
    environment.CODEX_HOME?.trim() ||
    path.join(sourceHome, ".codex");
  const setupEnvironment = loadEnvironmentFile(
    environment.CODEX_ENV_FILE?.trim() || path.join(sourceCodexHome, ".env"),
    environment
  );
  const execution = prepareAnalystCodexHome(setupEnvironment);
  return {
    analystDispatch: true,
    execution,
    router: {
      ...execution,
      HOME: sourceHome,
      CODEX_HOME: sourceCodexHome
    }
  };
}

export async function runProviderAgent(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: ProviderAgentDeps = {}
): Promise<number> {
  if (argv.some((argument) => argument === "--help" || argument === "-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const requestedRole = requestedProviderAgentRole(argv);
  const analystDispatch = requestedRole === PLAYTEST_ANALYST_ROLE;
  if (env.AUTODEV_PLAYTEST_ANALYSIS_MODE === "1" && !analystDispatch) {
    throw new Error(
      "The isolated Playtesting analysis context is analyst-only."
    );
  }
  const runtimeEnvironment = providerAgentRuntimeEnvironment(
    analystDispatch ? { ...env, AUTODEV_PLAYTEST_ANALYSIS_MODE: "1" } : env
  );
  const options = parseProviderAgentArgs(argv, runtimeEnvironment.execution);
  await (deps.ensureRouter ?? ensureRouter)(runtimeEnvironment.router);
  const execute = deps.runCodex ?? runCodex;
  if (options.checkOnly) {
    return checkProviderAgentRole(
      options,
      runtimeEnvironment.execution,
      execute
    );
  }
  if (!options.prompt) {
    throw new Error(
      "Provide --prompt or --prompt-file (use --prompt-file - for stdin)."
    );
  }
  const settings = readRoleExecutionSettings(options.roleFile);
  if (
    runtimeEnvironment.analystDispatch &&
    settings.sandboxMode !== "read-only"
  ) {
    throw new Error(
      "Playtest analyst dispatch requires the read-only sandbox."
    );
  }
  const memory = providerCodexEnvironment(
    options,
    runtimeEnvironment.execution,
    runtimeEnvironment.analystDispatch
  );
  const args = providerCodexArguments(
    options,
    settings,
    memory,
    runtimeEnvironment.analystDispatch,
    runtimeEnvironment.execution
  );
  return execute(options.codexBinary, args, memory.environment, false);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runProviderAgent();
  } catch (error: unknown) {
    writeErrorLine(
      `run-provider-agent: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}
