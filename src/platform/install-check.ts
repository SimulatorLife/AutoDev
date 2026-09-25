import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { runCompose } from "../config/compose-user-config.ts";
import { renderAgentDirectory } from "../config/render-agent-configs.ts";
import { runBridgeMcpCatalogue } from "../config/render-bridge-mcp-catalogue.ts";
import { renderExecutionContract } from "../config/render-execution-contract.ts";
import { runModelCatalog } from "../config/render-model-catalog.ts";
import { writeErrorLine, writeLine } from "../shared/output.ts";
import {
  antigravitySkillsStatus,
  missingAntigravityPermissions
} from "./antigravity-settings.ts";
import {
  checkCocoIndex,
  checkCodeGraphContext,
  checkPythonLanguageServer,
  resolveDependencyOptions
} from "./dependencies.ts";
import { resolveServiceNode } from "./host-arch.ts";
import { createCodexMcpSource } from "./install-command.ts";
import {
  CATALOGS,
  checkHookTrust,
  COMMANDS,
  DASHBOARD,
  HOOKS,
  LAUNCH_LABELS,
  MCP_LAUNCHERS,
  OBSOLETE_CLAUDE_SKILL_VIEWS,
  OBSOLETE_DIRS,
  OBSOLETE_HOOKS,
  OTEL_RUNTIME,
  PROFILES,
  PROMPT_ROLES,
  ROLES,
  RULES,
  RUNTIME_MODULES,
  SKILLS
} from "./install-materializer.ts";
import { readCollectorMode } from "./install-state.ts";
import { launchAgentMatches } from "./macos/launchagent.ts";
import { resolveCollectorOptions, runCollector } from "./otel-collector.ts";
import {
  runtimeFileMatches,
  runtimeLinkMatches,
  runtimeTarget,
  skillLinkMatches
} from "./runtime-files.ts";
import { stalePaths } from "./runtime-reconciliation.ts";

export interface InstallCheckOptions {
  readonly repositoryRoot?: string;
  readonly home?: string;
  readonly codexHome?: string;
  readonly materializeOnly?: boolean;
}

const LINE_SPLIT_PATTERN = /\r?\n/u;
const MD_EXTENSION_PATTERN = /\.md$/u;
const WHITESPACE_SPLIT_PATTERN = /\s+/u;
const CODEX_ROUTER_AUTH_TOKEN_PATTERN = /^CODEX_ROUTER_AUTH_TOKEN=([^\n]*)$/mu;

