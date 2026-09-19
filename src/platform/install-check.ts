import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { runCompose } from "../config/compose-user-config.ts";
import { renderAgentDirectory } from "../config/render-agent-configs.ts";
import { runBridgeMcpCatalogue } from "../config/render-bridge-mcp-catalogue.ts";
import { renderExecutionContract } from "../config/render-execution-contract.ts";
import { writeErrorLine, writeLine } from "../shared/output.ts";
import {
  antigravitySkillsStatus,
  missingAntigravityPermissions
} from "./antigravity-settings.ts";
import {
  checkCocoIndex,
  checkPythonLanguageServer,
  resolveDependencyOptions
} from "./dependencies.ts";
import { createCodexMcpSource } from "./install-command.ts";
import {
  CATALOGS,
  checkHookTrust,
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
      .split(/\r?\n/u)
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
      .match(/^CODEX_ROUTER_AUTH_TOKEN=([^\n]*)$/mu)?.[1]
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
        .split(/\s+/u)
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

export function runInstallCheck(overrides: InstallCheckOptions = {}): number {
  const repositoryRoot = sourceRoot(overrides),
    home = overrides.home ?? process.env.HOME ?? homedir(),
    codexHome =
      overrides.codexHome ??
      process.env.CODEX_HOME ??
      path.join(home, ".codex");
  const hooks = path.join(codexHome, "hooks"),
    userSkills = path.join(home, ".agents", "skills"),
    rules = path.join(codexHome, "rules"),
    agents = path.join(codexHome, "agents");
  const failures = { value: 0 };
  const mode = readCollectorMode(path.join(codexHome, "otel-collector.mode"));
  const projection = createCodexMcpSource(repositoryRoot);
  try {
    for (const name of RULES)
      check(
        `rule link ${name}`,
        runtimeLinkMatches(
          path.join(repositoryRoot, "agents/rules", name),
          path.join(rules, name)
        ),
        failures
      );
    for (const name of SKILLS)
      check(
        `skill link ${path.join(userSkills, name)}`,
        skillLinkMatches(
          path.join(repositoryRoot, ".rulesync/skills", name),
          path.join(userSkills, name)
        ),
        failures
      );
    for (const filePath of RUNTIME_MODULES) {
      check(
        `runtime ${filePath}`,
        runtimeFileMatches(
          path.join(repositoryRoot, filePath),
          runtimeTarget(filePath, codexHome, hooks)
        ),
        failures
      );
      check(
        `tracked source ${filePath}`,
        tracked(repositoryRoot, path.join(repositoryRoot, filePath)),
        failures
      );
    }
    for (const filePath of OTEL_RUNTIME)
      check(
        `Collector runtime ${filePath}`,
        runtimeFileMatches(
          path.join(repositoryRoot, filePath),
          path.join(hooks, filePath.slice(8))
        ),
        failures
      );
    for (const role of PROMPT_ROLES)
      check(
        `prompt role ${role}`,
        runtimeFileMatches(
          path.join(repositoryRoot, `agents/prompts/roles/${role}.md`),
          runtimeTarget(`agents/prompts/roles/${role}.md`, codexHome, hooks)
        ),
        failures
      );
    for (const name of MCP_LAUNCHERS)
      check(
        `MCP launcher ${name}`,
        runtimeLinkMatches(
          path.join(repositoryRoot, `scripts/${name}`),
          path.join(hooks, name)
        ),
        failures
      );
    for (const name of HOOKS)
      check(
        `hook ${name}`,
        runtimeFileMatches(
          path.join(repositoryRoot, `scripts/${name}`),
          path.join(hooks, name)
        ),
        failures
      );
    for (const name of DASHBOARD)
      check(
        `dashboard ${name}`,
        runtimeFileMatches(
          path.join(repositoryRoot, `scripts/${name}`),
          path.join(hooks, name)
        ),
        failures
      );
    for (const name of PROFILES)
      check(
        `profile ${name}`,
        runtimeLinkMatches(
          path.join(repositoryRoot, `config/profiles/${name}.config.toml`),
          path.join(codexHome, `${name}.config.toml`)
        ),
        failures
      );
    for (const name of CATALOGS)
      check(
        `catalog ${name}`,
        runtimeLinkMatches(
          path.join(
            repositoryRoot,
            `config/catalogs/${name}-model-catalog.json`
          ),
          path.join(codexHome, `${name}-model-catalog.json`)
        ),
        failures
      );
    check(
      "model routing",
      runtimeLinkMatches(
        path.join(repositoryRoot, "config/model-routing.json"),
        path.join(codexHome, "codex-model-routing.json")
      ),
      failures
    );
    check(
      "Codex hooks.json",
      runtimeLinkMatches(
        path.join(repositoryRoot, ".codex/hooks.json"),
        path.join(codexHome, "hooks.json")
      ),
      failures
    );
    check(
      "hook trust state",
      checkHookTrust(
        path.join(codexHome, "config.toml"),
        codexHome,
        repositoryRoot
      ),
      failures
    );
    const portable = readFileSync(
      path.join(repositoryRoot, "config/config.autodev.toml"),
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
    check(
      "user config",
      runCompose(
        path.join(repositoryRoot, "config/config.autodev.toml"),
        projection.source,
        path.join(codexHome, "config.toml"),
        path.join(codexHome, "config.toml"),
        true,
        mode
      ) === 0,
      failures
    );
    const rendered = mkdtempSync(path.join(tmpdir(), "autodev-check-agents-"));
    try {
      renderAgentDirectory(
        path.join(repositoryRoot, "agents/roles"),
        path.join(repositoryRoot, "agents/prompts"),
        rendered,
        projection.source
      );
      for (const role of ROLES)
        check(
          `agent ${role}`,
          runtimeFileMatches(
            path.join(rendered, `${role}.toml`),
            path.join(agents, `${role}.toml`)
          ),
          failures
        );
    } finally {
      rmSync(rendered, { recursive: true, force: true });
    }
    const expectedContract = `${JSON.stringify(renderExecutionContract(path.join(repositoryRoot, "agents/roles"), projection.source, path.join(repositoryRoot, "config/execution-contract.json")), null, 2)}\n`;
    check(
      "execution contract",
      existsSync(path.join(repositoryRoot, "config/execution-contract.json")) &&
        readFileSync(
          path.join(repositoryRoot, "config/execution-contract.json"),
          "utf8"
        ) === expectedContract,
      failures
    );
    check(
      "bridge MCP catalogue",
      runBridgeMcpCatalogue(
        projection.source,
        path.join(codexHome, "provider-runtime", "mcp-servers.json"),
        true
      ) === 0,
      failures
    );
    try {
      execFileSync(
        path.join(repositoryRoot, "node_modules/.bin/rulesync"),
        [
          "generate",
          "--config",
          path.join(repositoryRoot, "rulesync.jsonc"),
          "--check",
          "--silent"
        ],
        { cwd: repositoryRoot, stdio: "ignore" }
      );
      writeLine(
        `ok repository outputs generated by ${repositoryRoot}/rulesync.jsonc`
      );
    } catch {
      writeLine(
        `missing-or-drifted repository outputs generated by ${repositoryRoot}/rulesync.jsonc`
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
    if (userTargets) {
      try {
        execFileSync(
          path.join(repositoryRoot, "node_modules/.bin/rulesync"),
          [
            "generate",
            "--global",
            "--input-roots",
            path.join(repositoryRoot, ".rulesync"),
            "--targets",
            userTargets,
            "--features",
            "mcp",
            "--check",
            "--silent"
          ],
          { cwd: repositoryRoot, stdio: "ignore" }
        );
        writeLine(
          `ok user-level MCP (${userTargets}) generated from ${repositoryRoot}/.rulesync/mcp.jsonc`
        );
      } catch {
        writeLine(`missing-or-drifted user-level MCP (${userTargets})`);
        failures.value = 1;
      }
    }
    check(
      `Collector mode ${mode}`,
      mode === "direct" || mode === "collector",
      failures
    );
    const collector = resolveCollectorOptions({
      ...process.env,
      AUTODEV_OTEL_REPO_ROOT: repositoryRoot,
      CODEX_HOME: codexHome
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
    for (const skill of SKILLS) {
      for (const legacy of ["skills", "agents/skills"]) {
        const filePath = path.join(codexHome, legacy, skill);
        check(
          `obsolete skill path ${filePath}`,
          !lstatSafe(filePath),
          failures
        );
      }
    }
    if (commandAvailable("agy") && process.env.AUTODEV_SKIP_AGY_MCP !== "1") {
      const settingsPath = path.join(
        home,
        ".gemini",
        "antigravity-cli",
        "settings.json"
      );
      const readRoots = process.env.AUTODEV_AGY_READ_ROOTS?.split(":").filter(
        Boolean
      ) ?? [repositoryRoot];
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
        writeLine(
          `missing Antigravity CLI permission settings ${settingsPath}`
        );
        failures.value = 1;
      }
      const skillsPath = path.join(home, ".gemini", "config", "skills.json");
      const skillStatus = existsSync(skillsPath)
        ? antigravitySkillsStatus(
            skillsPath,
            path.join(repositoryRoot, ".rulesync", "skills"),
            [
              path.join(repositoryRoot, "agents/skills"),
              path.join(repositoryRoot, "scripts/codex/skills")
            ]
          )
        : { missing: true, stale: [] };
      check(
        "Antigravity skills",
        !skillStatus.missing && skillStatus.stale.length === 0,
        failures
      );
    }
    try {
      const exclude = execFileSync(
        "git",
        [
          "-C",
          repositoryRoot,
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
          content.split(/\r?\n/u).includes(entry),
          failures
        );
    } catch {
      check("git excludes", false, failures);
    }
    if (checkCocoIndex(resolveDependencyOptions(process.env)) !== 0)
      failures.value = 1;
    if (checkPythonLanguageServer(resolveDependencyOptions(process.env)) !== 0)
      failures.value = 1;
    checkAuth({ codexHome }, failures);
    staleCheck({ repositoryRoot, home, codexHome }, failures);
    for (const label of LAUNCH_LABELS)
      check(
        `LaunchAgent ${label}`,
        launchAgentMatches(
          path.join(repositoryRoot, `config/launchagents/${label}.plist`),
          path.join(home, "Library/LaunchAgents", `${label}.plist`),
          { codexHome, home, repositoryRoot }
        ),
        failures
      );
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
