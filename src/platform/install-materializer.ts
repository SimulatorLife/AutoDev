import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { runExecutionContract } from "../config/render-execution-contract.ts";
import { runModelCatalog } from "../config/render-model-catalog.ts";
import {
  atomicWrite,
  parseTomlFile,
  serializeToml,
  type TomlTable
} from "../config/toml.ts";
import { writeErrorLine, writeLine } from "../shared/output.ts";
import {
  updateAntigravityPermissions,
  updateAntigravitySkills
} from "./antigravity-settings.ts";
import { resolveServiceNode } from "./host-arch.ts";
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
  "src/shared/executables.ts",
  "src/agents/bridge-role.ts",
  "src/agents/bridge-sandbox.ts",
  "src/telemetry/agent-events.ts",
  "src/agents/agent-activity.ts",
  "src/shared/provider-limits.ts",
  "src/shared/responses-item-ids.ts",
  "src/shared/responses-continuation.ts",
  "src/shared/output.ts",
  "src/shared/tool-names.ts",
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
  "src/mcp/process-registry.ts",
  "src/router/tool-call-ownership.ts",
  "src/shared/execution-contract.ts",
  "src/router/status.ts",
  "src/cli/router-status.ts",
  "src/config/toml.ts",
  "src/config/compose-user-config.ts",
  "src/config/render-agent-configs.ts",
  "src/config/render-bridge-mcp-catalogue.ts",
  "src/config/render-execution-contract.ts",
  "src/config/render-model-catalog.ts",
  "agents/prompts/base.md",
  "agents/prompts/leaf.md",
  "agents/prompts/code-search.md",
  "agents/prompts/orchestrator.md",
  "src/hooks/command-utils.ts",
  "src/hooks/skill-read-telemetry.ts",
  "src/hooks/session-start.ts",
  "src/hooks/subagent-start.ts",
  "src/platform/macos/launchd.ts",
  "src/platform/host-arch.ts",
  "src/platform/macos/launchagent.ts",
  "src/platform/router-ensure.ts",
  "src/platform/copilot-ensure.ts",
  "src/platform/antigravity-ensure.ts",
  "src/platform/claude-ensure.ts",
  "src/platform/minimax-ensure.ts",
  "src/platform/antigravity-settings.ts",
  "src/platform/code-graph-ensure.ts",
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
  "doubt-driven-development",
  "improve-codebase-architecture",
  "lsp-mcp-server",
  "orchestration",
  "remove-legacy-shims",
  "resolve-merge-conflicts",
  "writing-agent-skills"
] as const;
/**
 * Codex custom prompts (slash commands) installed at $CODEX_HOME/prompts/<name>.md.
 *
 * Source of truth is `.rulesync/commands/<name>.md`. This catalog is the
 * union of the prior AutoDev Codex prompt catalog (build-fix, css-cleanup,
 * dedupe-helper, file-organize, merge-prs, new-feature, optimize,
 * resolve-merges, test-fix) and the AutoDev-owned generic scheduler catalog
 * formerly published at `.agents/prompts/*.md`. The three slugs that
 * appeared under both names (bug-fix, lint-fix, dedupe-helper / former
 * helper-substitution) were merged in place so the AutoDev rulesync body
 * remains the only scheduled entry for each.
 *
 * Rulesync's codexcli commands feature is global-only and respects $HOME
 * rather than $CODEX_HOME, so the materializer runs rulesync with $HOME
 * pointed at a throwaway directory and copies each generated prompt into
 * the real $CODEX_HOME/prompts/. The AutoDev-owned prompts directory is
 * then reconciled against this catalog: `*.md` files in $CODEX_HOME/prompts/
 * that are not listed here are removed during install. Upstream Codex marks
 * custom prompts deprecated in favour of skills, but the catalog stays here
 * because prompts remain functional and the AutoDev agents surface them
 * through `/<name>` invocations.
 */
