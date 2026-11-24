import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { RuleSyncRepository } from "@simulatorlife/autodev-data";
import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import {
  parseTomlFile,
  renderAgentDirectory,
  runBridgeMcpCatalogue,
  runCompose,
  runExecutionContract,
  runModelCatalog,
  serializeToml,
  type TomlTable
} from "@simulatorlife/autodev-runtime/config";
import { listBundledPlugins } from "@simulatorlife/autodev-runtime/shared/bundled-plugins";
import { autodevHome as resolveAutodevHome } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { findCopilotBinary } from "@simulatorlife/autodev-runtime/shared/executables";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import {
  updateAntigravityPermissions,
  updateAntigravitySkills
} from "./antigravity-settings.ts";
import { materializeMcodeProjection } from "./mcode-projection.ts";
import { createCodexMcpSource } from "./codex-mcp-source.ts";
import { createCodexPermissionsSource } from "./codex-permissions-source.ts";
import {
  type LaunchAgentPaths,
  renderLaunchAgent,
  resolveLaunchAgentValues
} from "./macos/launchagent.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import {
  computeRepoPathsFingerprint,
  linkRuntimeSource,
  linkSkillSource,
  materializeRuntimeContent,
  materializeRuntimeFile,
  readRepoInstallCache,
  readRulesyncPackageVersion,
  resolveCommandOnPath,
  type RulesyncGenerateOptions,
  runRulesyncGenerate,
  runRulesyncInstallFrozen,
  runtimeTarget,
  skillLinkMatches,
  writeRepoInstallCache
} from "./runtime-files.ts";
import {
  readRuntimePackageManifest,
  renderRuntimeMirrorPackage
} from "./runtime-mirror-package.ts";
import { removeStalePaths } from "./runtime-reconciliation.ts";
import {
  materializeRuntimeSourceGeneration,
  type RuntimeSourceTree
} from "./runtime-source-generation.ts";
import { userLevelSkills } from "./user-level-skills.ts";

const OBSOLETE_RUNTIME_PATH_REASON = "obsolete-runtime-path";
const FEATURE_COLLATOR = new Intl.Collator();

export const RUNTIME_MODULES = [
  "runtime/src/router/quota-poll.ts",
  "runtime/src/router/telemetry.ts",
  "runtime/src/router/git-commit-observation.ts",
  "runtime/src/telemetry/git-change-metrics.ts",
  "runtime/src/telemetry/git-commit-identity.ts",
  "runtime/src/telemetry/resource-context/index.ts",
  "runtime/src/telemetry/workspace-commit-observer.ts",
  "runtime/src/router/agent-event-ingest.ts",
  "runtime/src/control-api/claude-code-binding.ts",
  "runtime/src/control-api/body.ts",
  "runtime/src/control-api/diagnostics.ts",
  "runtime/src/router/routing.ts",
  "runtime/src/control-api/playtesting.ts",
  "runtime/src/control-api/workspace-playtesting.ts",
  "runtime/src/control-api/workspace-visual-playtesting.ts",
  "runtime/src/control-api/playtesting-human-studies.ts",
  "runtime/src/control-api/playtesting-run-control.ts",
  "runtime/src/playtesting/launch-request-schema.ts",
  "runtime/src/playtesting/artifact-store.ts",
  "runtime/src/playtesting/adapter-client.ts",
  "runtime/src/playtesting/approved-configuration.ts",
  "runtime/src/playtesting/cohort-standardization-run.ts",
  "runtime/src/playtesting/docker-sandbox.ts",
  "runtime/src/playtesting/episode-runner.ts",
  "runtime/src/playtesting/hash-chain.ts",
  "runtime/src/playtesting/jsonl-framer.ts",
  "runtime/src/playtesting/loop-guard.ts",
  "runtime/src/playtesting/mcp.ts",
  "runtime/src/playtesting/run-control.ts",
  "runtime/src/playtesting/discovery-review.ts",
  "runtime/src/playtesting/analyst-process.ts",
  "runtime/src/playtesting/mcp-main.ts",
  "runtime/src/playtesting/stdio.ts",
  "runtime/src/playtesting/control-api-run-control-client.ts",
  "runtime/src/playtesting/packet-artifact-reconciliation.ts",
  "runtime/src/playtesting/policy-validity-run.ts",
  "runtime/src/playtesting/policies.ts",
  "runtime/src/playtesting/policy-workspace.ts",
  "runtime/src/playtesting/run-control-service.ts",
  "runtime/src/playtesting/smart-direct-policy.ts",
  "runtime/src/playtesting/onejev-local-policy.ts",
  "runtime/src/playtesting/visual-browser-driver.ts",
  "runtime/src/playtesting/visual-candidates.ts",
  "runtime/src/playtesting/recorded-text.ts",
  "runtime/src/playtesting/visible-observation.ts",
  "runtime/src/playtesting/statistics/analysis.ts",
  "runtime/src/playtesting/statistics/environment.ts",
  "runtime/src/playtesting/statistics/index.ts",
  "runtime/src/playtesting/statistics/jsonrpc-client.ts",
  "runtime/src/playtesting/statistics/lock-manifest.ts",
  "runtime/src/playtesting/statistics/PYTHON_README.md",
  "runtime/src/playtesting/statistics/pyproject.toml",
  "runtime/src/playtesting/statistics/uv.lock",
  "runtime/src/playtesting/statistics/python_script/__main__.py",
  "runtime/src/playtesting/statistics/python_script/analysis.py",
  "runtime/src/playtesting/statistics/python_script/library_versions.py",
  "runtime/src/shared/map-concurrent-ordered.ts",
  "runtime/src/shared/bundled-plugins.ts",
  "runtime/src/shared/provider-model-ids.ts",
  "runtime/src/shared/output.ts",
  "runtime/src/shared/error-message.ts",
  "runtime/src/shared/executables.ts",
  "runtime/src/shared/runtime-secrets.ts",
  "runtime/src/shared/runtime-source-root.ts",
  "runtime/src/shared/installed-skills.ts",
  "runtime/src/shared/mcp-headers.ts",
  "runtime/src/shared/autodev-home.ts",
  "runtime/src/shared/env.ts",
  "runtime/src/shared/execution-contract.ts",
  "runtime/src/shared/provider-http.ts",
  "runtime/src/shared/provider-limits.ts",
  "runtime/src/shared/provider-reset-headers.ts",
  "runtime/src/shared/entry-point.ts",
  "runtime/src/shared/request-content.ts",
  "runtime/src/shared/resolve-workspace.ts",
  "runtime/src/shared/tool-names.ts",
  "runtime/src/shared/skill-reads.ts",
  "runtime/src/shared/service-lifecycle.ts",
  "runtime/vendor/jev-playtest-lab/src/core.js",
  "runtime/src/control-api/request-handler.ts",
  "runtime/src/control-api/github.ts",
  "runtime/src/control-api/opencli-browser.ts",
  "runtime/src/router/subagents.ts",
  "runtime/src/router/metric-label.ts",
  "runtime/src/router/usage.ts",
  "runtime/src/router/correlation.ts",
  "runtime/src/router/proxy.ts",
  "runtime/src/router/http.ts",
  "runtime/src/router/server.ts",
  "runtime/src/router/auth.ts",
  "runtime/src/router/concurrency/index.ts",
  "runtime/src/router/cooldown/index.ts",
  "runtime/src/router/events.ts",
  "runtime/src/router/lifecycle/index.ts",
  "runtime/src/router/live-feed.ts",
  "runtime/src/router/persistence/index.ts",
  "runtime/src/router/status.ts",
  "runtime/src/agents/index.ts",
  "runtime/src/agents/agent-activity.ts",
  "runtime/src/agents/orchestrator-policy.ts",
  "runtime/src/agents/read-only-policy.ts",
  "runtime/src/agents/role-mcp-environment.ts",
  "runtime/src/config/index.ts",
  "runtime/src/config/cli-args.ts",
  "runtime/src/config/compose-user-config.ts",
  "runtime/src/config/config-files.ts",
  "runtime/src/config/render-agent-configs.ts",
  "runtime/src/config/render-bridge-mcp-catalogue.ts",
  "runtime/src/config/render-chatgpt-supergateway.ts",
  "runtime/src/config/render-execution-contract.ts",
  "runtime/src/config/render-model-catalog.ts",
  "runtime/src/telemetry/index.ts",
  "runtime/src/telemetry/agent-events.ts",
  "runtime/src/telemetry/github-metrics.ts",
  "runtime/src/telemetry/provider-phases.ts",
  "runtime/src/telemetry/tracer-provider.ts",
  "runtime/src/telemetry/otlp-config.ts",
  "runtime/src/providers/codex-auth.ts",
  "runtime/src/providers/model-discovery.ts",
  "runtime/src/providers/cli-versions.ts",
  "runtime/src/providers/claude-credential.ts",
  "runtime/src/providers/opencli.ts",
  "runtime/src/providers/opencli-browser.ts",
  "runtime/src/shared/opencli-browser-setting.ts",
  "runtime/src/providers/opencli-turn.ts",
  "runtime/src/mcp/tool-filter.ts",
  "runtime/src/mcp/filesystem-server.ts",
  "runtime/src/mcp/mcp-telemetry.ts",
  "runtime/src/mcp/launcher.ts",
  "runtime/src/mcp/chatgpt-supergateway-probe.ts",
  "runtime/src/mcp/chatgpt-filesystem-sandbox.ts",
  "runtime/src/mcp/process-registry.ts",
  "runtime/src/cli/diagnostics.ts",
  "runtime/src/cli/router-status.ts",
  "runtime/src/cli/router-status-client.ts",
  "runtime/src/cli/provider-agent.ts",
  "agents/prompts/base.md",
  "agents/prompts/leaf.md",
  "agents/prompts/code-search.md",
  "agents/prompts/orchestrator.md",
  "runtime/src/hooks/hook-log.ts",
  "runtime/src/hooks/hook-payload.ts",
  "runtime/src/hooks/hook-roots.ts",
  "runtime/src/hooks/skill-read-telemetry.ts",
  "runtime/src/hooks/session-start.ts",
  "runtime/src/platform/macos/launchd.ts",
  "runtime/src/platform/index.ts",
  "runtime/src/platform/host-arch.ts",
  "runtime/src/platform/macos/launchagent.ts",
  "runtime/src/platform/router-ensure.ts",
  "runtime/src/platform/opencli-ensure.ts",
  "runtime/src/platform/opencli-browser-install.ts",
  "runtime/src/platform/code-graph-ensure.ts",
  "runtime/src/platform/antigravity-settings.ts",
  "runtime/src/platform/runtime-files.ts",
  "runtime/src/platform/runtime-mirror-package.ts",
  "runtime/src/platform/runtime-reconciliation.ts",
  "runtime/src/platform/runtime-source-generation.ts",
  "runtime/src/platform/user-level-skills.ts",
  "runtime/src/platform/service-restart.ts",
  "runtime/src/platform/usage-stack.ts",
  "runtime/src/platform/usage-contract.ts",
  "runtime/src/platform/sleep.ts",
  "runtime/src/platform/wait-for-probe.ts",
  "runtime/src/platform/install-state.ts",
  "runtime/src/platform/dependencies.ts",
  "runtime/src/platform/health-probe.ts",
  "runtime/src/platform/console-build.ts",
  "runtime/src/platform/console-ensure.ts",
  "runtime/src/platform/install-materializer.ts",
  "runtime/src/platform/install-command.ts",
  "runtime/src/platform/chatgpt-tunnel-install.ts",
  "runtime/src/platform/install-check.ts",
  "runtime/src/platform/codex-mcp-source.ts",
  "runtime/src/platform/codex-permissions-source.ts",
  "runtime/src/hooks/root-delegation.ts",
  "runtime/src/hooks/block-ccc-cli.ts",
  "runtime/src/hooks/role-sandbox.ts",
  "runtime/src/hooks/file-surface.ts",
  "runtime/src/acp/provider-profiles.ts",
  "runtime/src/xacpx/http.ts",
  "runtime/src/xacpx/manager.ts",
  "runtime/src/platform/mcode-projection.ts"
] as const;
export const OBSOLETE_RUNTIME_DATA_FILES = [
  path.join("run", "claude-rate-limit.json")
] as const;
export const OBSOLETE_CLAUDE_SKILL_VIEWS = path.join(
  "provider-runtime",
  "claude"
);
export const HOOKS = [
  "enforce-root-delegation.sh",
  "ensure-autodev-console.sh",
  "ensure-autodev-opencli-proxy.sh",
  "ensure-autodev-model-router.sh",
  "run-autodev-opencli-proxy.sh",
  "run-autodev-model-router.sh",
  "run-autodev-console.sh",
  "run-autodev-hook.sh"
] as const;
export const MCP_LAUNCHERS = ["run-autodev-mcp.sh"] as const;
export const PROFILES = [] as const;
export const CATALOGS = [
  "claude",
  "minimax",
  "antigravity-gemini",
  "antigravity-argon",
  "antigravity-claude-gpt",
  "opencli-chatgpt",
  "opencli-gemini",
  "codex"
] as const;
export const ROLES = [
  "browser-tester",
  "default",
  "docs-researcher",
  "explorer",
  "github-worker",
  "playtest-analyst",
  "playtester",
  "smart",
  "validator",
  "worker"
] as const;
export const PROMPT_ROLES = [...ROLES, "orchestrator"] as const;
/**
 * Codex custom prompts (slash commands) are materialized at
 * `$CODEX_HOME/prompts/<name>.md` from the canonical `.rulesync/commands/`
 * source. Data owns parsing and validation; Runtime selects the `codexcli`
 * target and manages its generated projection.
 */
