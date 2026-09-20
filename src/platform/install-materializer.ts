import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCompose } from "../config/compose-user-config.ts";
import { renderAgentDirectory } from "../config/render-agent-configs.ts";
import { runBridgeMcpCatalogue } from "../config/render-bridge-mcp-catalogue.ts";
import {
  atomicWrite,
  parseTomlFile,
  serializeToml,
  type TomlTable
} from "../config/toml.ts";
import { writeErrorLine } from "../shared/output.ts";
import {
  updateAntigravityPermissions,
  updateAntigravitySkills
} from "./antigravity-settings.ts";
import { renderLaunchAgent } from "./macos/launchagent.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import {
  linkRuntimeSource,
  linkSkillSource,
  materializeRuntimeFile,
  runtimeTarget
} from "./runtime-files.ts";
import { removeStalePaths } from "./runtime-reconciliation.ts";

export const RUNTIME_MODULES = [
  "src/shared/resolve-workspace.ts",
  "src/agents/bridge-role.ts",
  "src/telemetry/agent-events.ts",
  "src/agents/agent-activity.ts",
  "src/shared/provider-limits.ts",
  "src/shared/responses-item-ids.ts",
  "src/shared/responses-continuation.ts",
  "src/shared/output.ts",
  "src/agents/spawn-tools.ts",
  "src/router/state-collector.ts",
  "src/router/routing.ts",
  "src/router/cooldown.ts",
  "src/router/responses.ts",
  "src/router/concurrency.ts",
  "src/router/lifecycle.ts",
  "src/router/auth.ts",
  "src/router/events.ts",
  "src/router/subagents.ts",
  "src/router/persistence.ts",
  "src/router/usage.ts",
  "src/router/otel.ts",
  "src/router/proxy.ts",
  "src/router/live-feed.ts",
  "src/router/http.ts",
  "src/router/server.ts",
  "src/agents/bridge-spawn-session.ts",
  "src/providers/minimax.ts",
  "src/providers/copilot.ts",
  "src/providers/antigravity.ts",
  "src/providers/claude.ts",
  "src/providers/claude-codex-tools.ts",
  "src/providers/claude-turn.ts",
  "src/mcp/spawn-shim.ts",
  "src/mcp/codex-tools-shim.ts",
  "src/mcp/launcher.ts",
  "src/router/tool-call-ownership.ts",
  "src/shared/execution-contract.ts",
  "src/router/status.ts",
  "src/cli/router-status.ts",
  "src/config/toml.ts",
  "src/config/compose-user-config.ts",
  "src/config/render-agent-configs.ts",
  "src/config/render-bridge-mcp-catalogue.ts",
  "src/config/render-execution-contract.ts",
  "config/execution-contract.json",
  "agents/prompts/base.md",
  "agents/prompts/leaf.md",
  "agents/prompts/code-search.md",
  "agents/prompts/orchestrator.md",
  "src/hooks/command-utils.ts",
  "src/hooks/skill-read-telemetry.ts",
  "src/hooks/session-start.ts",
  "src/hooks/subagent-start.ts",
  "src/platform/macos/launchd.ts",
  "src/platform/macos/launchagent.ts",
  "src/platform/router-ensure.ts",
  "src/platform/copilot-ensure.ts",
  "src/platform/antigravity-ensure.ts",
  "src/platform/claude-ensure.ts",
  "src/platform/minimax-ensure.ts",
  "src/platform/antigravity-settings.ts",
  "src/platform/runtime-files.ts",
  "src/platform/runtime-reconciliation.ts",
  "src/platform/service-restart.ts",
  "src/platform/otel-collector.ts",
  "src/platform/otel-provision.ts",
  "src/platform/install-state.ts",
  "src/platform/dependencies.ts",
  "src/platform/install-materializer.ts",
  "src/platform/install-command.ts",
  "src/platform/install-check.ts",
  "src/hooks/root-delegation.ts",
  "src/hooks/block-ccc-cli.ts",
  ".rulesync/skills/orchestration/SKILL.md"
] as const;
export const OBSOLETE_CLAUDE_SKILL_VIEWS = path.join(
  "provider-runtime",
  "claude"
);
export const OTEL_RUNTIME = [
  "scripts/otel/provision-autodev-otel-collector.sh",
  "scripts/otel/ensure-autodev-otel-collector.sh",
  "scripts/otel/run-autodev-otel-collector.sh"
] as const;
export const HOOKS = [
  "enforce-root-delegation.sh",
  "ensure-codex-antigravity-proxy.sh",
  "ensure-codex-claude-bridge.sh",
  "ensure-codex-copilot-proxy.sh",
  "ensure-codex-model-router.sh",
  "ensure-codex-minimax-proxy.sh",
  "run-codex-antigravity-proxy.sh",
  "run-codex-claude-bridge.sh",
  "run-codex-copilot-cli-responses-proxy.sh",
  "run-codex-model-router.sh"
] as const;
export const DASHBOARD = ["codex-model-router-dashboard.html"] as const;
export const MCP_LAUNCHERS = ["run-autodev-mcp.sh"] as const;
export const PROFILES = ["claude", "minimax", "antigravity"] as const;
export const CATALOGS = ["claude", "minimax", "antigravity", "codex"] as const;
export const ROLES = [
  "browser-tester",
  "default",
  "docs-researcher",
  "explorer",
  "smart",
  "validator",
  "worker"
] as const;
export const PROMPT_ROLES = [...ROLES, "orchestrator"] as const;
export const SKILLS = [
  "ccc",
  "code-simplification",
  "diagnosing-bugs",
  "improve-codebase-architecture",
  "lsp-mcp-server",
  "orchestration",
  "remove-legacy-shims",
  "resolve-merge-conflicts"
] as const;
export const LEGACY_SKILL_DIRS = ["skills", "agents/skills"] as const;
export const RULES = ["default.rules"] as const;
export const LAUNCH_LABELS = [
  "com.codex.model-router",
  "com.codex.claude-bridge",
  "com.codex.minimax-proxy",
  "com.codex.antigravity-proxy",
  "com.codex.copilot-proxy",
  "com.codex.otel-collector"
] as const;
export const OBSOLETE_LAUNCH = ["com.codex.antigravity-litellm"] as const;
export const OBSOLETE_PATHS = [
  ".config/litellm/antigravity.yaml",
  ".codex/codex-antigravity-litellm-config.sha256"
] as const;
export const OBSOLETE_HOOKS = [
  "codex-model-router.mjs",
  "log-subagent-model.sh",
  "run-codex-antigravity-litellm.sh",
  "codex-minimax-responses-proxy.mjs",
  "codex-copilot-cli-responses-proxy.mjs",
  "codex-antigravity-cli-responses-proxy.mjs",
  "codex-model-router-status.mjs",
  "codex-claude-cli-responses-proxy.py"
] as const;
export const OBSOLETE_DIRS = ["scripts", "codex", "codex/skills"] as const;
export const CANONICAL_HOOK_HASHES = {
  "pre_tool_use:0:0":
    "sha256:5f1d5b28fdc75a6290e2dc8deecebe92ffaad5e7352e1122f02a1680e10f0567",
  "pre_tool_use:1:0":
    "sha256:f81073b7b43edd2b08ba8a6f8a07d3f269326f0b133157c8f5367851c99167ce",
  "session_start:0:0":
    "sha256:ffe71c68625270b1a58ea48db245f1a4f35f9071c086be5988514a329b14933d",
  "user_prompt_submit:0:0":
    "sha256:e90b5998c2d5b47752bcb486784d5e66a32f92dbabda14b5d04e2f47282fe019",
  "subagent_start:0:0":
    "sha256:d3796d1a79be308b1fd16b311ee343c7f0797c03f9a4fc267082ab2ffd53b596"
} as const;