export const COMMANDS = [
  "abstraction-layer",
  "advance-autodev",
  "architectural-audit",
  "bad-test-remediation",
  "bloat-trimming",
  "bug-fix",
  "build-fix",
  "cohesion-refactor",
  "composition-over-inheritance",
  "configuration-improvement",
  "consolidate-files",
  "control-flow-clarity",
  "css-cleanup",
  "dead-code-audit",
  "decouple-architecture",
  "dedupe-helper",
  "defensive-input",
  "demeter",
  "dependency-hygiene",
  "docstrings-comments",
  "document-intent",
  "documentation-refresh",
  "dry",
  "duplicate-report",
  "error-handling",
  "extensibility",
  "file-organize",
  "floating-point-safety",
  "generalization",
  "interface-segregation",
  "kiss",
  "legacy-api-migration",
  "legacy-shim-removal",
  "lint-fix",
  "logic-deduplication",
  "loop-mutation",
  "low-coupling",
  "memory-footprint",
  "merge-prs",
  "micro-optimization",
  "new-feature",
  "nullability-guardrails",
  "optimize",
  "organization",
  "parameter-flexibility",
  "pola",
  "policy-mechanism",
  "polymorphic-collaborators",
  "resolve-merges",
  "resource-leak",
  "single-responsibility",
  "split-long-file",
  "style-consistency",
  "test-coverage",
  "test-deduplication",
  "test-duration",
  "test-fix",
  "test-isolation",
  "todo-implementation",
  "typed-flags",
  "usability",
  "validation-failure-recovery"
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
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const result = execFileSync(command, [...args], {
    cwd,
    env: { ...env },
    stdio: "inherit"
  });
  void result;
}
function rulesync(
  options: Pick<MaterializeOptions, "repositoryRoot">,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): void {
  run(
    path.join(options.repositoryRoot, "node_modules/.bin/rulesync"),
    args,
    options.repositoryRoot,
    env
  );
}
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
  try {
    execFileSync(target, [options.repositoryRoot], { stdio: "ignore" });
  } catch {
    // Non-fatal if bootstrap execution fails during install
  }
}