export const LEGACY_SKILL_DIRS = ["skills", "agents/skills"] as const;
export const RULES = ["rulesync.rules"] as const;
export const LAUNCH_LABELS = [
  "com.codex.autodev-console",
  "com.codex.model-router",
  "com.codex.opencli-proxy"
] as const;
export const OBSOLETE_LAUNCH = [
  "com.codex.antigravity-litellm",
  "com.codex.otel-collector",
  "com.codex.claude-bridge",
  "com.codex.minimax-proxy",
  "com.codex.antigravity-proxy",
  "com.codex.copilot-proxy"
] as const;
const OBSOLETE_COLLECTOR_HOOKS = [
  "otel/ensure-autodev-otel-collector.sh",
  "otel/provision-autodev-otel-collector.sh",
  "otel/run-autodev-otel-collector.sh"
] as const;
export const OBSOLETE_PATHS = [
  ".config/litellm/antigravity.yaml",
  ".codex/codex-antigravity-litellm-config.sha256",
  ".codex/antigravity.config.toml",
  ".codex/antigravity-model-catalog.json",
  ".codex/claude.config.toml",
  ".codex/minimax.config.toml",
  ".codex/antigravity-gemini.config.toml",
  ".codex/antigravity-argon.config.toml",
  ".codex/antigravity-claude-gpt.config.toml"
] as const;
export const OBSOLETE_DASHBOARD = "codex-model-router-dashboard.html";
export const OBSOLETE_HOOKS = [
  "codex-model-router.mjs",
  "log-subagent-model.sh",
  "run-codex-antigravity-litellm.sh",
  "codex-minimax-responses-proxy.mjs",
  "codex-copilot-cli-responses-proxy.mjs",
  "codex-antigravity-cli-responses-proxy.mjs",
  "codex-model-router-status.mjs",
  "codex-claude-cli-responses-proxy.py",
  "ensure-codex-antigravity-proxy.sh",
  "ensure-codex-claude-bridge.sh",
  "ensure-codex-console.sh",
  "ensure-codex-copilot-proxy.sh",
  "ensure-codex-minimax-proxy.sh",
  "ensure-codex-model-router.sh",
  "ensure-codex-opencli-proxy.sh",
  "run-codex-antigravity-proxy.sh",
  "run-codex-claude-bridge.sh",
  "run-codex-console.sh",
  "run-codex-copilot-cli-responses-proxy.sh",
  "run-codex-model-router.sh",
  "run-codex-opencli-proxy.sh"
] as const;
export const OBSOLETE_DIRS = ["scripts", "codex", "codex/skills"] as const;
/**
 * The trust hashes Codex expects for the canonical hooks.
 *
 * Codex hashes each hook it is asked to run and refuses to run one whose hash
 * is not trusted, so the installer has to write the hash the installed hook
 * content hashes to. The key is the hook's position in the projected
 * `hooks.json` -- `<event>:<group>:<hook>` -- and the value is the hash Codex
 * computes for the materialized script.
 *
 * Codex computes that hash itself and records it in `[hooks.state]` in
 * `$CODEX_HOME/config.toml` when it loads the hook, so the values are read
 * back from there after a materialize run rather than computed here: the hash
 * covers the hook script's content, which changes whenever a hook changes.
 * A hook that is missing from this map is a hook the installer never trusts,
 * and Codex will not run it.
 */
export const CANONICAL_HOOK_HASHES = {
  "pre_tool_use:0:0":
    "sha256:7ac577f46abcb492b9e68887d1b4161ebe94c630e584ee7faba5b8c67b43e754",
  "pre_tool_use:1:0":
    "sha256:6b4570797d67d7d6588f75a9259f1130b525d9afd8ff59ef563558cfd13bd309",
  "pre_tool_use:2:0":
    "sha256:ae60c65e5df3105decbdae36dfd9aab04923a718d2d7b52e4e113801eac7f015",
  "session_end:0:0":
    "sha256:f0ab1b40d4481d128f3f3158d5c219ac3701d7108c1febf9c06ca787cb386e50",
  "session_start:0:0":
    "sha256:232fed476e86852e0e28311ef2deeeb10ad9fb0ecee3db2db7cd27f4f227779c",
  "subagent_start:0:0":
    "sha256:bfd8149a981310cfe1ce1e9e8a24876a50e9ee827ee3a7711ec080c681664bcc",
  "user_prompt_submit:0:0":
    "sha256:57b83265447a5a23eff86cf99e5b2ce6e68af1fd845277a800f91c915588c108"
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

  for (const key of Object.keys(stateTable)) {
    if (key.startsWith(`${projectHooksJson}:`)) delete stateTable[key];
  }
  for (const [suffix, hash] of Object.entries(CANONICAL_HOOK_HASHES))
    stateTable[`${userHooksJson}:${suffix}`] = { trusted_hash: hash };

  hooksTable.state = stateTable;
  config.hooks = hooksTable;
  atomicWriteSync(configPath, serializeToml(config), {
    mode: 0o644,
    skipUnchanged: true
  });
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
    }
    return !Object.keys(stateTable).some((key) =>
      key.startsWith(`${projectHooksJson}:`)
    );
  } catch {
    return false;
  }
}

interface MaterializeOptions {
  repositoryRoot: string;
  home: string;
  codexHome: string;
  autodevHome?: string;
  materializeOnly: boolean;
  codexMcpSource: string;
}

function commandAvailable(command: string): boolean {
  return resolveCommandOnPath(command) !== null;
}

/**
 * Whether a provider's CLI is installed, asked the way that provider's bridge
 * asks it. The Copilot CLI is found by the shared lookup -- an explicit
 * setting, then PATH, then the newest version-managed install -- because a
 * PATH lookup alone misses a CLI installed in PNPM_HOME, and the user-level MCP
 * config written for a provider whose bridge cannot start is a config for
 * nothing.
 */
function providerCliInstalled(command: string): boolean {
  if (command === "copilot") return findCopilotBinary() !== null;
  return commandAvailable(command);
}

/**
 * Regenerate and verify the canonical RuleSync skill projections without
 * running unrelated feature generators. A successful generation alone is not
 * enough to report convergence: the pinned CLI's `--check` must also confirm
 * that every configured target matches the canonical `.rulesync/skills`
 * source.
 */
export function materializeRuleSyncSkillProjections(
  repositoryRoot: string
): void {
  generateRepositoryRulesync(repositoryRoot, { features: ["skills"] });
}