const CONFIG_TOML_KEY_PREFIX = "config.toml:";
const HOOKS_JSON = "hooks.json";
const OBSOLETE_RUNTIME_DIRECTORY = "obsolete-runtime-directory";
const CONFIG_TOML_FILE = "config.toml";

export function syncHookTrust(
  configPath: string,
  codexHome: string,
  repositoryRoot: string
): void {
  if (!exists(configPath)) return;
  const config = parseTomlFile(configPath, "config", false);
  const hooksTable =
    config.hooks &&
    typeof config.hooks === "object" &&
    !Array.isArray(config.hooks)
      ? (config.hooks as TomlTable)
      : {};
  const stateTable =
    hooksTable.state &&
    typeof hooksTable.state === "object" &&
    !Array.isArray(hooksTable.state)
      ? (hooksTable.state as TomlTable)
      : {};

  for (const key of Object.keys(stateTable)) {
    if (key.includes(CONFIG_TOML_KEY_PREFIX)) delete stateTable[key];
  }

  const userHooksJson = path.join(codexHome, HOOKS_JSON);
  const projectHooksJson = path.join(repositoryRoot, ".codex", HOOKS_JSON);

  for (const [suffix, hash] of Object.entries(CANONICAL_HOOK_HASHES)) {
    stateTable[`${userHooksJson}:${suffix}`] = { trusted_hash: hash };
    if (exists(projectHooksJson)) {
      stateTable[`${projectHooksJson}:${suffix}`] = { trusted_hash: hash };
    }
  }

  hooksTable.state = stateTable;
  config.hooks = hooksTable;
  atomicWrite(configPath, serializeToml(config));
}