export const UNIVERSAL_GIT_EXCLUDES = [
  ".codegraphcontext/",
  ".cgc/",
  ".cgc_cache/",
  ".cgc-cache/",
  ".cgc-state/",
  ".cgc-state-*/",
  ".cgcignore",
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
  ".cgcignore",
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

  let parsed: Record<string, unknown> = {};
  if (exists(configFile)) {
    try {
      parsed = JSON.parse(readFileSync(configFile, "utf8"));
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
  writeFileSync(configFile, `${JSON.stringify(parsed, null, 2)}\n`);
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
  writeFileSync(
    envFile,
    `${updatedLines.join("\n")}${lastLine === "" ? "" : "\n"}`
  );

  try {
    execFileSync("cgc", ["config", "set", "IGNORE_DIRS", CGC_IGNORE_DIRS], {
      stdio: "ignore"
    });
  } catch {
    // Ignored if cgc CLI is not installed or returns error
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

function materializeScripts(hooks: string, source: FileTarget): void {
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

function sameContent(source: string, target: string): boolean {
  try {
    return readFileSync(source).equals(readFileSync(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Project Codex custom prompts (`COMMANDS`) into $CODEX_HOME/prompts/.
 *
 * Rulesync's `codexcli` commands feature is global-only and honors `$HOME`
 * rather than `$CODEX_HOME`, so we run rulesync with `$HOME` pointing at a
 * throwaway directory (created via `mkdtempSync`, cleaned in `finally`,
 * same spirit as `materializeRenderedAgents`) and copy each generated prompt
 * into the real `$CODEX_HOME/prompts/` with `materializeRuntimeFile`. The
 * prompts directory is then reconciled against the `COMMANDS` catalog via
 * `removeStalePaths` so the catalog is the single source of truth: any
 * `*.md` in the directory that is not in the catalog is removed.
 *
 * Returns the names of the prompts whose installed content changed (added,
 * rewritten, or removed), sorted, so the caller can tell the user a running
 * Codex app must be restarted to see them.
 */
export function materializeCommands(
  options: Pick<MaterializeOptions, "repositoryRoot">,
  promptsDir: string
): string[] {
  mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
  const projectedHome = mkdtempSync(
    path.join(options.repositoryRoot, ".autodev-commands-home-")
  );
  try {
    rulesync(
      options,
      [
        "generate",
        "--global",
        "--input-roots",
        path.join(options.repositoryRoot, ".rulesync"),
        "--targets",
        "codexcli",
        "--features",
        "commands",
        "--silent"
      ],
      { ...process.env, HOME: projectedHome }
    );
    const projectedDir = path.join(projectedHome, ".codex", "prompts");
    let projectedFiles: string[];
    try {
      projectedFiles = readdirSync(projectedDir)
        .filter((entry) => entry.endsWith(".md"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `rulesync did not generate $CODEX_HOME/prompts under $HOME=${projectedHome}`
        );
      }
      throw error;
    }
    const projectedNames = new Set(
      projectedFiles.map((entry) => entry.replace(MD_EXTENSION_PATTERN, ""))
    );
    const catalog = new Set<string>(COMMANDS);
    const updated: string[] = [];
    for (const entry of projectedFiles) {
      const name = entry.replace(MD_EXTENSION_PATTERN, "");
      if (!catalog.has(name))
        throw new Error(
          `rulesync produced prompt "${name}" that is not in the COMMANDS catalog`
        );
    }
    for (const name of catalog) {
      if (!projectedNames.has(name))
        throw new Error(
          `COMMANDS catalog entry "${name}" produced no rulesync projection`
        );
      const projected = path.join(projectedDir, `${name}.md`);
      const target = path.join(promptsDir, `${name}.md`);
      if (!sameContent(projected, target)) updated.push(name);
      materializeRuntimeFile(projected, target, 0o644);
    }
    const catalogSet = new Set<string>(COMMANDS);
    const staleEntries = readdirSync(promptsDir).filter(
      (entry) =>
        entry.endsWith(".md") &&
        !catalogSet.has(entry.replace(MD_EXTENSION_PATTERN, ""))
    );
    if (staleEntries.length > 0) {
      removeStalePaths(
        staleEntries.map((entry) => path.join(promptsDir, entry)),
        "obsolete-runtime-path"
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
      { codexHome, home, repositoryRoot, nodeBin: resolveServiceNode(home) }
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

/**
 * Re-render the execution contract from `agents/roles/*.toml` against the
 * freshly-generated rulesync projection. The result is written in place to
 * the repo's `config/execution-contract.json` so the existing
 * `materializeRuntimeSources` step copies the fresh copy to the runtime
 * target on the next loop. Idempotent: same inputs produce the same output.
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
 * automations) belongs to the role-based delegation surface (`autodev_spawn`)
 * and must not reach a model through `codex_app`.
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
    agents = path.join(options.codexHome, "agents"),
    rules = path.join(options.codexHome, "rules"),
    prompts = path.join(options.codexHome, "prompts"),
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
  runModelCatalog(
    source("config/model-routing.json"),
    source("config/catalogs"),
    source("config/catalogs/codex-model-catalog.json")
  );
  linkRuntimeConfigs(options.codexHome, source, rules);
  replaceSkillSymlinks(options.codexHome, skillsRoot, userSkills);
  materializeRenderedAgents(
    options.repositoryRoot,
    agents,
    options.codexMcpSource
  );
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
  const updatedPrompts = materializeCommands(options, prompts);
  // The Codex desktop app reads $CODEX_HOME/prompts once, when its window
  // loads, and never re-reads it: an install that changed a prompt while the
  // app was open left `/prompts:<name>` expanding the old text.
  if (updatedPrompts.length > 0)
    writeLine(
      `updated Codex prompts: ${updatedPrompts.join(", ")} -- restart the Codex app to load them (it reads prompts only when its window opens)`
    );
  ensureExclude(options);
  ensureBootstrapScript(options);
  ensureGlobalGitExcludes(options);
  ensureGlobalRepomixConfig(options);
  ensureGlobalCodeGraphContext(options);
  composeAndLinkConfigs(options, source);
  ensureCodexAppMcpServerEnabled(options.codexHome);
  renderAndMaterializeContract(
    options.repositoryRoot,
    options.codexMcpSource,
    target
  );
  renderGlobalMcpIfNeeded(options);
  applyAntigravityIfInstalled(options, skillsRoot);
  renderLaunchAgentsFor(
    options.repositoryRoot,
    options.home,
    options.codexHome
  );
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