const PER_REPO_MODE_PATTERN = /mode:\s*per_repo/u;
const LINE_SPLIT_PATTERN = /\r?\n/u;
const MD_EXTENSION_PATTERN = /\.md$/u;
const IGNORE_DIRS_LINE_PATTERN = /^\s*IGNORE_DIRS\s*=/iu;

function extractIgnoreDirs(line: string): string[] {
  const eqIdx = line.indexOf("=");
  if (eqIdx === -1) return [];
  let val = line.slice(eqIdx + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return val ? val.split(",") : [];
}

/**
 * Whether a path is a directory.
 *
 * A repository's `.git` may be a file (a worktree's link) or absent, and both
 * mean the same thing here: there is no `info/exclude` to write, so the
 * exclusion is materialized through `git rev-parse` instead.
 */
function isDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function ensureExclude(options: MaterializeOptions): void {
  const dotGitPath = path.join(options.repositoryRoot, ".git");
  const exclude = isDirectory(dotGitPath)
    ? path.join(dotGitPath, "info", "exclude")
    : execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
        { cwd: options.repositoryRoot, encoding: "utf8" }
      ).trim();
  mkdirSync(path.dirname(exclude), { recursive: true });
  const entries = [
    "/.agents/skills/",
    "/.claude/settings.json",
    "/.github/hooks/",
    "/.agents/hooks.json"
  ];
  const existing = exists(exclude) ? readFileSync(exclude, "utf8") : "";
  const missing = entries.filter(
    (entry) => !existing.split(LINE_SPLIT_PATTERN).includes(entry)
  );
  if (missing.length > 0)
    writeFileSync(
      exclude,
      `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${missing.join("\n")}\n`
    );
}

const REPOMIX_CONFIG_CANDIDATES = [
  "repomix.config.json",
  "repomix.config.jsonc",
  "repomix.config.json5",
  "repomix.config.ts",
  "repomix.config.js",
  "repomix.config.mjs",
  "repomix.config.cjs"
] as const;