function commandAvailable(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function sourceRoot(options: InstallCheckOptions): string {
  return path.resolve(
    options.repositoryRoot ??
      process.env.AUTODEV_REPO_ROOT ??
      path.join(import.meta.dirname, "..", "..")
  );
}
function lstatSafe(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
function check(
  label: string,
  condition: boolean,
  failures: { value: number }
): void {
  if (condition) writeLine(`ok ${label}`);
  else {
    writeLine(`missing-or-drifted ${label}`);
    failures.value = 1;
  }
}
function tracked(repositoryRoot: string, filePath: string): boolean {
  try {
    const files = execFileSync("git", ["-C", repositoryRoot, "ls-files"], {
      encoding: "utf8"
    });
    const relative = filePath.startsWith(`${repositoryRoot}/`)
      ? filePath.slice(repositoryRoot.length + 1)
      : filePath;
    return files
      .split(LINE_SPLIT_PATTERN)
      .some((file) => file === relative || file.startsWith(`${relative}/`));
  } catch {
    return false;
  }
}
function staleCheck(
  options: { repositoryRoot: string; home: string; codexHome: string },
  failures: { value: number }
): void {
  const hooks = path.join(options.codexHome, "hooks");
  const paths = [
    path.join(
      options.home,
      "Library",
      "LaunchAgents",
      "com.codex.antigravity-litellm.plist"
    ),
    path.join(options.home, ".config", "litellm", "antigravity.yaml"),
    path.join(
      options.home,
      ".codex",
      "codex-antigravity-litellm-config.sha256"
    ),
    path.join(hooks, "codex", "lib", "codex-spawn-tools.mjs"),
    path.join(hooks, "codex", "lib", "codex-state-collector.mjs"),
    path.join(hooks, "codex", "lib", "spawn-shim-mcp.mjs"),
    ...OBSOLETE_HOOKS.map((name) => path.join(hooks, name)),
    ...OBSOLETE_DIRS.map((name) => path.join(hooks, name)),
    path.join(options.codexHome, OBSOLETE_CLAUDE_SKILL_VIEWS)
  ];
  for (const filePath of stalePaths(paths)) {
    writeLine(`obsolete-runtime-path ${filePath}`);
    failures.value = 1;
  }
}
function checkAuth(
  options: { codexHome: string },
  failures: { value: number }
): void {
  const envFile =
    process.env.CODEX_ENV_FILE?.trim() || path.join(options.codexHome, ".env");
  if (!existsSync(envFile)) {
    writeLine(
      "router auth token not staged (use --enable-router-auth during a planned restart)"
    );
    return;
  }
  const token =
    readFileSync(envFile, "utf8")
      .match(CODEX_ROUTER_AUTH_TOKEN_PATTERN)?.[1]
      ?.trim() ?? "";
  if (!token) {
    writeLine(
      "router auth token not staged (use --enable-router-auth during a planned restart)"
    );
    return;
  }
  let status: { authentication?: { responseRequests?: boolean } };
  try {
    status = JSON.parse(
      execFileSync(
        "curl",
        ["--silent", "--max-time", "1", "http://127.0.0.1:4100/status"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      )
    ) as { authentication?: { responseRequests?: boolean } };
  } catch {
    writeLine("router auth token staged (router status unavailable)");
    return;
  }
  if (!status?.authentication?.responseRequests) {
    writeLine(
      "router auth token staged; active router still needs a planned restart"
    );
    return;
  }
  if (
    process.env.AUTODEV_SKIP_LAUNCHCTL !== "1" &&
    commandAvailable("launchctl")
  ) {
    let launchd = "";
    try {
      launchd = execFileSync(
        "launchctl",
        ["getenv", "CODEX_ROUTER_AUTH_TOKEN"],
        { encoding: "utf8" }
      ).trim();
    } catch {
      /* unavailable */
    }
    if (!launchd) {
      writeLine(
        "action required: router is enforcing auth but the launchd user environment has no token; Codex Desktop will 401 (restart the router agent, then relaunch Codex)"
      );
      failures.value = 1;
      return;
    }
    if (launchd !== token) {
      writeLine(
        "action required: router is enforcing auth but the launchd user environment holds a stale token; Codex Desktop will 401 (restart the router agent, then relaunch Codex)"
      );
      failures.value = 1;
      return;
    }
    let stalePids: string[] = [];
    try {
      const pids = execFileSync("pgrep", ["-x", "codex"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
        .trim()
        .split(WHITESPACE_SPLIT_PATTERN)
        .filter(Boolean);
      stalePids = pids.filter((pid) => {
        try {
          const command = execFileSync("ps", ["eww", "-o", "command=", pid], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          });
          return !command
            .split(" ")
            .map((entry) => entry.trim())
            .includes(`CODEX_ROUTER_AUTH_TOKEN=${token}`);
        } catch {
          return true;
        }
      });
    } catch {
      /* no running Codex process is an acceptable state */
    }
    if (stalePids.length > 0) {
      writeLine(
        `action required: running Codex process predates the current auth token and will 401 (pid${stalePids.length === 1 ? "" : "s"} ${stalePids.join(" ")}); quit and relaunch Codex`
      );
      failures.value = 1;
      return;
    }
  }
  writeLine("ok router authentication is active");
}

interface RunInstallPaths {
  repositoryRoot: string;
  home: string;
  codexHome: string;
  hooks: string;
  userSkills: string;
  rules: string;
  agents: string;
  prompts: string;
}

function resolveRunInstallPaths(
  overrides: InstallCheckOptions
): RunInstallPaths {
  const repositoryRoot = sourceRoot(overrides);
  const home = overrides.home ?? process.env.HOME ?? homedir();
  const codexHome =
    overrides.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex");
  return {
    repositoryRoot,
    home,
    codexHome,
    hooks: path.join(codexHome, "hooks"),
    userSkills: path.join(home, ".agents", "skills"),
    rules: path.join(codexHome, "rules"),
    agents: path.join(codexHome, "agents"),
    prompts: path.join(codexHome, "prompts")
  };
}

function checkRulesAndSkills(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  for (const name of RULES)
    check(
      `rule link ${name}`,
      runtimeLinkMatches(
        path.join(paths.repositoryRoot, "agents/rules", name),
        path.join(paths.rules, name)
      ),
      failures
    );
  for (const name of SKILLS)
    check(
      `skill link ${path.join(paths.userSkills, name)}`,
      skillLinkMatches(
        path.join(paths.repositoryRoot, ".rulesync/skills", name),
        path.join(paths.userSkills, name)
      ),
      failures
    );
}

function checkRuntimeAndOt(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  for (const filePath of RUNTIME_MODULES) {
    check(
      `runtime ${filePath}`,
      runtimeFileMatches(
        path.join(paths.repositoryRoot, filePath),
        runtimeTarget(filePath, paths.codexHome, paths.hooks)
      ),
      failures
    );
    check(
      `tracked source ${filePath}`,
      tracked(paths.repositoryRoot, path.join(paths.repositoryRoot, filePath)),
      failures
    );
  }
  for (const filePath of OTEL_RUNTIME)
    check(
      `Collector runtime ${filePath}`,
      runtimeFileMatches(
        path.join(paths.repositoryRoot, filePath),
        path.join(paths.hooks, filePath.slice(8))
      ),
      failures
    );
  for (const role of PROMPT_ROLES)
    check(
      `prompt role ${role}`,
      runtimeFileMatches(
        path.join(paths.repositoryRoot, `agents/prompts/roles/${role}.md`),
        runtimeTarget(
          `agents/prompts/roles/${role}.md`,
          paths.codexHome,
          paths.hooks
        )
      ),
      failures
    );
}

function checkCommands(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  const rulesyncBin = path.join(
    paths.repositoryRoot,
    "node_modules",
    ".bin",
    "rulesync"
  );
  const rendered = mkdtempSync(path.join(tmpdir(), "autodev-check-prompts-"));
  try {
    execFileSync(
      rulesyncBin,
      [
        "generate",
        "--global",
        "--input-roots",
        path.join(paths.repositoryRoot, ".rulesync"),
        "--targets",
        "codexcli",
        "--features",
        "commands",
        "--silent"
      ],
      {
        cwd: paths.repositoryRoot,
        env: { ...process.env, HOME: rendered },
        stdio: "ignore"
      }
    );
    const projectedDir = path.join(rendered, ".codex", "prompts");
    const projectedFiles = readdirSync(projectedDir)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    const catalog = new Set<string>(COMMANDS);
    for (const name of COMMANDS) {
      const installedPath = path.join(paths.prompts, `${name}.md`);
      const projectedPath = path.join(projectedDir, `${name}.md`);
      let match = false;
      try {
        const stat = lstatSync(installedPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          match = readFileSync(installedPath).equals(
            readFileSync(projectedPath)
          );
        }
      } catch {
        /* not installed */
      }
      check(`prompt ${name}`, match, failures);
    }
    const extraProjected = projectedFiles
      .map((entry) => entry.replace(MD_EXTENSION_PATTERN, ""))
      .find((name) => !catalog.has(name));
    if (extraProjected !== undefined) {
      writeLine(
        `missing-or-drifted rulesync produced prompt "${extraProjected}" that is not in the COMMANDS catalog`
      );
      failures.value = 1;
    }
    if (existsSync(paths.prompts)) {
      for (const entry of readdirSync(paths.prompts)) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.replace(MD_EXTENSION_PATTERN, "");
        if (!catalog.has(name)) {
          writeLine(`obsolete-runtime-path ${path.join(paths.prompts, entry)}`);
          failures.value = 1;
        }
      }
    }
  } catch (error) {
    writeLine(
      `missing-or-drifted commands check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    failures.value = 1;
  } finally {
    rmSync(rendered, { recursive: true, force: true });
  }
}

function checkScripts(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  for (const name of MCP_LAUNCHERS)
    check(
      `MCP launcher ${name}`,
      runtimeLinkMatches(
        path.join(paths.repositoryRoot, `scripts/${name}`),
        path.join(paths.hooks, name)
      ),
      failures
    );
  for (const name of HOOKS)
    check(
      `hook ${name}`,
      runtimeFileMatches(
        path.join(paths.repositoryRoot, `scripts/${name}`),
        path.join(paths.hooks, name)
      ),
      failures
    );
  for (const name of DASHBOARD)
    check(
      `dashboard ${name}`,
      runtimeFileMatches(
        path.join(paths.repositoryRoot, `scripts/${name}`),
        path.join(paths.hooks, name)
      ),
      failures
    );
}

function checkProfilesAndCatalogs(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  for (const name of PROFILES)
    check(
      `profile ${name}`,
      runtimeLinkMatches(
        path.join(paths.repositoryRoot, `config/profiles/${name}.config.toml`),
        path.join(paths.codexHome, `${name}.config.toml`)
      ),
      failures
    );
  for (const name of CATALOGS)
    check(
      `catalog ${name}`,
      runtimeLinkMatches(
        path.join(
          paths.repositoryRoot,
          `config/catalogs/${name}-model-catalog.json`
        ),
        path.join(paths.codexHome, `${name}-model-catalog.json`)
      ),
      failures
    );
  check(
    "model routing",
    runtimeLinkMatches(
      path.join(paths.repositoryRoot, "config/model-routing.json"),
      path.join(paths.codexHome, "codex-model-routing.json")
    ),
    failures
  );
  check(
    "Codex hooks.json",
    runtimeLinkMatches(
      path.join(paths.repositoryRoot, ".codex/hooks.json"),
      path.join(paths.codexHome, "hooks.json")
    ),
    failures
  );
}

function checkPortableConfig(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  check(
    "hook trust state",
    checkHookTrust(
      path.join(paths.codexHome, "config.toml"),
      paths.codexHome,
      paths.repositoryRoot
    ),
    failures
  );
  const portable = readFileSync(
    path.join(paths.repositoryRoot, "config/config.autodev.toml"),
    "utf8"
  );
  for (const provider of [
    "local_model_router",
    "claude_code_subscription",
    "minimax",
    "antigravity_cli"
  ])
    check(
      `provider config ${provider}`,
      portable.includes(`[model_providers.${provider}]`),
      failures
    );
  check(
    "provider auth boundary",
    portable.includes("requires_openai_auth = false"),
    failures
  );
}

function checkUserConfigAndAgents(
  paths: RunInstallPaths,
  projection: ReturnType<typeof createCodexMcpSource>,
  mode: string,
  failures: { value: number }
): void {
  check(
    "user config",
    runCompose(
      path.join(paths.repositoryRoot, "config/config.autodev.toml"),
      projection.source,
      path.join(paths.codexHome, "config.toml"),
      path.join(paths.codexHome, "config.toml"),
      true,
      mode
    ) === 0,
    failures
  );
  const rendered = mkdtempSync(path.join(tmpdir(), "autodev-check-agents-"));
  try {
    renderAgentDirectory(
      path.join(paths.repositoryRoot, "agents/roles"),
      path.join(paths.repositoryRoot, "agents/prompts"),
      rendered,
      projection.source
    );
    for (const role of ROLES)
      check(
        `agent ${role}`,
        runtimeFileMatches(
          path.join(rendered, `${role}.toml`),
          path.join(paths.agents, `${role}.toml`)
        ),
        failures
      );
  } finally {
    rmSync(rendered, { recursive: true, force: true });
  }
  const expectedContract = `${JSON.stringify(renderExecutionContract(path.join(paths.repositoryRoot, "agents/roles"), projection.source, path.join(paths.repositoryRoot, "config/execution-contract.json")), null, 2)}\n`;
  check(
    "execution contract",
    existsSync(
      path.join(paths.repositoryRoot, "config/execution-contract.json")
    ) &&
      readFileSync(
        path.join(paths.repositoryRoot, "config/execution-contract.json"),
        "utf8"
      ) === expectedContract,
    failures
  );
  check(
    "bridge MCP catalogue",
    runBridgeMcpCatalogue(
      projection.source,
      path.join(paths.codexHome, "provider-runtime", "mcp-servers.json"),
      true
    ) === 0,
    failures
  );
  check(
    "codex model catalog",
    runModelCatalog(
      path.join(paths.repositoryRoot, "config/model-routing.json"),
      path.join(paths.repositoryRoot, "config/catalogs"),
      path.join(
        paths.repositoryRoot,
        "config/catalogs/codex-model-catalog.json"
      ),
      true
    ) === 0,
    failures
  );
}

function checkRulesync(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  try {
    execFileSync(
      path.join(paths.repositoryRoot, "node_modules/.bin/rulesync"),
      [
        "generate",
        "--config",
        path.join(paths.repositoryRoot, "rulesync.jsonc"),
        "--check",
        "--silent"
      ],
      { cwd: paths.repositoryRoot, stdio: "ignore" }
    );
    writeLine(
      `ok repository outputs generated by ${paths.repositoryRoot}/rulesync.jsonc`
    );
  } catch {
    writeLine(
      `missing-or-drifted repository outputs generated by ${paths.repositoryRoot}/rulesync.jsonc`
    );
    failures.value = 1;
  }
  const userTargets = [
    ["claude", "claudecode"],
    ["copilot", "copilotcli"],
    ["agy", "antigravity-cli"] as const
  ]
    .filter(([command]) => commandAvailable(command))
    .map(([, target]) => target)
    .join(",");
  if (!userTargets) return;
  try {
    execFileSync(
      path.join(paths.repositoryRoot, "node_modules/.bin/rulesync"),
      [
        "generate",
        "--global",
        "--input-roots",
        path.join(paths.repositoryRoot, ".rulesync"),
        "--targets",
        userTargets,
        "--features",
        "mcp",
        "--check",
        "--silent"
      ],
      { cwd: paths.repositoryRoot, stdio: "ignore" }
    );
    writeLine(
      `ok user-level MCP (${userTargets}) generated from ${paths.repositoryRoot}/.rulesync/mcp.jsonc`
    );
  } catch {
    writeLine(`missing-or-drifted user-level MCP (${userTargets})`);
    failures.value = 1;
  }
}

function checkCollector(
  paths: RunInstallPaths,
  mode: string,
  failures: { value: number }
): void {
  check(
    `Collector mode ${mode}`,
    mode === "direct" || mode === "collector",
    failures
  );
  const collector = resolveCollectorOptions({
    ...process.env,
    AUTODEV_OTEL_REPO_ROOT: paths.repositoryRoot,
    CODEX_HOME: paths.codexHome
  });
  if (mode === "collector") {
    try {
      check(
        "Collector binary/config",
        runCollector(collector, true) === 0,
        failures
      );
    } catch {
      writeLine("missing-or-drifted Collector binary/config");
      failures.value = 1;
    }
  } else
    writeLine(
      "ok OpenTelemetry Collector is disabled (direct OTLP ingress on 127.0.0.1:4100)"
    );
}

function checkObsoleteSkillPaths(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  for (const skill of SKILLS) {
    for (const legacy of ["skills", "agents/skills"]) {
      const filePath = path.join(paths.codexHome, legacy, skill);
      check(`obsolete skill path ${filePath}`, !lstatSafe(filePath), failures);
    }
  }
}

function checkAntigravityCli(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  if (!commandAvailable("agy") || process.env.AUTODEV_SKIP_AGY_MCP === "1")
    return;
  const home = paths.home;
  const settingsPath = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "settings.json"
  );
  const readRoots = process.env.AUTODEV_AGY_READ_ROOTS?.split(":").filter(
    Boolean
  ) ?? [paths.repositoryRoot];
  if (existsSync(settingsPath)) {
    const missing = missingAntigravityPermissions(
      settingsPath,
      readRoots,
      home
    );
    if (missing.length > 0) {
      writeLine(
        `missing Antigravity CLI permission grants: ${missing.join(", ")}`
      );
      failures.value = 1;
    } else
      writeLine("ok Antigravity CLI permission grants (MCP and read_file)");
  } else {
    writeLine(`missing Antigravity CLI permission settings ${settingsPath}`);
    failures.value = 1;
  }
  const skillsPath = path.join(home, ".gemini", "config", "skills.json");
  const skillStatus = existsSync(skillsPath)
    ? antigravitySkillsStatus(
        skillsPath,
        path.join(paths.repositoryRoot, ".rulesync", "skills"),
        [
          path.join(paths.repositoryRoot, "agents/skills"),
          path.join(paths.repositoryRoot, "scripts/codex/skills")
        ]
      )
    : { missing: true, stale: [] };
  check(
    "Antigravity skills",
    !skillStatus.missing && skillStatus.stale.length === 0,
    failures
  );
}

function checkGitExcludes(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  try {
    const exclude = execFileSync(
      "git",
      [
        "-C",
        paths.repositoryRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/exclude"
      ],
      { encoding: "utf8" }
    ).trim();
    const content = readFileSync(exclude, "utf8");
    for (const entry of [
      "/.agents/skills/",
      "/.codex/hooks.json",
      "/.claude/settings.json",
      "/.github/hooks/",
      "/.agents/hooks.json"
    ])
      check(
        `git exclude ${entry}`,
        content.split(LINE_SPLIT_PATTERN).includes(entry),
        failures
      );
  } catch {
    check("git excludes", false, failures);
  }
}

function checkGlobalExcludes(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  try {
    let globalExcludes = "";
    try {
      globalExcludes = execFileSync(
        "git",
        ["config", "--global", "--get", "core.excludesFile"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
    } catch {
      globalExcludes = "";
    }
    if (!globalExcludes) {
      globalExcludes = path.join(paths.home, ".gitignore_global");
    } else if (globalExcludes.startsWith("~")) {
      globalExcludes = path.join(paths.home, globalExcludes.slice(1));
    }
    if (lstatSafe(globalExcludes)) {
      const content = readFileSync(globalExcludes, "utf8");
      const lines = new Set(content.split(LINE_SPLIT_PATTERN));
      const required = [
        ".codegraphcontext/",
        ".repomix/",
        "repomix-output.*",
        ".cocoindex_code/",
        ".agent-cache/"
      ];
      check(
        "global git excludes file",
        required.every((p) => lines.has(p)),
        failures
      );
    } else {
      check("global git excludes file", false, failures);
    }
  } catch {
    check("global git excludes file", false, failures);
  }

  try {
    const xdgConfig =
      process.env.XDG_CONFIG_HOME || path.join(paths.home, ".config");
    const repomixConfig = path.join(
      xdgConfig,
      "repomix",
      "repomix.config.json"
    );
    if (lstatSafe(repomixConfig)) {
      const parsed = JSON.parse(readFileSync(repomixConfig, "utf8"));
      const ok =
        parsed?.ignore?.useGitignore === true &&
        Array.isArray(parsed?.ignore?.customPatterns) &&
        parsed.ignore.customPatterns.includes("**/.codegraphcontext/**");
      check("global Repomix configuration", ok, failures);
    } else {
      check("global Repomix configuration", false, failures);
    }
  } catch {
    check("global Repomix configuration", false, failures);
  }

  try {
    const cgcDir = path.join(paths.home, ".codegraphcontext");
    const cgcEnv = path.join(cgcDir, ".env");
    const cgcIgnore = path.join(cgcDir, ".cgcignore");
    const envOk =
      lstatSafe(cgcEnv) && readFileSync(cgcEnv, "utf8").includes("repomix");
    const ignoreOk =
      lstatSafe(cgcIgnore) &&
      readFileSync(cgcIgnore, "utf8").includes("repomix-output.*");
    check("global CodeGraphContext configuration", envOk && ignoreOk, failures);
  } catch {
    check("global CodeGraphContext configuration", false, failures);
  }

  try {
    const bootstrapBin = path.join(
      paths.home,
      ".local",
      "bin",
      "autodev-bootstrap"
    );
    check("autodev-bootstrap executable", lstatSafe(bootstrapBin), failures);
  } catch {
    check("autodev-bootstrap executable", false, failures);
  }
}

function checkDependencies(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  if (checkCocoIndex(resolveDependencyOptions(process.env)) !== 0)
    failures.value = 1;
  if (checkCodeGraphContext(resolveDependencyOptions(process.env)) !== 0)
    failures.value = 1;
  if (checkPythonLanguageServer(resolveDependencyOptions(process.env)) !== 0)
    failures.value = 1;
}

function checkLaunchAgents(
  paths: RunInstallPaths,
  failures: { value: number }
): void {
  for (const label of LAUNCH_LABELS)
    check(
      `LaunchAgent ${label}`,
      launchAgentMatches(
        path.join(paths.repositoryRoot, `config/launchagents/${label}.plist`),
        path.join(paths.home, "Library/LaunchAgents", `${label}.plist`),
        {
          codexHome: paths.codexHome,
          home: paths.home,
          repositoryRoot: paths.repositoryRoot,
          nodeBin: resolveServiceNode(paths.home)
        }
      ),
      failures
    );
}

export function runInstallCheck(overrides: InstallCheckOptions = {}): number {
  const paths = resolveRunInstallPaths(overrides);
  const failures = { value: 0 };
  const mode = readCollectorMode(
    path.join(paths.codexHome, "otel-collector.mode")
  );
  const projection = createCodexMcpSource(paths.repositoryRoot);
  try {
    checkRulesAndSkills(paths, failures);
    checkRuntimeAndOt(paths, failures);
    checkCommands(paths, failures);
    checkScripts(paths, failures);
    checkProfilesAndCatalogs(paths, failures);
    checkPortableConfig(paths, failures);
    checkUserConfigAndAgents(paths, projection, mode, failures);
    checkRulesync(paths, failures);
    checkCollector(paths, mode, failures);
    checkObsoleteSkillPaths(paths, failures);
    checkAntigravityCli(paths, failures);
    checkGitExcludes(paths, failures);
    checkGlobalExcludes(paths, failures);
    checkDependencies(paths, failures);
    checkAuth({ codexHome: paths.codexHome }, failures);
    staleCheck(
      {
        repositoryRoot: paths.repositoryRoot,
        home: paths.home,
        codexHome: paths.codexHome
      },
      failures
    );
    checkLaunchAgents(paths, failures);
    return failures.value;
  } finally {
    rmSync(projection.root, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = runInstallCheck();
  } catch (error) {
    writeErrorLine(
      `install-check: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