export function checkHookTrust(
  configPath: string,
  codexHome: string,
  repositoryRoot: string
): boolean {
  if (!exists(configPath)) return false;
  try {
    const config = parseTomlFile(configPath, "config", false);
    const hooksTable =
      config.hooks &&
      typeof config.hooks === "object" &&
      !Array.isArray(config.hooks)
        ? (config.hooks as TomlTable)
        : null;
    if (!hooksTable) return false;
    const stateTable =
      hooksTable.state &&
      typeof hooksTable.state === "object" &&
      !Array.isArray(hooksTable.state)
        ? (hooksTable.state as TomlTable)
        : null;
    if (!stateTable) return false;

    for (const key of Object.keys(stateTable)) {
      if (key.includes(CONFIG_TOML_KEY_PREFIX)) return false;
    }

    const userHooksJson = path.join(codexHome, HOOKS_JSON);
    const projectHooksJson = path.join(repositoryRoot, ".codex", HOOKS_JSON);

    for (const [suffix, hash] of Object.entries(CANONICAL_HOOK_HASHES)) {
      const userEntry = stateTable[`${userHooksJson}:${suffix}`] as
        { trusted_hash?: string } | undefined;
      if (userEntry?.trusted_hash !== hash) return false;
      if (exists(projectHooksJson)) {
        const projectEntry = stateTable[`${projectHooksJson}:${suffix}`] as
          { trusted_hash?: string } | undefined;
        if (projectEntry?.trusted_hash !== hash) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

interface MaterializeOptions {
  repositoryRoot: string;
  home: string;
  codexHome: string;
  otelMode: string;
  materializeOnly: boolean;
  codexMcpSource: string;
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function run(command: string, args: readonly string[], cwd: string): void {
  const result = execFileSync(command, [...args], { cwd, stdio: "inherit" });
  void result;
}
function rulesync(options: MaterializeOptions, args: readonly string[]): void {
  run(
    path.join(options.repositoryRoot, "node_modules/.bin/rulesync"),
    args,
    options.repositoryRoot
  );
}
const LINE_SPLIT_PATTERN = /\r?\n/u;

function ensureExclude(options: MaterializeOptions): void {
  const exclude = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    { cwd: options.repositoryRoot, encoding: "utf8" }
  ).trim();
  mkdirSync(path.dirname(exclude), { recursive: true });
  const entries = [
    "/.agents/skills/",
    "/.codex/hooks.json",
    "/.claude/settings.json",
    "/.github/hooks/",
    "/.agents/hooks.json"
  ];
  const existing = readFileSync(exclude, "utf8");
  const missing = entries.filter(
    (entry) => !existing.split(LINE_SPLIT_PATTERN).includes(entry)
  );
  if (missing.length > 0)
    writeFileSync(
      exclude,
      `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${missing.join("\n")}\n`
    );
}
function roots(options: MaterializeOptions): string[] {
  const raw = process.env.AUTODEV_AGY_READ_ROOTS?.split(":").filter(
    Boolean
  ) ?? [options.repositoryRoot];
  return [
    ...new Set(
      raw.map((root) =>
        root === "~"
          ? options.home
          : root.startsWith("~/")
            ? path.join(options.home, root.slice(2))
            : root
      )
    )
  ];
}

function bootoutObsoleteLaunchLabels(launchd: LaunchdClient): void {
  for (const label of OBSOLETE_LAUNCH) {
    try {
      launchd.bootout(label);
    } catch {
      /* obsolete job may not be loaded */
    }
  }
}

function removeObsoleteRuntimeArtifacts(
  codexHome: string,
  home: string,
  hooks: string
): void {
  const obsoletePaths = [
    ...OBSOLETE_PATHS.map((filePath) => path.join(home, filePath)),
    path.join(hooks, "codex/lib/codex-spawn-tools.mjs"),
    path.join(hooks, "codex/lib/codex-state-collector.mjs"),
    path.join(hooks, "codex/lib/spawn-shim-mcp.mjs")
  ];
  removeStalePaths(obsoletePaths, "obsolete-runtime-path");
  removeStalePaths(
    OBSOLETE_HOOKS.map((name) => path.join(hooks, name)),
    "obsolete-runtime-hook"
  );
  removeStalePaths(
    OBSOLETE_DIRS.map((name) => path.join(hooks, name)),
    OBSOLETE_RUNTIME_DIRECTORY
  );
  // Claude reads skills through Codex's tools now, so its generated per-role
  // skill views have no reader.
  removeStalePaths(
    [path.join(codexHome, OBSOLETE_CLAUDE_SKILL_VIEWS)],
    OBSOLETE_RUNTIME_DIRECTORY
  );
}

type FileTarget = (filePath: string) => string;

function materializeRuntimeSources(
  source: FileTarget,
  target: FileTarget
): void {
  for (const filePath of RUNTIME_MODULES)
    materializeRuntimeFile(source(filePath), target(filePath), 0o644);
  for (const filePath of OTEL_RUNTIME)
    materializeRuntimeFile(source(filePath), target(filePath), 0o755);
  for (const role of PROMPT_ROLES)
    materializeRuntimeFile(
      source(`agents/prompts/roles/${role}.md`),
      target(`agents/prompts/roles/${role}.md`),
      0o644
    );
}

function materializeScripts(
  hooks: string,
  source: FileTarget
): void {
  for (const name of HOOKS) {
    chmodSync(source(`scripts/${name}`), 0o755);
    materializeRuntimeFile(
      source(`scripts/${name}`),
      path.join(hooks, name),
      0o755
    );
  }
  for (const name of DASHBOARD)
    materializeRuntimeFile(
      source(`scripts/${name}`),
      path.join(hooks, name),
      0o644
    );
  for (const name of MCP_LAUNCHERS)
    linkRuntimeSource(source(`scripts/${name}`), path.join(hooks, name));
}

function linkRuntimeConfigs(
  codexHome: string,
  source: FileTarget,
  rules: string
): void {
  for (const name of PROFILES)
    linkRuntimeSource(
      source(`config/profiles/${name}.config.toml`),
      path.join(codexHome, `${name}.config.toml`)
    );
  for (const name of CATALOGS)
    linkRuntimeSource(
      source(`config/catalogs/${name}-model-catalog.json`),
      path.join(codexHome, `${name}-model-catalog.json`)
    );
  for (const name of RULES)
    linkRuntimeSource(source(`agents/rules/${name}`), path.join(rules, name));
}

function replaceSkillSymlinks(
  codexHome: string,
  skillsRoot: string,
  userSkills: string
): void {
  for (const name of SKILLS) {
    for (const legacy of LEGACY_SKILL_DIRS) {
      const filePath = path.join(codexHome, legacy, name);
      if (exists(filePath) && !isSymlink(filePath))
        throw new Error(
          `refusing to replace obsolete non-symlink skill path: ${filePath}`
        );
      if (isSymlink(filePath)) unlinkSync(filePath);
    }
    linkSkillSource(path.join(skillsRoot, name), path.join(userSkills, name));
  }
}

function materializeRenderedAgents(
  repositoryRoot: string,
  agents: string,
  codexMcpSource: string
): void {
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  const rendered = mkdtempSync(
    path.join(repositoryRoot, ".autodev-rendered-agents-")
  );
  try {
    renderAgentDirectory(
      path.join(repositoryRoot, "agents/roles"),
      path.join(repositoryRoot, "agents/prompts"),
      rendered,
      codexMcpSource
    );
    for (const role of ROLES)
      materializeRuntimeFile(
        path.join(rendered, `${role}.toml`),
        path.join(agents, `${role}.toml`),
        0o644
      );
  } finally {
    rmSync(rendered, { recursive: true, force: true });
  }
}

function composeAndLinkConfigs(
  options: MaterializeOptions,
  source: FileTarget
): void {
  runCompose(
    source("config/config.autodev.toml"),
    options.codexMcpSource,
    path.join(options.codexHome, CONFIG_TOML_FILE),
    path.join(options.codexHome, CONFIG_TOML_FILE),
    false,
    options.otelMode
  );
  if (isSymlink(path.join(options.codexHome, "config.toml")))
    throw new Error(
      `refusing-symlinked-user-config ${path.join(options.codexHome, "config.toml")}`
    );
  linkRuntimeSource(
    source("config/model-routing.json"),
    path.join(options.codexHome, "codex-model-routing.json")
  );
  linkRuntimeSource(
    source(".codex/hooks.json"),
    path.join(options.codexHome, "hooks.json")
  );
  syncHookTrust(
    path.join(options.codexHome, CONFIG_TOML_FILE),
    options.codexHome,
    options.repositoryRoot
  );
}

function renderGlobalMcpIfNeeded(options: MaterializeOptions): void {
  const targets = (
    [
      ["claude", "claudecode"],
      ["copilot", "copilotcli"],
      ["agy", "antigravity-cli"]
    ] as const
  )
    .filter(([command]) => commandAvailable(command))
    .map(([, targetName]) => targetName)
    .join(",");
  if (targets)
    rulesync(options, [
      "generate",
      "--global",
      "--input-roots",
      path.join(options.repositoryRoot, ".rulesync"),
      "--targets",
      targets,
      "--features",
      "mcp",
      "--silent"
    ]);
}

function applyAntigravityIfInstalled(
  options: MaterializeOptions,
  skillsRoot: string
): void {
  if (
    options.materializeOnly ||
    !commandAvailable("agy") ||
    process.env.AUTODEV_SKIP_AGY_MCP === "1"
  )
    return;
  updateAntigravityPermissions(
    path.join(options.home, ".gemini", "antigravity-cli", "settings.json"),
    roots(options),
    options.home
  );
  updateAntigravitySkills(
    path.join(options.home, ".gemini", "config", "skills.json"),
    skillsRoot,
    [
      path.join(options.repositoryRoot, "agents/skills"),
      path.join(options.repositoryRoot, "scripts/codex/skills")
    ]
  );
}

function renderLaunchAgentsFor(
  repositoryRoot: string,
  home: string,
  codexHome: string
): void {
  for (const label of LAUNCH_LABELS)
    renderLaunchAgent(
      path.join(repositoryRoot, `config/launchagents/${label}.plist`),
      path.join(home, "Library", "LaunchAgents", `${label}.plist`),
      { codexHome, home, repositoryRoot }
    );
}

function prepareRunLogs(codexHome: string): void {
  const runDir = path.join(codexHome, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  for (const name of [
    "codex-model-router.launchd.out.log",
    "codex-model-router.launchd.err.log"
  ]) {
    const filePath = path.join(runDir, name);
    if (isSymlink(filePath))
      throw new Error(`refusing symlinked router log path: ${filePath}`);
    if (!exists(filePath)) writeFileSync(filePath, "", { mode: 0o600 });
    chmodSync(filePath, 0o600);
  }
}

export function materializeInstallation(options: MaterializeOptions): void {
  const hooks = path.join(options.codexHome, "hooks"),
    agents = path.join(options.codexHome, "agents"),
    rules = path.join(options.codexHome, "rules"),
    userSkills = path.join(options.home, ".agents", "skills"),
    skillsRoot = path.join(options.repositoryRoot, ".rulesync", "skills");
  const launchd = new LaunchdClient();
  bootoutObsoleteLaunchLabels(launchd);
  removeObsoleteRuntimeArtifacts(options.codexHome, options.home, hooks);
  const source: FileTarget = (filePath) =>
    path.join(options.repositoryRoot, filePath);
  const target: FileTarget = (filePath) =>
    runtimeTarget(filePath, options.codexHome, hooks);
  materializeRuntimeSources(source, target);
  materializeScripts(hooks, source);
  linkRuntimeConfigs(options.codexHome, source, rules);
  replaceSkillSymlinks(options.codexHome, skillsRoot, userSkills);
  materializeRenderedAgents(options.repositoryRoot, agents, options.codexMcpSource);
  runBridgeMcpCatalogue(
    options.codexMcpSource,
    path.join(options.codexHome, "provider-runtime", "mcp-servers.json")
  );
  rulesync(options, [
    "generate",
    "--config",
    path.join(options.repositoryRoot, "rulesync.jsonc"),
    "--silent"
  ]);
  ensureExclude(options);
  composeAndLinkConfigs(options, source);
  renderGlobalMcpIfNeeded(options);
  applyAntigravityIfInstalled(options, skillsRoot);
  renderLaunchAgentsFor(options.repositoryRoot, options.home, options.codexHome);
  prepareRunLogs(options.codexHome);
}
function exists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env;
    const repositoryRoot =
      env.AUTODEV_REPO_ROOT ??
      path.resolve(path.join(import.meta.dirname, "..", ".."));
    const home = env.HOME ?? homedir();
    const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
    const mcp = env.AUTODEV_CODEX_MCP_SOURCE;
    if (!mcp) throw new Error("AUTODEV_CODEX_MCP_SOURCE is required");
    materializeInstallation({
      repositoryRoot,
      home,
      codexHome,
      otelMode: env.AUTODEV_OTEL_MODE ?? "direct",
      materializeOnly: env.AUTODEV_MATERIALIZE_ONLY === "1",
      codexMcpSource: mcp
    });
  } catch (error) {
    writeErrorLine(
      `install-materializer: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