function repoNeedsBootstrapExclusionsRun(options: MaterializeOptions): boolean {
  if (process.env.CGC_MODE === "per_repo") {
    return true;
  }
  for (const relative of [
    ".codegraphcontext",
    ".cgcignore",
    ".repomixignore",
    ...REPOMIX_CONFIG_CANDIDATES
  ]) {
    if (exists(path.join(options.repositoryRoot, relative))) {
      return true;
    }
  }
  const cgcConfigPath = path.join(
    options.home,
    ".codegraphcontext",
    "config.yaml"
  );
  if (exists(cgcConfigPath)) {
    try {
      const content = readFileSync(cgcConfigPath, "utf8");
      if (
        PER_REPO_MODE_PATTERN.test(content) ||
        content.includes(options.repositoryRoot)
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function ensureBootstrapScript(options: MaterializeOptions): void {
  const binDir = path.join(options.home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, "autodev-bootstrap");
  const scriptPath = path.join(
    options.repositoryRoot,
    "scripts",
    "bootstrap-repo-exclusions.sh"
  );
  chmodSync(scriptPath, 0o755);
  linkRuntimeSource(scriptPath, target);
  if (!repoNeedsBootstrapExclusionsRun(options)) {
    return;
  }
  try {
    execFileSync(target, [options.repositoryRoot], { stdio: "ignore" });
  } catch {
    // Non-fatal if bootstrap execution fails during install
  }
}

const CGC_IGNORE_FILE = ".cgcignore";

export const UNIVERSAL_GIT_EXCLUDES = [
  ".codegraphcontext/",
  ".cgc/",
  ".cgc_cache/",
  ".cgc-cache/",
  ".cgc-state/",
  ".cgc-state-*/",
  CGC_IGNORE_FILE,
  ".repograph/",
  ".repomix/",
  "repomix-output.*",
  "repomix-output-*/",
  ".repomix-output.*",
  ".repomixignore",
  "CGC_REPORT.md",
  "CGC_REPORT*.md",
  "cgc_report.md",
  "cgc_report*.md",
  ".cocoindex_code/",
  ".lsp/",
  ".lsp-cache/",
  ".ccls-cache/",
  ".clangd/",
  ".agent-cache/",
  ".agents/cache/",
  ".claude/cache/",
  ".playwright-mcp/",
  ".playwright/",
  "mcp_debug.log",
  "*.launchd.*.log",
  "*.tsbuildinfo",
  ".nyc_output/"
] as const;

export const CGC_IGNORE_DIRS =
  "node_modules,dist,build,target,out,coverage,.venv,venv,env,.git,.idea,.vscode,.codegraphcontext,.cgc,.cgc_cache,.cgc-cache,.cgc-state,.repograph,.repomix,.cocoindex_code,.lsp,.lsp-cache,.ccls-cache,.clangd,.agent-cache,.playwright-mcp,.playwright,.ruff_cache,.tox,.nox,.turbo,.svelte-kit,.cache,.tmp,.nyc_output";

export const CGC_GLOBAL_PATTERNS = [
  ".codegraphcontext/",
  ".cgc/",
  ".cgc_cache/",
  ".cgc-cache/",
  ".cgc-state/",
  ".cgc-state-*/",
  CGC_IGNORE_FILE,
  ".repograph/",
  "repomix-output.*",
  ".repomix-output.*",
  "repomix-output-*/",
  ".repomix/",
  ".repomixignore",
  "CGC_REPORT.md",
  "CGC_REPORT*.md",
  "cgc_report.md",
  "cgc_report*.md",
  ".cocoindex_code/",
  ".lsp/",
  ".lsp-cache/",
  ".ccls-cache/",
  ".clangd/",
  ".agent-cache/",
  ".agents/cache/",
  ".claude/cache/",
  ".playwright-mcp/",
  ".playwright/",
  "mcp_debug.log",
  "*.launchd.*.log",
  "*.tsbuildinfo",
  ".nyc_output/",
  ".ruff_cache/",
  ".tox/",
  ".nox/",
  ".turbo/",
  ".svelte-kit/",
  ".cache/",
  ".tmp/",
  ".coverage"
] as const;

export const REPOMIX_CUSTOM_PATTERNS = [
  "**/.codegraphcontext/**",
  "**/.cgc/**",
  "**/.cgc_cache/**",
  "**/.cgc-cache/**",
  "**/.cgc-state/**",
  "**/.cgc-state-*/**",
  "**/.cgcignore",
  "**/.repomix/**",
  "**/repomix-output.*",
  "**/.repomix-output.*",
  "**/repomix-output-*/**",
  "**/.repomixignore",
  "**/CGC_REPORT.md",
  "**/CGC_REPORT*.md",
  "**/cgc_report.md",
  "**/cgc_report*.md",
  "**/.cocoindex_code/**",
  "**/.lsp/**",
  "**/.lsp-cache/**",
  "**/.ccls-cache/**",
  "**/.clangd/**",
  "**/.agent-cache/**",
  "**/.agents/cache/**",
  "**/.claude/cache/**",
  "**/.playwright-mcp/**",
  "**/.playwright/**",
  "**/.ruff_cache/**",
  "**/.tox/**",
  "**/.nox/**",
  "**/.turbo/**",
  "**/.svelte-kit/**",
  "**/.cache/**",
  "**/.tmp/**",
  "**/*.tsbuildinfo",
  "**/.coverage",
  "**/.repograph/**",
  "**/.nyc_output/**"
] as const;

function getGlobalGitExcludesFile(): string {
  try {
    return execFileSync(
      "git",
      ["config", "--global", "--get", "core.excludesFile"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return "";
  }
}

function ensureGlobalGitExcludes(options: MaterializeOptions): void {
  let excludesFile = getGlobalGitExcludesFile();
  if (!excludesFile) {
    excludesFile = path.join(options.home, ".gitignore_global");
    try {
      execFileSync(
        "git",
        ["config", "--global", "core.excludesFile", excludesFile],
        { stdio: "ignore" }
      );
    } catch {
      // Ignored if git config cannot be set
    }
  } else if (excludesFile.startsWith("~")) {
    excludesFile = path.join(options.home, excludesFile.slice(1));
  }

  mkdirSync(path.dirname(excludesFile), { recursive: true });
  const existing = exists(excludesFile)
    ? readFileSync(excludesFile, "utf8")
    : "";
  const existingLines = new Set(existing.split(LINE_SPLIT_PATTERN));
  const missing = UNIVERSAL_GIT_EXCLUDES.filter((p) => !existingLines.has(p));
  if (missing.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const header =
      "# AutoDev universal exclusions (CodeGraphContext, Repomix, and caches)\n";
    writeFileSync(
      excludesFile,
      `${existing}${prefix}${header}${missing.join("\n")}\n`
    );
  }
}

function ensureGlobalRepomixConfig(options: MaterializeOptions): void {
  const xdgConfig =
    process.env.XDG_CONFIG_HOME || path.join(options.home, ".config");
  const configDir = path.join(xdgConfig, "repomix");
  mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, "repomix.config.json");

  let existingRaw = "";
  let parsed: Record<string, unknown> = {};
  if (exists(configFile)) {
    try {
      existingRaw = readFileSync(configFile, "utf8");
      parsed = JSON.parse(existingRaw);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    parsed = {};
  const ignore = (
    parsed.ignore &&
    typeof parsed.ignore === "object" &&
    !Array.isArray(parsed.ignore)
      ? parsed.ignore
      : {}
  ) as Record<string, unknown>;
  ignore.useGitignore = true;
  ignore.useDefaultPatterns = true;
  ignore.useDotIgnore = true;

  const existingPatterns = new Set(
    Array.isArray(ignore.customPatterns)
      ? (ignore.customPatterns as string[])
      : []
  );
  for (const pattern of REPOMIX_CUSTOM_PATTERNS) {
    existingPatterns.add(pattern);
  }
  ignore.customPatterns = Array.from(existingPatterns);
  parsed.ignore = ignore;
  const nextRaw = `${JSON.stringify(parsed, null, 2)}\n`;
  if (nextRaw !== existingRaw) {
    writeFileSync(configFile, nextRaw);
  }
}

const CGC_GLOBAL_HELPERS_PATCH = `

def find_global_cgcignore() -> Optional[Path]:
    """Check for global .cgcignore in ~/.codegraphcontext/.cgcignore."""
    global_path = Path.home() / ".codegraphcontext" / ".cgcignore"
    if global_path.exists():
        return global_path
    return None


def find_git_exclude(project_root: Path) -> Optional[Path]:
    """Find .git/info/exclude in the repository."""
    exclude_path = project_root / ".git" / "info" / "exclude"
    if exclude_path.exists():
        return exclude_path
    return None


def find_global_gitignore() -> Optional[Path]:
    """Find global gitignore configured in git core.excludesFile."""
    try:
        import subprocess
        result = subprocess.run(
            ["git", "config", "--global", "--get", "core.excludesFile"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            p = Path(result.stdout.strip()).expanduser()
            if p.exists():
                return p
    except Exception:
        pass
    default_global = Path.home() / ".gitignore_global"
    if default_global.exists():
        return default_global
    return None
`;

function insertAfterDefaultIgnorePatterns(
  content: string,
  addition: string
): string {
  const idx = content.indexOf("DEFAULT_IGNORE_PATTERNS = [");
  if (idx === -1) return content;
  const insertPos = content.indexOf("\n", idx) + 1;
  return `${content.slice(0, insertPos)}${addition}${content.slice(insertPos)}`;
}

function patchCodeGraphContextConstants(cgcDir: string): void {
  const constantsFile = path.join(cgcDir, "tools", "indexing", "constants.py");
  if (!exists(constantsFile)) return;
  const original = readFileSync(constantsFile, "utf8");
  let content = original;
  if (!content.includes("repomix-output.*")) {
    content = insertAfterDefaultIgnorePatterns(
      content,
      '\n    # Repomix outputs\n    "repomix-output.*",\n    ".repomix-output.*",\n    "repomix-output-*/",\n    ".repomix/",\n'
    );
  }
  if (!content.includes("CGC_REPORT.md")) {
    content = insertAfterDefaultIgnorePatterns(
      content,
      '\n    # CGC Report artifacts\n    "CGC_REPORT.md",\n    "CGC_REPORT*.md",\n    "cgc_report.md",\n    "cgc_report*.md",\n'
    );
  }
  if (content !== original) writeFileSync(constantsFile, content, "utf8");
}

function patchCodeGraphContextIgnore(cgcDir: string): void {
  const cgcignoreFile = path.join(cgcDir, "core", "cgcignore.py");
  if (!exists(cgcignoreFile)) return;
  const cgcCode = readFileSync(cgcignoreFile, "utf8");
  if (cgcCode.includes("find_global_cgcignore")) return;
  const buildPos = cgcCode.indexOf("def build_ignore_spec(");
  if (buildPos === -1) return;
  writeFileSync(
    cgcignoreFile,
    `${cgcCode.slice(0, buildPos)}${CGC_GLOBAL_HELPERS_PATCH}\n${cgcCode.slice(buildPos)}`,
    "utf8"
  );
}

export function patchCodeGraphContextFalkorDb(cgcDir: string): void {
  const dbFalkorFile = path.join(cgcDir, "core", "database_falkordb.py");
  if (exists(dbFalkorFile)) {
    const original = readFileSync(dbFalkorFile, "utf8");
    const updated = original.replace(
      "atexit.register(self.shutdown)",
      "atexit.register(self.close_driver)"
    );
    if (updated !== original) writeFileSync(dbFalkorFile, updated, "utf8");
  }
  const workerFile = path.join(cgcDir, "core", "falkor_worker.py");
  if (exists(workerFile)) {
    const original = readFileSync(workerFile, "utf8");
    const upstreamTarget =
      '        except Exception as e:\n            logger.error(\n                f"Port {port} is already occupied by another service and cannot be reused by FalkorDB. "';
    const previousPatch = [
      "        except Exception as e:",
      "            try:",
      "                from redis import Redis",
      '                Redis(host="127.0.0.1", port=port, password=os.getenv("FALKORDB_PASSWORD") or None).shutdown(save=True)',
      "                time.sleep(0.3)",
      "            except Exception:",
      "                pass",
      '            if is_port_in_use("127.0.0.1", port):',
      "                logger.error(",
      '                    f"Port {port} is already occupied by another service and cannot be reused by FalkorDB. "'
    ].join("\n");
    const replacement = [
      "        except Exception as e:",
      "            from redis import Redis",
      '            for pw in dict.fromkeys((os.getenv("FALKORDB_PASSWORD") or None, None)):',
      "                try:",
      '                    Redis(host="127.0.0.1", port=port, password=pw).shutdown(save=True)',
      "                    time.sleep(0.3)",
      "                    break",
      "                except Exception:",
      "                    pass",
      '            if is_port_in_use("127.0.0.1", port):',
      "                logger.error(",
      '                    f"Port {port} is already occupied by another service and cannot be reused by FalkorDB. "'
    ].join("\n");
    if (original.includes(previousPatch)) {
      const updated = original.replace(previousPatch, replacement);
      if (updated !== original) writeFileSync(workerFile, updated, "utf8");
    } else if (
      original.includes(upstreamTarget) &&
      !original.includes("for pw in dict.fromkeys(")
    ) {
      const updated = original
        .replace(upstreamTarget, replacement)
        .replace(
          '                f"Underlying error: {e}"\n            )\n            sys.exit(1)',
          '                    f"Underlying error: {e}"\n                )\n                sys.exit(1)'
        );
      if (updated !== original) writeFileSync(workerFile, updated, "utf8");
    }
  }
}

function ensureCodeGraphContextPackagePatches(home: string): void {
  const libDir = path.join(
    home,
    ".local",
    "pipx",
    "venvs",
    "codegraphcontext",
    "lib"
  );
  if (!exists(libDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(libDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("python")) continue;
    const cgcDir = path.join(
      libDir,
      entry,
      "site-packages",
      "codegraphcontext"
    );
    if (!exists(cgcDir)) continue;
    try {
      patchCodeGraphContextConstants(cgcDir);
      patchCodeGraphContextIgnore(cgcDir);
      patchCodeGraphContextFalkorDb(cgcDir);
    } catch {
      // Non-fatal if package patch cannot be applied
    }
  }
}

function ensureGlobalCodeGraphContext(options: MaterializeOptions): void {
  const cgcDir = path.join(options.home, ".codegraphcontext");
  mkdirSync(cgcDir, { recursive: true });
  const envFile = path.join(cgcDir, ".env");
  const existingEnv = exists(envFile) ? readFileSync(envFile, "utf8") : "";
  const envLines = existingEnv.split(LINE_SPLIT_PATTERN);
  let found = false;
  const requiredDirs = CGC_IGNORE_DIRS.split(",");
  const updatedLines = envLines.map((line) => {
    if (IGNORE_DIRS_LINE_PATTERN.test(line)) {
      found = true;
      const existingDirs = extractIgnoreDirs(line);
      const set = new Set(existingDirs.map((d) => d.trim()).filter(Boolean));
      for (const d of requiredDirs) set.add(d.trim());
      return `IGNORE_DIRS="${Array.from(set).join(",")}"`;
    }
    return line;
  });
  if (!found) {
    if (updatedLines.length > 0 && updatedLines.at(-1) !== "") {
      updatedLines.push("");
    }
    updatedLines.push(`IGNORE_DIRS="${CGC_IGNORE_DIRS}"`);
  }
  const lastLine = updatedLines.at(-1);
  const nextEnv = `${updatedLines.join("\n")}${lastLine === "" ? "" : "\n"}`;
  if (nextEnv !== existingEnv) {
    writeFileSync(envFile, nextEnv);
  }

  const cgcIgnore = path.join(cgcDir, ".cgcignore");
  const existingIgnore = exists(cgcIgnore)
    ? readFileSync(cgcIgnore, "utf8")
    : "";
  const ignoreLines = new Set(existingIgnore.split(LINE_SPLIT_PATTERN));
  const missing = CGC_GLOBAL_PATTERNS.filter((p) => !ignoreLines.has(p));
  if (missing.length > 0) {
    const prefix =
      existingIgnore.length > 0 && !existingIgnore.endsWith("\n") ? "\n" : "";
    const header = "# CodeGraphContext universal ignore rules (AutoDev)\n";
    writeFileSync(
      cgcIgnore,
      `${existingIgnore}${prefix}${header}${missing.join("\n")}\n`
    );
  }

  ensureCodeGraphContextPackagePatches(options.home);
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
    } catch (error) {
      writeErrorLine(
        `could not unload obsolete ${label}: ${error instanceof Error ? error.message : String(error)}`
      );
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
    ...OBSOLETE_LAUNCH.map((label) =>
      path.join(home, "Library", "LaunchAgents", `${label}.plist`)
    ),
    path.join(hooks, OBSOLETE_DASHBOARD),
    ...OBSOLETE_RUNTIME_DATA_FILES.map((filePath) =>
      path.join(codexHome, filePath)
    ),
    path.join(hooks, "codex/lib/codex-spawn-tools.mjs"),
    path.join(hooks, "codex/lib/codex-state-collector.mjs"),
    path.join(hooks, "codex/lib/spawn-shim-mcp.mjs"),
    path.join(codexHome, "run", "autodev-otel-collector.pid"),
    // The ingress mode the router used to read before the telemetry cutover.
    path.join(codexHome, "otel-ingress.mode"),
    // Legacy command rules file before `.rulesync/permissions.jsonc` took over
    // Codex command rules as `rules/rulesync.rules`.
    path.join(codexHome, "rules", "default.rules")
  ];
  removeStalePaths(obsoletePaths, OBSOLETE_RUNTIME_PATH_REASON);
  removeStalePaths(
    OBSOLETE_HOOKS.map((name) => path.join(hooks, name)),
    "obsolete-runtime-hook"
  );
  removeStalePaths(
    OBSOLETE_COLLECTOR_HOOKS.map((name) => path.join(hooks, name)),
    "obsolete-runtime-hook"
  );
  removeStalePaths(
    OBSOLETE_DIRS.map((name) => path.join(hooks, name)),
    OBSOLETE_RUNTIME_DIRECTORY
  );
  // Claude reads skills through Codex's tools now, so its generated per-role
  // skill views have no reader.
  // The runtime tree once carried a lone copy of the orchestration skill's
  // SKILL.md without the references it names; skills are read only from their
  // installed link under `$HOME/.agents/skills`.
  removeStalePaths(
    [path.join(codexHome, ".rulesync")],
    OBSOLETE_RUNTIME_DIRECTORY
  );
  removeStalePaths(
    [path.join(codexHome, OBSOLETE_CLAUDE_SKILL_VIEWS)],
    OBSOLETE_RUNTIME_DIRECTORY
  );
}

type FileTarget = (filePath: string) => string;

/** The prefix of every manifest entry installed into the source generation. */
const RUNTIME_SOURCE_PREFIX = "runtime/src/";

/**
 * The installed Runtime source tree: every `runtime/src` manifest module at
 * its path under `$CODEX_HOME/src`, the mirror package manifest, and the
 * `node_modules` the tree resolves Runtime's own dependencies through.
 */
export function runtimeSourceTree(
  repositoryRoot: string,
  codexHome: string
): RuntimeSourceTree {
  const files = new Map<string, string | Buffer>();
  for (const filePath of RUNTIME_MODULES)
    if (filePath.startsWith(RUNTIME_SOURCE_PREFIX))
      files.set(
        filePath.slice(RUNTIME_SOURCE_PREFIX.length),
        readFileSync(path.join(repositoryRoot, filePath))
      );
  files.set(
    "package.json",
    renderRuntimeMirrorPackage({
      runtimePackage: readRuntimePackageManifest(repositoryRoot),
      materialized: new Set<string>(RUNTIME_MODULES)
    })
  );
  const nodeModules = nodeModuleLinks({ repositoryRoot, codexHome }).find(
    (link) => link.owner === "source-generation"
  )!.source;
  return { files, nodeModules };
}

/**
 * Install the Runtime-owned files.
 *
 * Everything outside `runtime/src` -- prompts and the vendored playtest core
 * -- is written file by file before the source tree changes, so the new tree
 * finds them in place. The source tree itself is published as one generation
 * and swapped in atomically: see `runtime-source-generation.ts`.
 */
function materializeRuntimeTree(
  repositoryRoot: string,
  codexHome: string,
  source: FileTarget,
  target: FileTarget
): void {
  const files = [
    ...RUNTIME_MODULES.filter(
      (filePath) => !filePath.startsWith(RUNTIME_SOURCE_PREFIX)
    ),
    ...PROMPT_ROLES.map((role) => `agents/prompts/roles/${role}.md`)
  ];
  for (const filePath of files)
    materializeRuntimeFile(source(filePath), target(filePath), 0o644);
  materializeRuntimeSourceGeneration(
    codexHome,
    runtimeSourceTree(repositoryRoot, codexHome)
  );
}

function materializeScripts(hooks: string, source: FileTarget): void {
  for (const name of HOOKS) {
    chmodSync(source(`scripts/${name}`), 0o755);
    materializeRuntimeFile(
      source(`scripts/${name}`),
      path.join(hooks, name),
      0o755
    );
  }
  for (const name of MCP_LAUNCHERS)
    linkRuntimeSource(source(`scripts/${name}`), path.join(hooks, name));
}

function linkRuntimeConfigs(codexHome: string, source: FileTarget): void {
  for (const name of CATALOGS)
    linkRuntimeSource(
      source(`config/catalogs/${name}-model-catalog.json`),
      path.join(codexHome, `${name}-model-catalog.json`)
    );
}

/**
 * Install AutoDev's Codex command rules as regular-file copies.
 *
 * Codex loads a rules entry only when it resolves to a file directly inside
 * `$CODEX_HOME/rules/`; anything else — a symlink into the checkout, for
 * example — is skipped silently. A symlinked `default.rules` left every rule
 * inert: `forbidden` commands ran, and the `allow` rule for `git add`/`git
 * commit` never lifted the workspace-write sandbox, so agents failed with
 * `.git/index.lock: Operation not permitted`. `docs/local-setup.md` records
 * the reproduction.
 */
export function materializeCommandRules(
  repositoryRoot: string,
  rules: string,
  rulesSource?: string
): void {
  if (rulesSource) {
    for (const name of RULES) {
      materializeRuntimeFile(rulesSource, path.join(rules, name), 0o644);
    }
    return;
  }
  const projection = createCodexPermissionsSource(repositoryRoot);
  try {
    for (const name of RULES) {
      materializeRuntimeFile(
        projection.rulesSource,
        path.join(rules, name),
        0o644
      );
    }
  } finally {
    rmSync(projection.root, { recursive: true, force: true });
  }
}

export interface NodeModuleLink {
  readonly source: string;
  readonly target: string;
  /**
   * Who creates the link: the installer, directly under `$CODEX_HOME`, or the
   * source generation, which carries its own link so it is complete before it
   * is swapped in.
   */
  readonly owner: "codex-home" | "source-generation";
}

/**
 * `$CODEX_HOME/src` mirrors `runtime/src`, and pnpm installs each workspace
 * package's dependencies into that package's own `node_modules` -- so the
 * mirror resolves nothing Runtime declares from the copied sources alone.
 * That is how the router came to crash-loop under KeepAlive with
 * `Cannot find package 'zod'`: nothing was wrong with the copy, only with the
 * resolution environment it was dropped into. Link the owning package's
 * dependency tree beside the mirror root, and keep the repository-root link
 * that resolves the workspace packages the mirror imports
 * (`@simulatorlife/autodev-core`, `@simulatorlife/autodev-data`).
 */
export function nodeModuleLinks(
  options: Pick<MaterializeOptions, "repositoryRoot" | "codexHome">
): readonly NodeModuleLink[] {
  return [
    {
      source: path.join(options.repositoryRoot, "node_modules"),
      target: path.join(options.codexHome, "node_modules"),
      owner: "codex-home"
    },
    {
      source: path.join(options.repositoryRoot, "runtime", "node_modules"),
      // runtimeTarget() installs every `runtime/src/...` module under
      // `$CODEX_HOME/src/...`, so node_modules beside that mirror root is the
      // directory a copied module's own walk-up reaches first.
      target: path.join(
        runtimeTarget("runtime/src", options.codexHome),
        "node_modules"
      ),
      owner: "source-generation"
    }
  ];
}

function linkNodeModules(options: MaterializeOptions): void {
  for (const { source, target, owner } of nodeModuleLinks(options)) {
    if (!exists(source))
      throw new Error(`missing ${source}; run pnpm install --frozen-lockfile`);
    if (owner !== "codex-home") continue;
    if (exists(target) && !isSymlink(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    linkRuntimeSource(source, target);
  }
}

function replaceSkillSymlinks(
  codexHome: string,
  skillsRoot: string,
  userSkills: string
): void {
  const names = userLevelSkills(skillsRoot);
  removeStalePaths(
    staleUserSkillLinks(skillsRoot, userSkills, names),
    OBSOLETE_RUNTIME_PATH_REASON
  );
  for (const name of names) {
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

/**
 * Links in the user's skills directory that point into the canonical source
 * at a skill that is no longer user-level (deleted, or now repository-only).
 * A link to anything else is the user's own and is left alone.
 */
export function staleUserSkillLinks(
  skillsRoot: string,
  userSkills: string,
  userLevel: readonly string[]
): string[] {
  if (!exists(userSkills)) return [];
  const keep = new Set(userLevel);
  return readdirSync(userSkills)
    .filter((name) => !keep.has(name))
    .map((name) => path.join(userSkills, name))
    .filter(
      (filePath) =>
        isSymlink(filePath) &&
        path.dirname(
          path.resolve(path.dirname(filePath), readlinkSync(filePath))
        ) === path.resolve(skillsRoot)
    );
}

/**
 * Whether the runtime has this skill installed from this canonical source.
 *
 * A skill is not projected into the runtime the way a command is: the
 * installer links the canonical source into the user's skills directory, so
 * the runtime reads the canonical source itself rather than a copy of it.
 * That makes the link the runtime's observation of the skill -- when the link
 * holds this source, the runtime is running exactly this canonical source,
 * and when it does not, the runtime's skill is something else or is not
 * installed at all.
 *
 * The layout of the user's skills directory is this module's to answer, so the
 * Control API asks it rather than repeating the path.
 */
export function installedSkillMatches(args: {
  readonly repositoryRoot: string;
  readonly home: string;
  readonly name: string;
}): boolean {
  return skillLinkMatches(
    path.join(args.repositoryRoot, ".rulesync", "skills", args.name),
    path.join(args.home, ".agents", "skills", args.name)
  );
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

/**
 * Apply the canonical MCP declaration to the runtime's applied state.
 *
 * Three artifacts carry the MCP configuration the runtime applies: the bridge
 * catalogue the MCP bridge reads, the role contracts that say which server a
 * role may use, and the composed user configuration Codex reads. They are
 * written from one projection, so the applied state cannot be one file that
 * was updated and another that was not.
 *
 * The composed configuration keeps the user's own MCP servers, because it is
 * composed with the configuration that is already there rather than over it.
 */
export function materializeMcpConfiguration(options: {
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly codexMcpSource: string;
  readonly codexPermissionsSource?: string;
}): void {
  materializeRenderedAgents(
    options.repositoryRoot,
    path.join(options.codexHome, "agents"),
    options.codexMcpSource
  );
  runBridgeMcpCatalogue(
    options.codexMcpSource,
    path.join(options.codexHome, "provider-runtime", "mcp-servers.json")
  );
  const configPath = path.join(options.codexHome, CONFIG_TOML_FILE);
  if (isSymlink(configPath))
    throw new Error(`refusing-symlinked-user-config ${configPath}`);
  const permissionsProjection = options.codexPermissionsSource
    ? null
    : createCodexPermissionsSource(options.repositoryRoot);
  try {
    const permissionsSource =
      options.codexPermissionsSource ?? permissionsProjection!.configSource;
    runCompose(
      path.join(options.repositoryRoot, "config/config.autodev.toml"),
      options.codexMcpSource,
      path.join(options.repositoryRoot, "agents/roles/orchestrator.toml"),
      configPath,
      configPath,
      false,
      {
        bundledPlugins: listBundledPlugins(options.codexHome),
        permissionsSource
      }
    );
  } finally {
    if (permissionsProjection) {
      rmSync(permissionsProjection.root, { recursive: true, force: true });
    }
  }
}

/**
 * Apply the canonical hook declaration, projected from the declaration as it
 * is now.
 *
 * The projection is generated from the canonical source rather than taken from
 * the install, so a declaration that changed since the last install is applied
 * as it stands. The generated projection is checked as well as written: a
 * generation that succeeded is not a projection that matches the source, and
 * the two are different facts.
 *
 * Only the hooks feature is generated. The other features' projections are
 * left exactly as they are, because a declaration of hooks says nothing about
 * the skills or the commands a repository also projects.
 *
 * Codex reads both `$CODEX_HOME/hooks.json` and the working project's
 * `.codex/hooks.json`. Projecting Codex hooks into this checkout as well as
 * the user level ran every Codex hook twice in AutoDev sessions (the root
 * bootstrap was injected 2-4 times per turn), so Codex hooks are written only
 * at user level by {@link writeCodexUserHooks}; `rulesync.jsonc` therefore
 * gives the `codexcli` target no `hooks` feature, and the repository
 * projection covers every other configured target.
 */

/**
 * Run the repository's `rulesync.jsonc` generation (or its `--check`), with
 * hooks projected for every configured target except the user-level ones.
 */
const REPOSITORY_RULESYNC_FINGERPRINT_PATHS = [
  "rulesync.jsonc",
  "rulesync.lock",
  "rulesync-npm.lock.json",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".rulesync",
  ".agents",
  ".agent",
  ".claude",
  ".codex",
  ".cursor",
  ".gemini",
  ".opencode",
  ".roo",
  path.join(".github", "copilot-instructions.md"),
  path.join(".github", "instructions"),
  path.join(".github", "prompts"),
  path.join(".github", "skills"),
  path.join(".github", "hooks"),
  path.join(".github", "agents"),
  path.join(".github", "chatmodes")
] as const;

function computeRepositoryRulesyncFingerprint(repositoryRoot: string): string {
  return computeRepoPathsFingerprint(
    repositoryRoot,
    REPOSITORY_RULESYNC_FINGERPRINT_PATHS,
    [`rulesync:${readRulesyncPackageVersion(repositoryRoot)}`]
  );
}

/**
 * The repository's Rulesync targets, each with the features it owns.
 *
 * The per-target map is the only shape that can give a shared output tree a
 * single owner. `.agents/skills/` is read by Codex CLI and Antigravity CLI
 * alike, so a second writer would have to produce byte-identical files, and
 * a skill whose frontmatter one client reads and the other ignores (such as
 * `user-invocable`) makes that impossible. Naming the owner per target keeps
 * one writer per tree.
 */
interface RulesyncProjectConfig {
  readonly targets: Readonly<Record<string, readonly string[]>>;
}

/**
 * Read the repository's Rulesync configuration.
 *
 * A configuration that does not name the features per target is rejected
 * rather than reinterpreted: RuleSync accepts a flat target list, and
 * reading that as a per-target map would silently generate nothing.
 */
function readRulesyncProjectConfig(configPath: string): RulesyncProjectConfig {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
    targets?: unknown;
  };
  const targets = parsed.targets;
  if (
    targets === null ||
    typeof targets !== "object" ||
    Array.isArray(targets)
  ) {
    throw new Error(
      `invalid-rulesync-config ${configPath}; "targets" must map every target to the features it owns.`
    );
  }
  const owned: Record<string, readonly string[]> = {};
  for (const [target, features] of Object.entries(targets)) {
    if (
      !Array.isArray(features) ||
      features.some((feature) => typeof feature !== "string")
    ) {
      throw new Error(
        `invalid-rulesync-config ${configPath}; the features of target "${target}" must be a list of feature names.`
      );
    }
    owned[target] = features;
  }
  return { targets: owned };
}

/**
 * Every feature any configured target owns, so a caller that asks for "the"
 * features gets them all.
 */
function configuredFeatures(
  targets: Readonly<Record<string, readonly string[]>>
): string[] {
  return [...new Set(Object.values(targets).flat())].sort((left, right) =>
    FEATURE_COLLATOR.compare(left, right)
  );
}

/**
 * The targets that own a feature.
 *
 * A run that names its targets and features replaces the configuration's
 * per-target map with a flat selection, so the owners are named here instead
 * of letting a second target write a tree the first one owns.
 */
function targetsOwning(
  targets: Readonly<Record<string, readonly string[]>>,
  feature: string
): string[] {
  return Object.entries(targets)
    .filter(([, features]) => features.includes(feature))
    .map(([target]) => target);
}

export function generateRepositoryRulesync(
  repositoryRoot: string,
  options: {
    readonly features?: readonly string[];
    readonly check?: boolean;
  } = {}
): void {
  const configPath = path.join(repositoryRoot, "rulesync.jsonc");
  const config = readRulesyncProjectConfig(configPath);
  const configFeatures = configuredFeatures(config.targets);
  const features = options.features ?? configFeatures;
  const requestedSet = new Set(features);
  const featuresKey = [...requestedSet].sort().join(",");
  const configFeaturesSet = new Set(configFeatures);
  const allConfigFeaturesKey = [...configFeaturesSet].sort().join(",");
  const isAllConfigFeatures =
    featuresKey === allConfigFeaturesKey && requestedSet.size > 0;
  const coveredByConfigAll = [...requestedSet].every((feature) =>
    configFeaturesSet.has(feature)
  );
  const forceRulesync = process.env.AUTODEV_FORCE_RULESYNC === "1";
  if (!forceRulesync) {
    const cache = readRepoInstallCache(repositoryRoot);
    const generateCache = cache.rulesyncGenerate;
    if (generateCache) {
      const preFingerprint =
        computeRepositoryRulesyncFingerprint(repositoryRoot);
      if (
        generateCache[featuresKey] === preFingerprint ||
        (coveredByConfigAll && generateCache["*"] === preFingerprint)
      ) {
        return;
      }
    }
  }
  if (options.check !== true && features.includes("skills")) {
    runRulesyncInstallFrozen(repositoryRoot);
  }
  const base: RulesyncGenerateOptions = {
    configPath,
    check: options.check === true,
    silent: true
  };
  if (options.features === undefined) {
    // The whole configuration, with its per-target map intact: naming a
    // feature or a target here would replace that map with a flat selection.
    runRulesyncGenerate(repositoryRoot, base);
  } else {
    for (const feature of features) {
      runRulesyncGenerate(repositoryRoot, {
        ...base,
        features: [feature],
        targets: targetsOwning(config.targets, feature)
      });
    }
  }
  const postFingerprint = computeRepositoryRulesyncFingerprint(repositoryRoot);
  const latestCache = readRepoInstallCache(repositoryRoot);
  const nextGenerateCache: Record<string, string> = {
    ...latestCache.rulesyncGenerate,
    [featuresKey]: postFingerprint
  };
  if (isAllConfigFeatures) {
    nextGenerateCache["*"] = postFingerprint;
  }
  writeRepoInstallCache(repositoryRoot, {
    ...latestCache,
    rulesyncGenerate: nextGenerateCache
  });
}

/** Render the Codex hooks file Rulesync projects for a user-level install. */
export function renderCodexUserHooks(repositoryRoot: string): string {
  const projectedHome = mkdtempSync(
    path.join(repositoryRoot, ".autodev-hooks-home-")
  );
  try {
    runRulesyncGenerate(
      repositoryRoot,
      {
        global: true,
        inputRoots: [path.join(repositoryRoot, ".rulesync")],
        targets: ["codexcli"],
        features: ["hooks"],
        silent: true
      },
      projectedHome
    );
    return readFileSync(path.join(projectedHome, ".codex", HOOKS_JSON), "utf8");
  } finally {
    rmSync(projectedHome, { recursive: true, force: true });
  }
}

/**
 * Write the user-level Codex hooks file and remove the repository projection
 * an earlier install left, which Codex would otherwise load a second time.
 */
export function writeCodexUserHooks(
  repositoryRoot: string,
  codexHome: string
): void {
  materializeRuntimeContent(
    renderCodexUserHooks(repositoryRoot),
    path.join(codexHome, HOOKS_JSON),
    0o644
  );
  rmSync(path.join(repositoryRoot, ".codex", HOOKS_JSON), { force: true });
}

export function materializeCurrentHookProjections(options: {
  readonly repositoryRoot: string;
  readonly codexHome: string;
}): void {
  generateRepositoryRulesync(options.repositoryRoot, { features: ["hooks"] });
  generateRepositoryRulesync(options.repositoryRoot, {
    features: ["hooks"],
    check: true
  });
  writeCodexUserHooks(options.repositoryRoot, options.codexHome);
  syncHookTrust(
    path.join(options.codexHome, CONFIG_TOML_FILE),
    options.codexHome,
    options.repositoryRoot
  );
}

/**
 * Apply the canonical MCP declaration, projected from the declaration as it
 * is now.
 *
 * The projection is generated from the canonical source rather than taken from
 * the install, so a declaration that changed since the last install is applied
 * as it stands.
 */
export function materializeCurrentMcpConfiguration(options: {
  readonly repositoryRoot: string;
  readonly codexHome: string;
}): void {
  const projection = createCodexMcpSource(options.repositoryRoot);
  const permissionsProjection = createCodexPermissionsSource(
    options.repositoryRoot
  );
  try {
    materializeCommandRules(
      options.repositoryRoot,
      path.join(options.codexHome, "rules"),
      permissionsProjection.rulesSource
    );
    materializeMcpConfiguration({
      repositoryRoot: options.repositoryRoot,
      codexHome: options.codexHome,
      codexMcpSource: projection.source,
      codexPermissionsSource: permissionsProjection.configSource
    });
  } finally {
    rmSync(permissionsProjection.root, { recursive: true, force: true });
    rmSync(projection.root, { recursive: true, force: true });
  }
}

function sameContent(source: string, target: string): boolean {
  try {
    return readFileSync(source).equals(readFileSync(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function loadCodexCommands(repositoryRoot: string) {
  const commandState = new RuleSyncRepository(repositoryRoot).loadCommands();
  if (commandState.valid !== true) {
    throw new Error(
      "Cannot load an absent or invalid RuleSync command catalog."
    );
  }
  return commandState.commands.filter(
    (command) =>
      command.targets.includes("*") || command.targets.includes("codexcli")
  );
}

/**
 * Project canonical RuleSync commands into `$CODEX_HOME/prompts/`.
 *
 * Rulesync's `codexcli` commands feature is global-only and honors `$HOME`
 * rather than `$CODEX_HOME`, so we run rulesync with `$HOME` pointing at a
 * throwaway directory and copy each generated prompt into the real Codex home.
 * The directory is reconciled against canonical commands whose targets
 * include `codexcli` or `*`.
 *
 * Returns the names of prompts whose installed content changed (added,
 * rewritten, or removed), sorted, so the caller can tell the user a running
 * Codex app must be restarted to see them.
 */
export function materializeCommands(
  options: Pick<MaterializeOptions, "repositoryRoot">,
  promptsDir: string
): string[] {
  const codexCommands = loadCodexCommands(options.repositoryRoot);
  const catalog = new Set(codexCommands.map((command) => command.name));
  mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
  const projectedHome = mkdtempSync(
    path.join(options.repositoryRoot, ".autodev-commands-home-")
  );
  try {
    runRulesyncGenerate(
      options.repositoryRoot,
      {
        global: true,
        inputRoots: [path.join(options.repositoryRoot, ".rulesync")],
        targets: ["codexcli"],
        features: ["commands"],
        silent: true
      },
      projectedHome
    );
    const projectedDir = path.join(projectedHome, ".codex", "prompts");
    let projectedFiles: string[];
    try {
      projectedFiles = readdirSync(projectedDir)
        .filter((entry) => entry.endsWith(".md"))
        .sort();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        codexCommands.length === 0
      ) {
        projectedFiles = [];
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `rulesync did not generate $CODEX_HOME/prompts under $HOME=${projectedHome}`
        );
      } else {
        throw error;
      }
    }
    const projectedNames = new Set(
      projectedFiles.map((entry) => entry.replace(MD_EXTENSION_PATTERN, ""))
    );
    const updated: string[] = [];
    for (const entry of projectedFiles) {
      const name = entry.replace(MD_EXTENSION_PATTERN, "");
      if (!catalog.has(name))
        throw new Error(
          `rulesync produced prompt "${name}" without a canonical Codex target`
        );
    }
    for (const command of codexCommands) {
      const name = command.name;
      if (!projectedNames.has(name))
        throw new Error(
          `RuleSync command "${name}" produced no codexcli projection`
        );
      const projected = path.join(projectedDir, `${name}.md`);
      const target = path.join(promptsDir, `${name}.md`);
      if (!sameContent(projected, target)) updated.push(name);
      materializeRuntimeFile(projected, target, 0o644);
    }
    const staleEntries = readdirSync(promptsDir).filter(
      (entry) =>
        entry.endsWith(".md") &&
        !catalog.has(entry.replace(MD_EXTENSION_PATTERN, ""))
    );
    if (staleEntries.length > 0) {
      removeStalePaths(
        staleEntries.map((entry) => path.join(promptsDir, entry)),
        OBSOLETE_RUNTIME_PATH_REASON
      );
      updated.push(
        ...staleEntries.map((entry) => entry.replace(MD_EXTENSION_PATTERN, ""))
      );
    }
    return updated.sort();
  } finally {
    rmSync(projectedHome, { recursive: true, force: true });
  }
}

/**
 * Regenerate every command projection from the canonical
 * `.rulesync/commands/` source: the repository outputs `rulesync.jsonc`
 * configures (Claude Code, Copilot, Antigravity CLI), verified with
 * `--check`, and the user-level Codex prompts Rulesync only projects
 * globally. Returns the Codex prompts whose installed content changed.
 */
export function materializeCurrentCommandProjections(options: {
  readonly repositoryRoot: string;
  readonly codexHome: string;
}): string[] {
  generateRepositoryRulesync(options.repositoryRoot, {
    features: ["commands"]
  });
  generateRepositoryRulesync(options.repositoryRoot, {
    features: ["commands"],
    check: true
  });
  return materializeCommands(
    { repositoryRoot: options.repositoryRoot },
    path.join(options.codexHome, "prompts")
  );
}

const STALE_ORCHESTRATOR_DEFAULTS: Record<
  string,
  {
    readonly applies: (entry: Record<string, unknown>) => boolean;
    readonly patch: Record<string, unknown>;
  }
> = {
  claude: {
    applies: (entry) =>
      entry.priority === 2 &&
      entry.model === "claude-opus-5-5" &&
      entry.reasoningEffort === "medium",
    patch: { reasoningEffort: "high" }
  },
  "antigravity-claude-gpt": {
    applies: (entry) =>
      entry.priority === 2 && entry.model === "claude-opus-5-5-medium",
    patch: { model: "claude-opus-5-5-high" }
  },
  "antigravity-gemini": {
    applies: (entry) =>
      entry.priority === 2 &&
      (entry.model === null || entry.model === "gemini-3.8-flash-high"),
    patch: { priority: 3 }
  },
  "antigravity-argon": {
    applies: (entry) =>
      entry.priority === 2 &&
      (entry.model === "gemini-4-argon-medium" || entry.model === null),
    patch: {
      priority: 3,
      model: "gemini-4-argon-high",
      reasoningEffort: "high"
    }
  }
};

/**
 * Upgrade known legacy degraded orchestrator entries in a persisted router
 * state file so stale snapshots from older defaults cannot shadow updated
 * `config/model-routing.json` priorities or reasoning efforts.
 */
export function reconcileStaleOrchestratorState(codexHome: string): boolean {
  const statePath = path.join(codexHome, "codex-router-state.json");
  if (!exists(statePath)) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }
  const assignments = parsed.roleAssignments;
  if (
    !assignments ||
    typeof assignments !== "object" ||
    Array.isArray(assignments)
  )
    return false;
  let changed = false;
  const record = assignments as Record<string, Record<string, unknown>>;
  for (const [provider, rule] of Object.entries(STALE_ORCHESTRATOR_DEFAULTS)) {
    const providerEntry = record[provider];
    const orchestrator = providerEntry?.orchestrator;
    if (
      !orchestrator ||
      typeof orchestrator !== "object" ||
      Array.isArray(orchestrator)
    )
      continue;
    const current = orchestrator as Record<string, unknown>;
    if (!rule.applies(current)) continue;
    providerEntry.orchestrator = { ...current, ...rule.patch };
    changed = true;
  }
  if (!changed) return false;
  atomicWriteSync(statePath, JSON.stringify(parsed, null, 2) + "\n", {
    mode: 0o644,
    skipUnchanged: true
  });
  return true;
}

function composeAndLinkConfigs(
  options: MaterializeOptions,
  source: FileTarget
): void {
  if (isSymlink(path.join(options.codexHome, "config.toml")))
    throw new Error(
      `refusing-symlinked-user-config ${path.join(options.codexHome, "config.toml")}`
    );
  linkRuntimeSource(
    source("config/model-routing.json"),
    path.join(options.codexHome, "codex-model-routing.json")
  );
  reconcileStaleOrchestratorState(options.codexHome);
  writeCodexUserHooks(options.repositoryRoot, options.codexHome);
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
    .filter(([command]) => providerCliInstalled(command))
    .map(([, targetName]) => targetName);
  if (targets.length > 0)
    runRulesyncGenerate(
      options.repositoryRoot,
      {
        global: true,
        inputRoots: [path.join(options.repositoryRoot, ".rulesync")],
        targets,
        features: ["mcp"],
        silent: true
      },
      options.home
    );
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
    options.home,
    options.repositoryRoot
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

function renderLaunchAgentsFor(paths: LaunchAgentPaths): void {
  const values = resolveLaunchAgentValues(paths);
  for (const label of LAUNCH_LABELS)
    renderLaunchAgent(
      path.join(paths.repositoryRoot, `config/launchagents/${label}.plist`),
      path.join(paths.home, "Library", "LaunchAgents", `${label}.plist`),
      values
    );
}

function prepareRunLogs(codexHome: string): void {
  const runDir = path.join(codexHome, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  for (const name of [
    "codex-autodev-console.launchd.out.log",
    "codex-autodev-console.launchd.err.log",
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

/**
 * Re-render the execution contract from `agents/roles/*.toml` against the
 * freshly-generated rulesync projection. The result is written in place to
 * the repo's `config/execution-contract.json` and to its installed copy under
 * `$CODEX_HOME/config`. Idempotent: same inputs produce the same output.
 */
function renderAndMaterializeContract(
  repositoryRoot: string,
  codexMcpSource: string,
  target: FileTarget
): void {
  const exitCode = runExecutionContract(
    path.join(repositoryRoot, "agents/roles"),
    codexMcpSource,
    path.join(repositoryRoot, "config/execution-contract.json"),
    target("config/execution-contract.json")
  );
  if (exitCode !== 0)
    throw new Error(`render-execution-contract exited with status ${exitCode}`);
}

/**
 * The tools AutoDev exposes through the bundled Codex App tools plugin.
 *
 * Plan mode instructs the model to call `request_user_input`; everything else
 * the plugin ships (thread create/fork/handoff/read/wait/list/archive,
 * automations) belongs to the one delegation surface, Codex's own
 * `multi_agent_v1__*` functions, and must not reach a model through `codex_app`.
 */
const CODEX_APP_ENABLED_TOOLS = ["request_user_input"] as const;

/**
 * Sentinel written under `$CODEX_HOME/autodev/`, outside the plugin cache that
 * Codex Desktop regenerates on startup. It is the durable record of what the
 * last install asserted and of the cache state that install found, so drift
 * introduced between installs is visible rather than silently re-fixed.
 */
const AUTODEV_CODEX_APP_SENTINEL_PATH = path.join(
  "autodev",
  "codex-app-tools-state.json"
);
const AUTODEV_CODEX_APP_SENTINEL_TAG = "autodev-codex-app-tools-v1";

interface CodexAppVersionState {
  lastAssertedAt: string;
  /** Cache `enabled` flag observed before this install re-asserted it. */
  observedEnabled: boolean;
  /** Cache tool allowlist observed before this install re-asserted it. */
  observedTools: string[] | null;
  /** Whether this install had to repair drift in the plugin cache. */
  rewrotePluginCache: boolean;
}
interface CodexAppSentinel {
  sentinel: string;
  lastAssertedAt: string;
  /** Whether the most recent install found and repaired cache drift. */
  lastInstallRepairedDrift: boolean;
  versions: Record<string, CodexAppVersionState>;
}

/** A sentinel with no usable prior state. */
function emptyCodexAppSentinel(): CodexAppSentinel {
  return {
    sentinel: AUTODEV_CODEX_APP_SENTINEL_TAG,
    lastAssertedAt: new Date(0).toISOString(),
    lastInstallRepairedDrift: false,
    versions: {}
  };
}

/** Prior sentinel state, or a fresh one when it is absent or unrecognised. */
function loadCodexAppSentinel(sentinelPath: string): CodexAppSentinel {
  let parsed: Partial<CodexAppSentinel>;
  try {
    parsed = JSON.parse(
      readFileSync(sentinelPath, "utf8")
    ) as Partial<CodexAppSentinel>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyCodexAppSentinel();
  }
  const versions = parsed?.versions;
  if (
    parsed?.sentinel !== AUTODEV_CODEX_APP_SENTINEL_TAG ||
    !versions ||
    typeof versions !== "object" ||
    Array.isArray(versions)
  )
    return emptyCodexAppSentinel();
  return {
    sentinel: AUTODEV_CODEX_APP_SENTINEL_TAG,
    lastAssertedAt: parsed.lastAssertedAt ?? new Date(0).toISOString(),
    lastInstallRepairedDrift: parsed.lastInstallRepairedDrift === true,
    versions
  };
}

/** The `codex_app` server entry in a cached `.mcp.json`, or null when absent. */
function readCodexAppCacheEntry(configPath: string): {
  document: Record<string, unknown>;
  server: Record<string, unknown>;
} | null {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const servers = document.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  const server = (servers as Record<string, unknown>).codex_app;
  if (!server || typeof server !== "object") return null;
  return { document, server: server as Record<string, unknown> };
}

/**
 * Re-assert one cached plugin version, returning what was observed before the
 * assertion and whether the cache had to be repaired.
 */
function assertCodexAppCacheVersion(
  configPath: string,
  now: string
): CodexAppVersionState | null {
  const found = readCodexAppCacheEntry(configPath);
  if (!found) return null;
  const { document, server } = found;

  const observedEnabled = server.enabled === true;
  const observedTools = Array.isArray(server.enabled_tools)
    ? (server.enabled_tools as unknown[]).filter(
        (tool): tool is string => typeof tool === "string"
      )
    : null;
  const toolsMatch =
    observedTools?.length === CODEX_APP_ENABLED_TOOLS.length &&
    CODEX_APP_ENABLED_TOOLS.every(
      (tool, index) => observedTools[index] === tool
    );

  // Re-assert unconditionally: Codex Desktop regenerates this cache on
  // startup, so "it was correct last install" is not evidence about now.
  const rewrotePluginCache = !observedEnabled || !toolsMatch;
  if (rewrotePluginCache) {
    server.enabled = true;
    server.enabled_tools = [...CODEX_APP_ENABLED_TOOLS];
    writeFileSync(configPath, JSON.stringify(document, null, 2) + "\n", "utf8");
  }

  return {
    lastAssertedAt: now,
    observedEnabled,
    observedTools,
    rewrotePluginCache
  };
}

/** Cached plugin version directories, newest-first order not required. */
function codexAppCacheVersions(cacheRoot: string): string[] {
  try {
    return readdirSync(cacheRoot).filter((entry) => {
      try {
        return lstatSync(path.join(cacheRoot, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Idempotently re-assert the `codex_app` MCP server gates inside every cached
 * version of the bundled `codex-app-tools` plugin, then record the outcome in
 * the sentinel.
 *
 * Codex Desktop rewrites this cache on startup, so the assertion is
 * unconditional: each install compares the cache against the declared
 * `enabled`/`enabled_tools` state, repairs any difference, and writes the
 * sentinel whether or not a repair was needed. The sentinel is a record, never
 * a short-circuit. The user-level gate itself is declared in
 * `config/config.autodev.toml` and re-asserted by `compose`.
 */
export function ensureCodexAppMcpServerEnabled(codexHome: string): void {
  const cacheRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "codex-app-tools"
  );
  const versions = codexAppCacheVersions(cacheRoot);
  if (versions.length === 0) return;

  const sentinelPath = path.join(codexHome, AUTODEV_CODEX_APP_SENTINEL_PATH);
  const sentinel = loadCodexAppSentinel(sentinelPath);
  const now = new Date().toISOString();

  let repairedDrift = false;
  for (const version of versions) {
    const state = assertCodexAppCacheVersion(
      path.join(cacheRoot, version, ".mcp.json"),
      now
    );
    if (!state) continue;
    sentinel.versions[version] = state;
    repairedDrift ||= state.rewrotePluginCache;
  }

  // Written on every install, including clean ones, so the next install can
  // tell "Codex rewrote the cache again" from "nothing touched it".
  sentinel.lastAssertedAt = now;
  sentinel.lastInstallRepairedDrift = repairedDrift;
  mkdirSync(path.dirname(sentinelPath), { recursive: true, mode: 0o700 });
  writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + "\n", "utf8");
}

export function materializeInstallation(options: MaterializeOptions): void {
  const hooks = path.join(options.codexHome, "hooks"),
    rules = path.join(options.codexHome, "rules"),
    prompts = path.join(options.codexHome, "prompts"),
    userSkills = path.join(options.home, ".agents", "skills"),
    skillsRoot = path.join(options.repositoryRoot, ".rulesync", "skills");
  const launchd = new LaunchdClient();
  bootoutObsoleteLaunchLabels(launchd);
  removeObsoleteRuntimeArtifacts(options.codexHome, options.home, hooks);
  linkNodeModules(options);
  const source: FileTarget = (filePath) =>
    path.join(options.repositoryRoot, filePath);
  const target: FileTarget = (filePath) =>
    runtimeTarget(filePath, options.codexHome, hooks);
  materializeRuntimeTree(
    options.repositoryRoot,
    options.codexHome,
    source,
    target
  );
  materializeScripts(hooks, source);
  runModelCatalog(
    source("config/model-routing.json"),
    source("config/catalogs"),
    source("config/catalogs/codex-model-catalog.json")
  );
  linkRuntimeConfigs(options.codexHome, source);
  const permissionsProjection = createCodexPermissionsSource(
    options.repositoryRoot
  );
  try {
    materializeCommandRules(
      options.repositoryRoot,
      rules,
      permissionsProjection.rulesSource
    );
    replaceSkillSymlinks(options.codexHome, skillsRoot, userSkills);
    materializeMcpConfiguration({
      repositoryRoot: options.repositoryRoot,
      codexHome: options.codexHome,
      codexMcpSource: options.codexMcpSource,
      codexPermissionsSource: permissionsProjection.configSource
    });
  } finally {
    rmSync(permissionsProjection.root, { recursive: true, force: true });
  }
  generateRepositoryRulesync(options.repositoryRoot);
  const updatedPrompts = materializeCommands(options, prompts);
  // The Codex desktop app reads $CODEX_HOME/prompts once, when its window
  // loads, and never re-reads it: an install that changed a prompt while the
  // app was open left `/prompts:<name>` expanding the old text.
  if (updatedPrompts.length > 0)
    writeLine(
      `updated Codex prompts: ${updatedPrompts.join(", ")} -- restart the Codex app to load them (it reads prompts only when its window opens)`
    );
  ensureExclude(options);
  ensureGlobalGitExcludes(options);
  ensureGlobalRepomixConfig(options);
  ensureGlobalCodeGraphContext(options);
  ensureBootstrapScript(options);
  composeAndLinkConfigs(options, source);
  ensureCodexAppMcpServerEnabled(options.codexHome);
  renderAndMaterializeContract(
    options.repositoryRoot,
    options.codexMcpSource,
    target
  );
  renderGlobalMcpIfNeeded(options);
  applyAntigravityIfInstalled(options, skillsRoot);
  renderLaunchAgentsFor({
    repositoryRoot: options.repositoryRoot,
    home: options.home,
    codexHome: options.codexHome
  });
  prepareRunLogs(options.codexHome);
  const autodevHome =
    options.autodevHome ?? resolveAutodevHome(process.env, options.home);
  if (path.resolve(autodevHome) !== path.resolve(options.codexHome)) {
    const autodevHooks = path.join(autodevHome, "hooks");
    linkNodeModules({ ...options, codexHome: autodevHome });
    materializeRuntimeTree(
      options.repositoryRoot,
      autodevHome,
      source,
      (filePath) => runtimeTarget(filePath, autodevHome, autodevHooks)
    );
    materializeScripts(autodevHooks, source);
    materializeRuntimeFile(
      source("config/execution-contract.json"),
      path.join(autodevHome, "config", "execution-contract.json"),
      0o644
    );
    materializeMcodeProjection({
      repositoryRoot: options.repositoryRoot,
      mcodeHome: path.join(autodevHome, "providers", "mcode")
    });
    prepareRunLogs(autodevHome);
  }
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

if (isEntryPoint(import.meta.url)) {
  try {
    const env = process.env;
    const repositoryRoot =
      env.AUTODEV_REPO_ROOT ??
      path.resolve(resolveRuntimeSourceRoot(import.meta.dirname));
    const home = env.HOME ?? homedir();
    const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
    const mcp = env.AUTODEV_CODEX_MCP_SOURCE;
    if (!mcp) throw new Error("AUTODEV_CODEX_MCP_SOURCE is required");
    materializeInstallation({
      repositoryRoot,
      home,
      codexHome,
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
